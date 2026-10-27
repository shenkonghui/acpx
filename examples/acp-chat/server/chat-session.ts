import { createHash } from "node:crypto";
import path from "node:path";
import { splitCommandLine } from "../../../src/acp/client-process.js";
import {
  normalizeAgentName,
  type AcpInspectableAgentRegistry,
} from "../../../src/agent-registry.js";
import {
  createAcpRuntime,
  createFileSessionStore,
  type AcpRuntime,
  type AcpRuntimeEvent,
  type AcpRuntimeHandle,
  type AcpRuntimeTurn,
} from "../../../src/runtime.js";
import { resolveInstalledExecutable } from "../../../src/spawn-command-options.js";
import type { PermissionMode } from "../../../src/types.js";
import type { ChatErrorCode, ChatServerMessage, SessionModels } from "./chat-protocol.js";
import type { LiveAgentRegistry } from "./live-registry.js";
import { readEnabledModels } from "./settings.js";

export type ChatSessionManagerOptions = {
  cwd: string;
  stateDir: string;
  permissionMode: PermissionMode;
  /** Live registry holding built-ins, config overrides, and ad-hoc commands. */
  registry: LiveAgentRegistry;
  /** Set false to reject ad-hoc command sessions (default enabled). */
  allowCommand?: boolean;
  verbose?: boolean;
};

export type OpenSessionInput = {
  chatId: string;
  agent: string;
  cwd?: string;
  model?: string;
  permissionMode?: PermissionMode;
};

export type OpenCommandInput = {
  chatId: string;
  command: string;
  cwd?: string;
  permissionMode?: PermissionMode;
};

export type OpenSessionResult = {
  sessionKey: string;
  agent: string;
  cwd: string;
  permissionMode: PermissionMode;
  model?: string;
  models?: SessionModels;
};

export type SendTurnInput = {
  chatId: string;
  text: string;
  requestId: string;
};

type ChatSession = {
  chatId: string;
  agent: string;
  cwd: string;
  sessionKey: string;
  handle: AcpRuntimeHandle;
  /** The runtime instance that owns this session (one per permission mode). */
  runtime: AcpRuntime;
  permissionMode: PermissionMode;
  activeTurn?: AcpRuntimeTurn;
  /** Last model selected through the page or advertised by the agent. */
  model?: string;
  models?: SessionModels;
  /** Ad-hoc command sessions register a temporary synthetic agent name. */
  adHoc?: boolean;
};

export type ChatRuntimeFactory = (options: {
  cwd: string;
  stateDir: string;
  permissionMode: PermissionMode;
  agentRegistry: AcpInspectableAgentRegistry;
  verbose: boolean;
}) => AcpRuntime;

const runtimeFactory: ChatRuntimeFactory = (options) =>
  createAcpRuntime({
    cwd: options.cwd,
    sessionStore: createFileSessionStore({ stateDir: options.stateDir }),
    agentRegistry: options.agentRegistry,
    permissionMode: options.permissionMode,
    nonInteractivePermissions: "deny",
    verbose: options.verbose,
  });

/** How long an opened session keeps watching for late gateway model discovery. */
const MODEL_DISCOVERY_TIMEOUT_MS = 10_000;
const MODEL_DISCOVERY_POLL_INTERVAL_MS = 250;

function modelCount(models: SessionModels | undefined): number {
  return models?.availableModels?.length ?? models?.availableModelIds.length ?? 0;
}

/** Wraps `AcpxRuntime` behind the browser chat protocol (one session per chat id). */
export class ChatSessionManager {
  /** One runtime per permission mode, created lazily on first use. */
  private readonly runtimes = new Map<PermissionMode, AcpRuntime>();
  private readonly sessions = new Map<string, ChatSession>();
  private readonly emitters = new Map<string, (message: ChatServerMessage) => void>();
  private readonly createRuntime: ChatRuntimeFactory;
  private closed = false;

