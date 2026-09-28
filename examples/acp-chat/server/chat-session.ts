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
import type { ChatErrorCode, ChatServerMessage } from "./chat-protocol.js";
import type { LiveAgentRegistry } from "./live-registry.js";

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
};

export type OpenCommandInput = {
  chatId: string;
  command: string;
  cwd?: string;
};

export type OpenSessionResult = {
  sessionKey: string;
  agent: string;
  cwd: string;
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
  activeTurn?: AcpRuntimeTurn;
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

/** Wraps `AcpxRuntime` behind the browser chat protocol (one session per chat id). */
export class ChatSessionManager {
  private readonly runtime: AcpRuntime;
  private readonly sessions = new Map<string, ChatSession>();
  private readonly emitters = new Map<string, (message: ChatServerMessage) => void>();
  private closed = false;

  constructor(
    private readonly options: ChatSessionManagerOptions,
    createRuntime: ChatRuntimeFactory = runtimeFactory,
  ) {
    this.runtime = createRuntime({
      cwd: options.cwd,
      stateDir: options.stateDir,
      permissionMode: options.permissionMode,
      agentRegistry: options.registry,
      verbose: options.verbose === true,
    });
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
    return await this.openResolvedSession(input.chatId, input.agent, input.cwd);
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
    const opened = await this.openResolvedSession(input.chatId, agent, input.cwd, true);
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
  ): Promise<OpenSessionResult | undefined> {
    const cwd = path.resolve(requestedCwd?.trim() || this.options.cwd);
    const normalized = normalizeAgentName(agent);

    const existing = this.sessions.get(chatId);
    if (existing && normalizeAgentName(existing.agent) === normalized && existing.cwd === cwd) {
      return this.describe(existing);
    }
    if (existing?.activeTurn) {
      this.emitError(chatId, "session_error", "Cannot switch agent while a turn is running");
      return undefined;
    }

    const sessionKey = `agent:${agent}:web:${chatId}`;
    try {
      const handle =
        (await this.runtime.findSession?.({ sessionKey, agent })) ??
        (await this.runtime.ensureSession({
          sessionKey,
          agent,
          mode: "persistent",
          cwd,
        }));
      const session: ChatSession = {
        chatId,
        agent,
        cwd,
        sessionKey,
        handle,
        ...(adHoc ? { adHoc: true } : {}),
      };
      this.sessions.set(chatId, session);
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
      turn = this.runtime.startTurn({
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
      await this.runtime.close({
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
    await this.runtime.shutdown?.();
  }

  private describe(session: ChatSession): OpenSessionResult {
    return { sessionKey: session.sessionKey, agent: session.agent, cwd: session.cwd };
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