  constructor(
    private readonly options: ChatSessionManagerOptions,
    createRuntime: ChatRuntimeFactory = runtimeFactory,
  ) {
    this.createRuntime = createRuntime;
  }

  private runtimeFor(mode: PermissionMode): AcpRuntime {
    let runtime = this.runtimes.get(mode);
    if (!runtime) {
      runtime = this.createRuntime({
        cwd: this.options.cwd,
        stateDir: this.options.stateDir,
        permissionMode: mode,
        agentRegistry: this.options.registry,
        verbose: this.options.verbose === true,
      });
      this.runtimes.set(mode, runtime);
    }
    return runtime;
  }

  attach(chatId: string, emit: (message: ChatServerMessage) => void): void {
    this.emitters.set(chatId, emit);
  }

  detach(chatId: string): void {
    this.emitters.delete(chatId);
  }

  async openSession(input: OpenSessionInput): Promise<OpenSessionResult | undefined> {
    if (!this.options.registry.has(input.agent)) {
      this.emitError(input.chatId, "agent_not_found", `Unknown agent: ${input.agent}`);
      return undefined;
    }
    return await this.openResolvedSession(
      input.chatId,
      input.agent,
      input.cwd,
      false,
      input.model,
      input.permissionMode,
    );
  }

  /**
   * Runs an arbitrary command as a temporary agent, mirroring the CLI `--agent` escape
   * hatch. The command must resolve on PATH; it is registered under a synthetic,
   * per-chat agent name that is removed when the chat closes.
   */
  async openCommandSession(input: OpenCommandInput): Promise<OpenSessionResult | undefined> {
    if (this.options.allowCommand === false) {
      this.emitError(
        input.chatId,
        "command_disabled",
        "Custom commands are disabled (--no-command)",
      );
      return undefined;
    }
    let parsed: { command: string; args: string[] };
    try {
      parsed = splitCommandLine(input.command.trim());
    } catch (error) {
      this.emitError(input.chatId, "command_not_found", errorMessage(error));
      return undefined;
    }
    const executable = resolveInstalledExecutable(parsed.command);
    if (!executable) {
      this.emitError(
        input.chatId,
        "command_not_found",
        `Command not found on PATH: ${parsed.command}`,
      );
      return undefined;
    }

    const agent = adHocAgentName(input.chatId);
    this.options.registry.registerAdHoc(agent, [executable, ...parsed.args]);
    const opened = await this.openResolvedSession(
      input.chatId,
      agent,
      input.cwd,
      true,
      undefined,
      input.permissionMode,
    );
    if (!opened) {
      this.options.registry.removeAdHoc(agent);
    }
    return opened;
  }

  private async openResolvedSession(
    chatId: string,
    agent: string,
    requestedCwd: string | undefined,
    adHoc = false,
    model?: string,
    permissionMode?: PermissionMode,
  ): Promise<OpenSessionResult | undefined> {
    const cwd = path.resolve(requestedCwd?.trim() || this.options.cwd);
    const normalized = normalizeAgentName(agent);
    const mode = permissionMode ?? this.options.permissionMode;
    const runtime = this.runtimeFor(mode);

    const existing = this.sessions.get(chatId);
    if (existing) {
      if (existing.activeTurn) {
        this.emitError(chatId, "session_error", "Cannot switch session while a turn is running");
        return undefined;
      }
      if (
        normalizeAgentName(existing.agent) === normalized &&
        existing.cwd === cwd &&
        existing.permissionMode === mode
      ) {
        // Re-read the model list so config-side enabledModels changes are
        // reflected without restarting the session.
        await this.refreshSessionModels(existing);
        return this.describe(existing);
      }
      // Agent, cwd, or permission mode changed: drop the previous runtime
      // session so the new one actually starts under the requested mode.
      await existing.runtime
        .close({ handle: existing.handle, reason: "chat_closed" })
        .catch((error: unknown) => {
          this.log(`close on switch failed: ${errorMessage(error)}`);
        });
      if (existing.adHoc) {
        this.options.registry.removeAdHoc(existing.agent);
      }
    }

    // The key carries the mode so a runtime never reattaches to a session that
    // was created under a different permission mode.
    const sessionKey = `agent:${agent}:web:${chatId}:${mode}`;
    const env = this.options.registry.resolveEnv(agent);
    try {
      const handle =
        (await runtime.findSession?.({ sessionKey, agent })) ??
        (await runtime.ensureSession({
          sessionKey,
          agent,
          mode: "persistent",
          cwd,
          ...(env ? { sessionOptions: { env } } : {}),
        }));
      const session: ChatSession = {
        chatId,
        agent,
        cwd,
        sessionKey,
        handle,
        runtime,
        permissionMode: mode,
        ...(adHoc ? { adHoc: true } : {}),
      };
      if (model !== undefined) {
        await this.applyModel(session, model);
      }
      session.models = await this.readModels(session);
      if (session.models?.currentModelId !== undefined) {
        session.model = session.models.currentModelId;
      }
      this.sessions.set(chatId, session);
      if (modelCount(session.models) === 0) {
        void this.refreshModelsAfterDiscovery(session);
      }
      return this.describe(session);
    } catch (error) {
      this.emitError(chatId, "session_error", errorMessage(error));
      return undefined;
    }
  }

  async send(input: SendTurnInput): Promise<void> {
    const session = this.sessions.get(input.chatId);
    if (!session) {
      this.emitError(input.chatId, "session_error", "No open session for this chat");
      return;
    }
    if (session.activeTurn) {
      this.emitError(input.chatId, "turn_in_progress", "A turn is already running");
      return;
    }

    let turn: AcpRuntimeTurn;
    try {
      turn = session.runtime.startTurn({
        handle: session.handle,
        text: input.text,
        mode: "prompt",
        requestId: input.requestId,
      });
    } catch (error) {
      this.emit({
        type: "turn_done",
        chatId: input.chatId,
        requestId: input.requestId,
        status: "failed",
        error: { message: errorMessage(error) },
      });
      return;
    }

    session.activeTurn = turn;
    this.emit({ type: "turn_started", chatId: input.chatId, requestId: input.requestId });

    const streamed = this.forwardEvents(input, turn).catch((error: unknown) => {
      this.log(`event stream failed: ${errorMessage(error)}`);
    });

    try {
      const result = await turn.result;
      await streamed;
      if (result.status === "failed") {
        this.emit({
          type: "turn_done",
          chatId: input.chatId,
          requestId: input.requestId,
          status: "failed",
          error: {
            message: result.error.message,
            ...(result.error.code ? { code: result.error.code } : {}),
          },
        });
        return;
      }
      this.emit({
        type: "turn_done",
        chatId: input.chatId,
        requestId: input.requestId,
        status: result.status,
        ...(result.stopReason ? { stopReason: result.stopReason } : {}),
      });
    } catch (error) {
      this.emit({
        type: "turn_done",
        chatId: input.chatId,
        requestId: input.requestId,
        status: "failed",
        error: { message: errorMessage(error) },
      });
    } finally {
      if (session.activeTurn === turn) {
        delete session.activeTurn;
      }
    }
  }

  async cancel(chatId: string): Promise<void> {
    const turn = this.sessions.get(chatId)?.activeTurn;
    if (!turn) {
      this.emitError(chatId, "session_error", "No active turn to cancel");
      return;
    }
    await turn.cancel({ reason: "user" });
  }

  /** Changes the model of an open session. Rejected while a turn is running. */
  async setModel(chatId: string, model: string): Promise<void> {
    const session = this.sessions.get(chatId);
    if (!session) {
      this.emitError(chatId, "session_error", "No open session for this chat");
      return;
    }
    if (session.activeTurn) {
      this.emitError(chatId, "turn_in_progress", "Cannot change the model while a turn is running");
      return;
    }
    if (!(await this.applyModel(session, model))) {
      return;
    }
    const models = (await this.readModels(session)) ?? {
      currentModelId: model,
      availableModelIds: [],
    };
    session.models = models;
    this.emit({ type: "session_models", chatId, models });
  }

  /**
   * Re-reads and re-broadcasts the model list for every live session using
   * `agent` (e.g. after its `enabledModels` config changed in settings).
   */
  async refreshModelsForAgent(agent: string): Promise<void> {
    const normalized = normalizeAgentName(agent);
    for (const session of this.sessions.values()) {
      if (normalizeAgentName(session.agent) === normalized) {
        await this.refreshSessionModels(session);
      }
    }
  }

  /** Refreshes one session's cached model list and pushes it to the client. */
  private async refreshSessionModels(session: ChatSession): Promise<void> {
    const models = await this.readModels(session);
    if (!models) {
      return;
    }
    session.models = models;
    if (models.currentModelId !== undefined) {
      session.model = models.currentModelId;
    } else if (session.model !== undefined && !models.availableModelIds.includes(session.model)) {
      // The active model was filtered out; let the picker fall back.
      delete session.model;
    }
    this.emit({ type: "session_models", chatId: session.chatId, models });
  }

  /**
   * Gateway sessions answer before their backends finish probing and push the
   * merged model list afterwards, so an empty list at open time can still fill
   * in. Poll for a while and broadcast the models once they land.
   */
  private async refreshModelsAfterDiscovery(session: ChatSession): Promise<void> {
    const deadline = Date.now() + MODEL_DISCOVERY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, MODEL_DISCOVERY_POLL_INTERVAL_MS));
      if (this.sessions.get(session.chatId) !== session) {
        return;
      }
      const models = await this.readModels(session);
      if (models === undefined || modelCount(models) === 0) {
        continue;
      }
      session.models = models;
      if (session.model === undefined && models.currentModelId !== undefined) {
        session.model = models.currentModelId;
      }
      this.emit({ type: "session_models", chatId: session.chatId, models });
      return;
    }
  }

  async closeSession(chatId: string, discard = false): Promise<void> {
    const session = this.sessions.get(chatId);
    if (!session) {
      return;
    }
    this.sessions.delete(chatId);
    if (session.activeTurn) {
      await session.activeTurn.cancel({ reason: "chat_closed" }).catch((error: unknown) => {
        this.log(`cancel on close failed: ${errorMessage(error)}`);
      });
    }
    try {
      await session.runtime.close({
        handle: session.handle,
        reason: "chat_closed",
        ...(discard ? { discardPersistentState: true } : {}),
      });
    } catch (error) {
      this.log(`close failed: ${errorMessage(error)}`);
    }
    if (session.adHoc) {
      this.options.registry.removeAdHoc(session.agent);
    }
    this.emit({ type: "session_closed", chatId });
  }

  async shutdown(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const session of this.sessions.values()) {
      await session.activeTurn?.cancel({ reason: "shutdown" }).catch(() => {});
    }
    this.sessions.clear();
    this.emitters.clear();
    for (const runtime of this.runtimes.values()) {
      await runtime.shutdown?.();
    }
  }

  private describe(session: ChatSession): OpenSessionResult {
    return {
      sessionKey: session.sessionKey,
      agent: session.agent,
      cwd: session.cwd,
      permissionMode: session.permissionMode,
      ...(session.model !== undefined ? { model: session.model } : {}),
      ...(session.models !== undefined ? { models: session.models } : {}),
    };
  }

  /** Applies a model to the runtime; emits `model_unsupported` and returns false on failure. */
  private async applyModel(session: ChatSession, model: string): Promise<boolean> {
    if (!session.runtime.setModel) {
      this.emitError(session.chatId, "model_unsupported", "This runtime cannot change the model");
      return false;
    }
    try {
      await session.runtime.setModel({ handle: session.handle, model });
      session.model = model;
      return true;
    } catch (error) {
      this.emitError(session.chatId, "model_unsupported", errorMessage(error));
      return false;
    }
  }

  private async readModels(session: ChatSession): Promise<SessionModels | undefined> {
    if (!session.runtime.getStatus) {
      return undefined;
    }
    try {
      const status = await session.runtime.getStatus({ handle: session.handle });
      const models = status.models;
      if (!models) {
        return undefined;
      }
      const enabled = await readEnabledModels(session.agent).catch(() => undefined);
      const allowed = enabled && enabled.length > 0 ? new Set(enabled) : undefined;
      const keep = (modelId: string): boolean => allowed === undefined || allowed.has(modelId);
      // Drop currentModelId when the filter removed it so the picker falls
      // back to the first available option instead of showing a blank select.
      const currentKept =
        models.currentModelId !== undefined && keep(models.currentModelId)
          ? { currentModelId: models.currentModelId }
          : {};
      return {
        ...currentKept,
        availableModelIds: models.availableModelIds.filter(keep),
        ...(models.availableModels
          ? {
              availableModels: models.availableModels
                .filter((model) => keep(model.modelId))
                .map((model) => ({
                  modelId: model.modelId,
                  name: model.name,
                })),
            }
          : {}),
      };
    } catch (error) {
      this.log(`getStatus failed: ${errorMessage(error)}`);
      return undefined;
    }
  }

  private async forwardEvents(input: SendTurnInput, turn: AcpRuntimeTurn): Promise<void> {
    for await (const event of turn.events) {
      const message = toServerMessage(input, event);
      if (message) {
        this.emit(message);
      }
    }
  }

  private emit(message: ChatServerMessage): void {
    const chatId = "chatId" in message ? message.chatId : undefined;
    if (chatId === undefined) {
      return;
    }
    this.emitters.get(chatId)?.(message);
  }

  private emitError(chatId: string, code: ChatErrorCode, message: string): void {
    this.emit({ type: "error", chatId, code, message });
  }

  private log(message: string): void {
    if (this.options.verbose) {
      process.stderr.write(`[acpx chat] ${message}\n`);
    }
  }
}

function toServerMessage(
  input: SendTurnInput,
  event: AcpRuntimeEvent,
): ChatServerMessage | undefined {
  switch (event.type) {
    case "text_delta":
      return {
        type: "text_delta",
        chatId: input.chatId,
        requestId: input.requestId,
        text: event.text,
        stream: event.stream === "thought" ? "thought" : "output",
      };
    case "tool_call":
      return {
        type: "tool_call",
        chatId: input.chatId,
        requestId: input.requestId,
        text: event.text,
        ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
        ...(event.status ? { status: event.status } : {}),
        ...(event.title ? { title: event.title } : {}),
        ...(event.kind ? { kind: event.kind } : {}),
        ...(event.rawInput !== undefined ? { rawInput: event.rawInput } : {}),
        ...(event.rawOutput !== undefined ? { rawOutput: event.rawOutput } : {}),
        ...(event.content !== undefined ? { content: event.content } : {}),
      };
    case "status":
      return {
        type: "status",
        chatId: input.chatId,
        requestId: input.requestId,
        text: event.text,
        ...(event.tag ? { tag: event.tag } : {}),
        ...(event.used !== undefined ? { used: event.used } : {}),
        ...(event.size !== undefined ? { size: event.size } : {}),
        ...(event.cost !== undefined ? { cost: event.cost } : {}),
        ...(event.entries !== undefined ? { entries: event.entries } : {}),
        ...(event.availableCommands !== undefined
          ? { availableCommands: event.availableCommands }
          : {}),
      };
    default:
      return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Synthetic, collision-free agent name for a chat's ad-hoc command (no `:` allowed). */
function adHocAgentName(chatId: string): string {
  return `adhoc-${createHash("sha1").update(chatId).digest("hex").slice(0, 8)}`;
}
