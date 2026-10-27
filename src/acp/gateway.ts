import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import {
  AgentSideConnection,
  type Agent,
  type AgentSideConnection as AgentConnection,
  type CancelNotification,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  ndJsonStream,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  PROTOCOL_VERSION,
  RequestError,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionConfigOption,
  type SessionModeState,
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
} from "@agentclientprotocol/sdk";
import { EXIT_CODES, type AcpProcessExit, type PermissionMode } from "../types.js";
import { AcpClient } from "./client.js";
import type { SessionCreateResult } from "./client.js";
import { classifyAgentFailure, isFailoverEligible } from "./failure-classification.js";
import {
  DEFAULT_HEALTH_CHECK_INTERVAL_MS,
  type FallbackEntry,
  FailoverController,
  type FailoverRestoreMode,
} from "./gateway-failover.js";
import {
  appendNote,
  appendUserMessage,
  createHandoffHistory,
  DEFAULT_HANDOFF_MAX_CHARS,
  DEFAULT_HANDOFF_TURNS,
  type GatewayHandoffOptions,
  type HandoffHistory,
  type HandoffMessage,
  promptText,
  recordDownstreamUpdate,
  renderHandoffPrompt,
} from "./gateway-handoff.js";
import { asRecord } from "./jsonrpc.js";
import {
  type BackendModeSupport,
  buildUnifiedModeOption,
  DEFAULT_UNIFIED_PERMISSION,
  isModeSelectOption,
  isUnifiedPermission,
  resolveBackendModeSupport,
  resolveUnifiedCurrentPermission,
  toBackendModeId,
  toUnifiedPermission,
  UNIFIED_PERMISSION_CONFIG_ID,
  type UnifiedPermission,
} from "./mode-support.js";
import {
  isModelSelectOption,
  modelStateFromSessionResponse,
  RequestedModelUnsupportedError,
  type SessionModelState,
} from "./model-support.js";

const GATEWAY_SESSION_PREFIX = "gw-";
const AGENT_META_KEY = "acpx";
const AGENT_META_AGENT_FIELD = "agent";
const UNIFIED_MODEL_CONFIG_ID = "model";
const UNKNOWN_SESSION_ERROR_CODE = -32602;
const INVALID_PARAMS_ERROR_CODE = -32602;
const METHOD_NOT_FOUND_ERROR_CODE = -32601;

export type GatewayAgentSpec = {
  name: string;
  agentCommand: string;
  agentArgv?: string[];
  env?: Record<string, string>;
  /** Bare model-id allowlist for this backend; absent means every model. */
  enabledModels?: string[];
};

export type RunAcpGatewayOptions = {
  agents: GatewayAgentSpec[];
  /** Agent name used when session/new has no _meta selection; defaults to the first agent. */
  defaultAgent?: string;
  /**
   * Prefixed `<agent>/<model>` allowlist applied to the merged model surface;
   * typically the `enabledModels` of the config's own `acpx gateway` entry.
   */
  enabledModels?: string[];
  cwd: string;
  permissionMode: PermissionMode;
  verbose?: boolean;
  /**
   * Enables structured session handoff: selecting another backend's model on a
   * bound session migrates the conversation instead of being rejected.
   */
  handoff?: GatewayHandoffOptions;
  /**
   * Ordered failover chain. When a backend fails, the session moves to the
   * next healthy entry; absent means every failure reaches the client.
   */
  fallbacks?: FallbackEntry[];
  /** Interval between backend health checks (default 60 minutes). */
  healthCheckIntervalMs?: number;
  /** How a degraded backend is confirmed before it serves again. */
  restoreMode?: FailoverRestoreMode;
};

/** What a backend advertised during startup probing. */
type BackendDiscovery = {
  /** Raw config options from the probe session, used to passthrough non-model/non-mode options. */
  configOptions: SessionConfigOption[];
  models?: SessionModelState;
  mode: BackendModeSupport;
};

type GatewayClientState = {
  name: string;
  client: AcpClient;
  /** downstream session id -> gateway session id */
  sessionRoutes: Map<string, string>;
  discovery?: BackendDiscovery;
  /** Bare model-id allowlist for this backend's models; undefined means all. */
  enabledModels?: ReadonlySet<string>;
};

/**
 * A gateway session. It starts unbound (no backend, no downstream session); the
 * first model selection binds it. Once bound the route is fixed — cross-backend
 * switching is rejected.
 */
type GatewaySession = {
  gatewaySessionId: string;
  cwd: string;
  state?: GatewayClientState;
  downstreamSessionId?: string;
  /** Set while a bind is in flight so concurrent control calls serialize behind it. */
  bindPromise?: Promise<void>;
  /** Set while a handoff migration is in flight so control calls wait for it. */
  migration?: Promise<void>;
  /** True while the handoff prompt runs on the target backend; its output is dropped. */
  migrating?: boolean;
  /** Number of prompts currently running on the bound backend. */
  pendingPrompts: number;
  /** Prompts already written to the bound backend; lags pendingPrompts while binding. */
  promptsForwarded: number;
  /** Cancels that arrived while a prompt was still waiting to reach its backend. */
  pendingCancels: number;
  /** Structured conversation summary used to migrate to another backend. */
  history: HandoffHistory;
  /** Unified permission currently exposed to the client. */
  unifiedPermission: UnifiedPermission;
  /** Latest config options reported by the bound backend. */
  backendConfigOptions?: SessionConfigOption[];
  /** Latest model state reported by the bound backend. */
  backendModels?: SessionModelState;
  /** Mode support advertised by the bound backend's own session. */
  backendModeSupport?: BackendModeSupport;
  /** Unified permission set before binding, replayed once bound. */
  bufferedMode?: UnifiedPermission;
  /** Other config options set before binding, replayed once bound. */
  bufferedConfigOptions: Array<{ configId: string; value: string }>;
  /** Downstream updates relayed to the client; guards the automatic retry. */
  relayedUpdates: number;
  /** Backend the session was on before a failover moved it elsewhere. */
  failoverOrigin?: { agent: string; model?: string };
};

function resolveRequestedAgentName(meta: NewSessionRequest["_meta"]): string | undefined {
  const acpxMeta = asRecord(meta?.[AGENT_META_KEY]);
  const agent = acpxMeta?.[AGENT_META_AGENT_FIELD];
  if (typeof agent !== "string" || agent.trim().length === 0) {
    return undefined;
  }
  return agent.trim();
}

function unknownGatewaySessionError(sessionId: string): RequestError {
  return new RequestError(UNKNOWN_SESSION_ERROR_CODE, `Unknown gateway session: ${sessionId}`);
}

/** Builds the prefixed model reference a client sends back to select a backend. */
function modelRef(agentName: string, modelId: string): string {
  return `${agentName}/${modelId}`;
}

/** Narrows a backend's model state to the allowed bare model ids. */
function filterModelState(
  models: SessionModelState,
  allowed: ReadonlySet<string> | undefined,
): SessionModelState {
  if (!allowed) {
    return models;
  }
  const availableModels = models.availableModels.filter((model) => allowed.has(model.modelId));
  const currentModelId = allowed.has(models.currentModelId)
    ? models.currentModelId
    : (availableModels[0]?.modelId ?? models.currentModelId);
  return { ...models, currentModelId, availableModels };
}

/**
 * Startup rendezvous supplied by the launcher. Backends are started in the
 * background so the gateway can serve ACP immediately; anything that needs a
 * backend process (binding, migration) waits here first.
 */
export type GatewayBackendReadiness = {
  /** Resolves once the backend process is ready; rejects when it cannot start. */
  waitForStart(agentName: string): Promise<void>;
};

export type AcpGatewayOptions = {
  agents: Array<{ name: string; client: AcpClient; enabledModels?: ReadonlySet<string> }>;
  defaultAgentName: string;
  log?: (message: string) => void;
  /** Prefixed model refs allowed on the merged surface; undefined means all. */
  enabledModels?: ReadonlySet<string>;
  /** Structured session handoff; absent keeps cross-backend switches rejected. */
  handoff?: Required<GatewayHandoffOptions>;
  /** Failover chain; absent keeps every failure on the current backend. */
  failover?: FailoverController;
  /** Backend startup rendezvous used before a session binds; absent means already started. */
  readiness?: GatewayBackendReadiness;
};

export class AcpGateway implements Agent {
  private readonly clients = new Map<string, GatewayClientState>();
  private readonly sessions = new Map<string, GatewaySession>();
  private readonly defaultAgentName: string;
  /** Prefixed model refs allowed on the merged surface; undefined means all. */
  private readonly mergedAllowlist?: ReadonlySet<string>;
  private readonly handoff?: Required<GatewayHandoffOptions>;
  /** Handoff settings used by internal migrations; set whenever failover can move a session. */
  private readonly migrationHandoff?: Required<GatewayHandoffOptions>;
  private readonly failover?: FailoverController;
  private readonly readiness?: GatewayBackendReadiness;
  private readonly log: (message: string) => void;
  private connection?: AgentConnection;

  constructor(options: AcpGatewayOptions) {
    const { agents, defaultAgentName, enabledModels } = options;
    if (agents.length === 0) {
      throw new Error("Gateway requires at least one agent");
    }
    for (const agent of agents) {
      this.clients.set(agent.name, {
        name: agent.name,
        client: agent.client,
        sessionRoutes: new Map<string, string>(),
        ...(agent.enabledModels ? { enabledModels: agent.enabledModels } : {}),
      });
    }
    if (!this.clients.has(defaultAgentName)) {
      throw new Error(`Default agent is not part of the gateway: ${defaultAgentName}`);
    }
    this.defaultAgentName = defaultAgentName;
    this.mergedAllowlist = enabledModels;
    this.handoff = options.handoff;
    this.failover = options.failover;
    this.readiness = options.readiness;
    this.migrationHandoff =
      this.handoff ??
      (this.failover
        ? { recentTurns: DEFAULT_HANDOFF_TURNS, maxChars: DEFAULT_HANDOFF_MAX_CHARS }
        : undefined);
    this.log = options.log ?? (() => {});
  }

  attachConnection(connection: AgentConnection): void {
    this.connection = connection;
  }

  listAgentNames(): string[] {
    return [...this.clients.keys()];
  }

  routeCount(): number {
    return this.sessions.size;
  }

  /**
   * Records the result of probing a backend and re-publishes the merged model
   * surface, so sessions opened before the probe finished learn the models.
   */
  async setBackendDiscovery(agentName: string, discovery: BackendDiscovery): Promise<void> {
    this.requireClient(agentName).discovery = discovery;
    await this.publishSurface();
  }

  /** Pushes the current config-option surface to every session it applies to. */
  private async publishSurface(): Promise<void> {
    const connection = this.connection;
    if (!connection) {
      return;
    }
    for (const session of this.sessions.values()) {
      const unbound = !session.state;
      if (!unbound && !this.handoff) {
        continue;
      }
      if (unbound) {
        this.adoptDefaultPermission(session);
      }
      await connection.sessionUpdate({
        sessionId: session.gatewaySessionId,
        update: {
          sessionUpdate: "config_option_update",
          configOptions: unbound
            ? this.preBindConfigOptions(session)
            : this.boundConfigOptions(session),
        },
      });
    }
  }

  /**
   * Mirrors the default backend's current permission on unbound sessions, the
   * way `session/new` did before discovery became lazy. A permission the client
   * already picked pre-bind wins.
   */
  private adoptDefaultPermission(session: GatewaySession): void {
    if (session.bufferedMode !== undefined) {
      return;
    }
    const discovery = this.clients.get(this.resolveDefaultAgent())?.discovery;
    if (discovery) {
      session.unifiedPermission = resolveUnifiedCurrentPermission(discovery.mode);
    }
  }

  private requireClient(agentName: string): GatewayClientState {
    const state = this.clients.get(agentName);
    if (!state) {
      throw new RequestError(
        INVALID_PARAMS_ERROR_CODE,
        `Unknown gateway agent: ${agentName} (available: ${[...this.clients.keys()].join(", ")})`,
      );
    }
    return state;
  }

  private requireSession(sessionId: string): GatewaySession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw unknownGatewaySessionError(sessionId);
    }
    return session;
  }

  /**
   * Backend a new session lands on: the healthiest chain entry when a
   * failover chain is configured, otherwise the configured default agent.
   */
  private resolveDefaultAgent(): string {
    return this.failover?.preferredAgent() ?? this.defaultAgentName;
  }

  async relayUpdate(agentName: string, notification: SessionNotification): Promise<void> {
    const state = this.clients.get(agentName);
    if (!state) {
      this.log(`update dropped: unknown agent ${agentName}`);
      return;
    }
    await this.handleDownstreamUpdate(state, notification);
  }

  async handleDownstreamUpdate(
    state: GatewayClientState,
    notification: SessionNotification,
  ): Promise<void> {
    const gatewaySessionId = state.sessionRoutes.get(notification.sessionId);
    const connection = this.connection;
    if (!gatewaySessionId || !connection) {
      this.log(`update dropped: no route for ${notification.sessionId}`);
      return;
    }
    const session = this.sessions.get(gatewaySessionId);
    if (!session) {
      this.log(`update dropped: unknown gateway session ${gatewaySessionId}`);
      return;
    }
    if (session.migrating) {
      // The handoff prompt runs before the route is exposed; its output belongs
      // to the migration handshake, not to the user-visible conversation.
      return;
    }
    session.relayedUpdates += 1;
    recordDownstreamUpdate(session.history, notification.update);
    await connection.sessionUpdate({
      sessionId: gatewaySessionId,
      update: this.translateUpdate(state, gatewaySessionId, notification.update),
    });
  }

  /** Rewrites backend mode ids in updates onto the unified permission vocabulary. */
  private translateUpdate(
    state: GatewayClientState,
    gatewaySessionId: string,
    update: SessionNotification["update"],
  ): SessionNotification["update"] {
    const record = asRecord(update);
    const session = record ? this.sessions.get(gatewaySessionId) : undefined;
    if (!record || !session) {
      return update;
    }
    if (record.sessionUpdate === "current_mode_update") {
      return this.translateModeUpdate(session, record, update);
    }
    if (record.sessionUpdate === "config_option_update" && Array.isArray(record.configOptions)) {
      return this.translateConfigOptionUpdate(state, session, record);
    }
    return update;
  }

  /** Mode support for the session's backend: its bound session first, then discovery. */
  private sessionModeSupport(session: GatewaySession): BackendModeSupport | undefined {
    return session.backendModeSupport ?? session.state?.discovery?.mode;
  }

  private translateModeUpdate(
    session: GatewaySession,
    record: Record<string, unknown>,
    update: SessionNotification["update"],
  ): SessionNotification["update"] {
    const backendModeId =
      typeof record.currentModeId === "string" ? record.currentModeId : undefined;
    const support = this.sessionModeSupport(session);
    const unified =
      backendModeId && support
        ? toUnifiedPermission(backendModeId, support.advertisedIds)
        : undefined;
    if (!unified) {
      return update;
    }
    session.unifiedPermission = unified;
    return { ...record, currentModeId: unified } as SessionNotification["update"];
  }

  private translateConfigOptionUpdate(
    state: GatewayClientState,
    session: GatewaySession,
    record: Record<string, unknown>,
  ): SessionNotification["update"] {
    session.backendConfigOptions = record.configOptions as SessionConfigOption[];
    const models = modelStateFromSessionResponse({
      configOptions: session.backendConfigOptions,
      response: undefined,
    });
    if (models) {
      session.backendModels = filterModelState(models, state.enabledModels);
    }
    return {
      ...record,
      configOptions: this.boundConfigOptions(session),
    } as SessionNotification["update"];
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      authMethods: [],
      agentCapabilities: {
        promptCapabilities: {
          image: true,
          audio: true,
          embeddedContext: true,
        },
      },
    };
  }

  async authenticate(): Promise<void> {
    return;
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const requestedName = resolveRequestedAgentName(params._meta);
    const gatewaySessionId = `${GATEWAY_SESSION_PREFIX}${randomUUID()}`;
    const session: GatewaySession = {
      gatewaySessionId,
      cwd: params.cwd,
      unifiedPermission: DEFAULT_UNIFIED_PERMISSION,
      pendingPrompts: 0,
      promptsForwarded: 0,
      pendingCancels: 0,
      history: createHandoffHistory(),
      bufferedConfigOptions: [],
      relayedUpdates: 0,
    };

    if (requestedName) {
      // Compatibility: an explicit _meta agent binds immediately, preserving the
      // pre-lazy behavior for clients that route by agent name.
      await this.createBoundSession(session, requestedName, params.cwd);
      this.sessions.set(gatewaySessionId, session);
      return { sessionId: gatewaySessionId, configOptions: this.boundConfigOptions(session) };
    }

    const defaultState = this.clients.get(this.resolveDefaultAgent());
    if (defaultState?.discovery) {
      session.unifiedPermission = resolveUnifiedCurrentPermission(defaultState.discovery.mode);
    }
    this.sessions.set(gatewaySessionId, session);
    return { sessionId: gatewaySessionId, configOptions: this.preBindConfigOptions(session) };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const session = this.requireSession(params.sessionId);
    await this.settleMigration(session);
    if (!session.state || !session.downstreamSessionId) {
      throw new RequestError(
        INVALID_PARAMS_ERROR_CODE,
        `Session ${params.sessionId} is not bound to an agent yet`,
      );
    }
    await session.state.client.loadSession(session.downstreamSessionId, params.cwd);
    return {};
  }

  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    const session = this.requireSession(params.sessionId);
    await this.settleMigration(session);
    if (!session.state || !session.downstreamSessionId) {
      throw new RequestError(
        INVALID_PARAMS_ERROR_CODE,
        `Session ${params.sessionId} is not bound to an agent yet`,
      );
    }
    await session.state.client.resumeSession(session.downstreamSessionId, params.cwd);
    return {};
  }

  async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    const session = this.requireSession(params.sessionId);
    await this.settleMigration(session);
    if (session.state && session.downstreamSessionId) {
      await session.state.client.closeSession(session.downstreamSessionId);
    }
    this.dropSession(session);
    return {};
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.requireSession(params.sessionId);
    await this.settleMigration(session);
    const historyLength = session.history.messages.length;
    appendUserMessage(session.history, promptText(params.prompt));
    session.pendingPrompts += 1;
    try {
      if (!session.state || !session.downstreamSessionId) {
        await this.bindSession(session, this.resolveDefaultAgent());
        // A client may have chosen a permission before prompting without a model.
        await this.replayBuffered(session);
      }
      const relayedBefore = session.relayedUpdates;
      const state = session.state!;
      const downstreamSessionId = session.downstreamSessionId!;
      try {
        const response = state.client.prompt(downstreamSessionId, params.prompt);
        session.promptsForwarded += 1;
        try {
          await this.flushPendingCancels(session, state, downstreamSessionId);
          return await response;
        } finally {
          session.promptsForwarded -= 1;
        }
      } catch (error) {
        return await this.recoverFromPromptFailure(session, error, params.prompt, {
          relayedBefore,
          historyLength,
        });
      }
    } finally {
      session.pendingPrompts -= 1;
      if (session.pendingPrompts === 0) {
        session.pendingCancels = 0;
      }
    }
  }

  /**
   * Sends cancels that arrived while the turn was still binding. They are
   * written after the prompt so the backend already owns the turn.
   */
  private async flushPendingCancels(
    session: GatewaySession,
    state: GatewayClientState,
    downstreamSessionId: string,
  ): Promise<void> {
    while (session.pendingCancels > 0) {
      session.pendingCancels -= 1;
      try {
        await state.client.cancel(downstreamSessionId);
      } catch {
        // A dead backend surfaces through the prompt result; the cancel is moot.
      }
    }
  }

  /**
   * Moves a failed turn to the next healthy backend and replays it there.
   *
   * The turn is only replayed when it produced no downstream output: once a
   * backend has streamed something, the turn may have had side effects and a
   * second attempt could duplicate them.
   */
  private async recoverFromPromptFailure(
    session: GatewaySession,
    error: unknown,
    prompt: PromptRequest["prompt"],
    context: { relayedBefore: number; historyLength: number },
  ): Promise<PromptResponse> {
    const failover = this.failover;
    const state = session.state;
    if (!failover || !state) {
      throw error;
    }
    const failure = classifyAgentFailure(error);
    if (!isFailoverEligible(failure)) {
      this.log(`session ${session.gatewaySessionId} failed (${failure.class}): ${failure.reason}`);
      throw error;
    }
    failover.markFailure(state.name, failure);
    const target = failover.preferredEntry(state.name);
    if (!target) {
      this.log(`session ${session.gatewaySessionId} failed over: no healthy backend left`);
      throw error;
    }
    if (session.relayedUpdates !== context.relayedBefore) {
      this.log(
        `session ${session.gatewaySessionId} failed after streaming output; not replaying on ${target.agent}`,
      );
      throw error;
    }
    try {
      await this.migrateSession(session, target, context.historyLength);
    } catch (migrationError) {
      this.log(
        `session ${session.gatewaySessionId} could not move to ${target.agent}: ${String(migrationError)}`,
      );
      throw error;
    }
    this.log(
      `session ${session.gatewaySessionId} failed over from ${state.name} to ${target.agent}`,
    );
    await this.notifyConfigOptions(session);
    try {
      return await session.state!.client.prompt(session.downstreamSessionId!, prompt);
    } catch (retryError) {
      failover.markFailure(session.state!.name, classifyAgentFailure(retryError));
      throw retryError;
    }
  }

  /** Waits for an in-flight handoff so later control calls hit the new backend. */
  private async settleMigration(session: GatewaySession): Promise<void> {
    if (session.migration) {
      await session.migration;
    }
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.requireSession(params.sessionId);
    if (session.pendingPrompts > session.promptsForwarded) {
      // The turn is still binding; hand the cancel to it instead of dropping it.
      session.pendingCancels += 1;
      return;
    }
    if (!session.state || !session.downstreamSessionId) {
      return;
    }
    await session.state.client.cancel(session.downstreamSessionId);
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = this.requireSession(params.sessionId);
    await this.settleMigration(session);
    await this.applyUnifiedMode(session, params.modeId);
    return {};
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const session = this.requireSession(params.sessionId);
    await this.settleMigration(session);
    const rawValue = typeof params.value === "boolean" ? String(params.value) : params.value;
    if (params.configId === UNIFIED_MODEL_CONFIG_ID) {
      return await this.applyModelSelection(session, rawValue);
    }
    if (params.configId === UNIFIED_PERMISSION_CONFIG_ID) {
      return await this.applyUnifiedMode(session, rawValue);
    }
    if (!session.state || !session.downstreamSessionId) {
      if (session.bindPromise) {
        await session.bindPromise;
      } else {
        session.bufferedConfigOptions.push({ configId: params.configId, value: rawValue });
        return { configOptions: this.preBindConfigOptions(session) };
      }
    }
    return await this.forwardConfigOption(session, params.configId, rawValue);
  }

  async extMethod(method: string): Promise<never> {
    throw new RequestError(METHOD_NOT_FOUND_ERROR_CODE, `Unsupported gateway method: ${method}`);
  }

  /** Binds an unbound session to a backend, serializing concurrent binds. */
  private async bindSession(session: GatewaySession, agentName: string): Promise<void> {
    if (session.state) {
      if (session.state.name !== agentName) {
        throw new RequestError(
          INVALID_PARAMS_ERROR_CODE,
          `Session is already bound to agent "${session.state.name}"; switching to "${agentName}" is not supported`,
        );
      }
      return;
    }
    session.bindPromise ??= this.createBoundSession(session, agentName, session.cwd).catch(
      (error: unknown) => {
        // Allow a later attempt to retry a failed bind.
        session.bindPromise = undefined;
        throw error;
      },
    );
    await session.bindPromise;
  }

  /** Creates the downstream session and wires the route for a backend. */
  private async createBoundSession(
    session: GatewaySession,
    agentName: string,
    cwd: string,
  ): Promise<void> {
    const state = this.requireClient(agentName);
    await this.readiness?.waitForStart(agentName);
    const created = await state.client.createSession(cwd);
    this.applyCreatedSession(session, state, created);
    this.log(`bound session ${session.gatewaySessionId} to agent ${agentName}`);
  }

  /** Publishes a freshly created downstream session on the gateway session. */
  private applyCreatedSession(
    session: GatewaySession,
    state: GatewayClientState,
    created: SessionCreateResult,
  ): void {
    session.state = state;
    session.downstreamSessionId = created.sessionId;
    session.backendConfigOptions = created.configOptions ?? state.discovery?.configOptions ?? [];
    session.backendModels = created.models
      ? filterModelState(created.models, state.enabledModels)
      : state.discovery?.models;
    session.backendModeSupport = this.createdModeSupport(state, created);
    session.unifiedPermission = resolveUnifiedCurrentPermission(session.backendModeSupport);
    state.sessionRoutes.set(created.sessionId, session.gatewaySessionId);
  }

  /**
   * Mode support the backend's own session advertised, falling back to
   * discovery when the session reported no usable mode surface.
   */
  private createdModeSupport(
    state: GatewayClientState,
    created: SessionCreateResult,
  ): BackendModeSupport {
    const modeSupport = resolveBackendModeSupport({
      configOptions: created.configOptions,
      modes: created.modes,
    });
    return modeSupport.setPath === "none" ? (state.discovery?.mode ?? modeSupport) : modeSupport;
  }

  private async applyModelSelection(
    session: GatewaySession,
    ref: string,
  ): Promise<SetSessionConfigOptionResponse> {
    const { agentName, modelId } = this.resolveModelRef(ref);
    if (session.state && session.state.name !== agentName) {
      return await this.switchBackend(session, agentName, modelId);
    }
    await this.bindSession(session, agentName);
    const state = session.state!;
    const models = session.backendModels ?? state.discovery?.models;
    if (!models) {
      throw new RequestError(
        INVALID_PARAMS_ERROR_CODE,
        `Agent "${agentName}" does not advertise selectable models`,
      );
    }
    let response: Awaited<ReturnType<typeof state.client.setSessionModel>>;
    try {
      response = await state.client.setSessionModel(session.downstreamSessionId!, modelId, models);
    } catch (error) {
      if (error instanceof RequestedModelUnsupportedError) {
        throw new RequestError(
          INVALID_PARAMS_ERROR_CODE,
          `Agent "${agentName}" did not advertise model "${modelId}". Available models: ${models.availableModels.map((model) => model.modelId).join(", ")}`,
        );
      }
      throw error;
    }
    this.updateBackendOptions(session, response);
    await this.replayBuffered(session);
    return { configOptions: this.boundConfigOptions(session) };
  }

  /**
   * Moves a bound session to another backend when structured handoff is on.
   * The old binding is kept until the new session has accepted the model and the
   * handoff prompt, so a failure leaves the session usable on the old agent.
   */
  private async switchBackend(
    session: GatewaySession,
    agentName: string,
    modelId: string,
  ): Promise<SetSessionConfigOptionResponse> {
    if (!this.handoff) {
      throw new RequestError(
        INVALID_PARAMS_ERROR_CODE,
        `Session is already bound to agent "${session.state?.name}"; switching to "${agentName}" is not supported`,
      );
    }
    if (session.migration) {
      await session.migration;
      if (session.state?.name === agentName) {
        return { configOptions: this.boundConfigOptions(session) };
      }
      return await this.switchBackend(session, agentName, modelId);
    }
    if (session.pendingPrompts > 0) {
      throw new RequestError(
        INVALID_PARAMS_ERROR_CODE,
        `Cannot switch session from agent "${session.state?.name}" to "${agentName}" while a turn is running`,
      );
    }
    const migration = this.performMigration(session, agentName, modelId);
    // Never reject the shared promise: the initiating caller observes the error
    // through `migration`, while concurrent control calls only wait for it.
    session.migration = migration.then(
      () => undefined,
      () => undefined,
    );
    try {
      await migration;
    } finally {
      session.migration = undefined;
    }
    return { configOptions: this.boundConfigOptions(session) };
  }

  private async performMigration(
    session: GatewaySession,
    agentName: string,
    modelId: string | undefined,
    options?: { handoffMessages?: HandoffMessage[] },
  ): Promise<void> {
    const source = session.state;
    const sourceSessionId = session.downstreamSessionId;
    if (!source || !sourceSessionId) {
      throw new RequestError(INVALID_PARAMS_ERROR_CODE, "Session is not bound to an agent yet");
    }
    const target = this.requireClient(agentName);
    const created = await this.createMigrationSession(session, target, agentName);
    session.migrating = true;
    target.sessionRoutes.set(created.sessionId, session.gatewaySessionId);
    try {
      const applied = await this.applyMigrationModel(target, created, agentName, modelId);
      await this.runHandoffPrompt(
        session,
        target,
        created.sessionId,
        source.name,
        agentName,
        options?.handoffMessages,
      );
      this.commitMigration(session, {
        source,
        sourceSessionId,
        target,
        createdSessionId: created.sessionId,
        ...(created.modes ? { createdModes: created.modes } : {}),
        modelId,
        applied,
      });
      await this.applyPermissionAfterMigration(session);
      await this.closeQuietly(source, sourceSessionId);
      this.log(`migrated session ${session.gatewaySessionId} from ${source.name} to ${agentName}`);
    } catch (error) {
      target.sessionRoutes.delete(created.sessionId);
      await this.closeQuietly(target, created.sessionId);
      throw error;
    } finally {
      session.migrating = false;
    }
  }

  private async createMigrationSession(
    session: GatewaySession,
    target: GatewayClientState,
    agentName: string,
  ): Promise<SessionCreateResult> {
    try {
      await this.readiness?.waitForStart(agentName);
      return await target.client.createSession(session.cwd);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new RequestError(
        INVALID_PARAMS_ERROR_CODE,
        `Failed to start agent "${agentName}" for session handoff: ${message}`,
      );
    }
  }

  private async applyMigrationModel(
    target: GatewayClientState,
    created: SessionCreateResult,
    agentName: string,
    modelId: string | undefined,
  ): Promise<{
    models?: SessionModelState;
    response: SetSessionConfigOptionResponse | undefined;
    createdConfigOptions?: SessionConfigOption[];
  }> {
    const models = created.models
      ? filterModelState(created.models, target.enabledModels)
      : target.discovery?.models;
    if (!modelId) {
      // No pinned model: the new session keeps the backend's own default.
      return {
        models,
        response: undefined,
        ...(created.configOptions ? { createdConfigOptions: created.configOptions } : {}),
      };
    }
    if (!models) {
      throw new RequestError(
        INVALID_PARAMS_ERROR_CODE,
        `Agent "${agentName}" does not advertise selectable models`,
      );
    }
    const response = await this.requestMigrationModel(target, created, agentName, modelId, models);
    return {
      models,
      response,
      ...(created.configOptions ? { createdConfigOptions: created.configOptions } : {}),
    };
  }

  private async requestMigrationModel(
    target: GatewayClientState,
    created: SessionCreateResult,
    agentName: string,
    modelId: string,
    models: SessionModelState,
  ): Promise<SetSessionConfigOptionResponse | undefined> {
    try {
      return await target.client.setSessionModel(created.sessionId, modelId, models);
    } catch (error) {
      if (error instanceof RequestedModelUnsupportedError) {
        throw new RequestError(
          INVALID_PARAMS_ERROR_CODE,
          `Agent "${agentName}" did not advertise model "${modelId}". Available models: ${models.availableModels.map((model) => model.modelId).join(", ")}`,
        );
      }
      throw error;
    }
  }

  private async runHandoffPrompt(
    session: GatewaySession,
    target: GatewayClientState,
    downstreamSessionId: string,
    fromAgent: string,
    toAgent: string,
    messages?: HandoffMessage[],
  ): Promise<void> {
    const handoff = this.migrationHandoff;
    if (!handoff) {
      return;
    }
    const history: HandoffHistory = messages ? { ...session.history, messages } : session.history;
    if (history.messages.length === 0) {
      return;
    }
    const prompt = renderHandoffPrompt({
      fromAgent,
      toAgent,
      history,
      recentTurns: handoff.recentTurns,
      maxChars: handoff.maxChars,
    });
    await target.client.prompt(downstreamSessionId, prompt);
  }

  private commitMigration(
    session: GatewaySession,
    input: {
      source: GatewayClientState;
      sourceSessionId: string;
      target: GatewayClientState;
      createdSessionId: string;
      createdModes?: SessionModeState;
      modelId: string | undefined;
      applied: {
        models?: SessionModelState;
        response: SetSessionConfigOptionResponse | undefined;
        createdConfigOptions?: SessionConfigOption[];
      };
    },
  ): void {
    const { source, sourceSessionId, target, createdSessionId, modelId, applied } = input;
    source.sessionRoutes.delete(sourceSessionId);
    session.state = target;
    session.downstreamSessionId = createdSessionId;
    const configOptions = this.migratedConfigOptions(target, applied);
    session.backendConfigOptions = configOptions;
    session.backendModels = this.migratedModels(target, applied, configOptions, modelId);
    session.backendModeSupport = this.migratedModeSupport(target, applied, input.createdModes);
    appendNote(session.history, `Session migrated from "${source.name}" to "${target.name}".`);
  }

  private migratedModeSupport(
    target: GatewayClientState,
    applied: { createdConfigOptions?: SessionConfigOption[] },
    createdModes: SessionModeState | undefined,
  ): BackendModeSupport | undefined {
    const advertised = resolveBackendModeSupport({
      configOptions: applied.createdConfigOptions,
      modes: createdModes,
    });
    if (advertised.setPath !== "none") {
      return advertised;
    }
    return target.discovery?.mode ?? advertised;
  }

  private migratedConfigOptions(
    target: GatewayClientState,
    applied: {
      response: SetSessionConfigOptionResponse | undefined;
      createdConfigOptions?: SessionConfigOption[];
    },
  ): SessionConfigOption[] {
    return (
      applied.response?.configOptions ??
      applied.createdConfigOptions ??
      target.discovery?.configOptions ??
      []
    );
  }

  private migratedModels(
    target: GatewayClientState,
    applied: {
      models?: SessionModelState;
      response: SetSessionConfigOptionResponse | undefined;
    },
    configOptions: SessionConfigOption[],
    modelId: string | undefined,
  ): SessionModelState | undefined {
    const advertised =
      modelStateFromSessionResponse({ configOptions, response: applied.response }) ??
      applied.models;
    if (!advertised) {
      return undefined;
    }
    const current = modelId ? { ...advertised, currentModelId: modelId } : advertised;
    return filterModelState(current, target.enabledModels);
  }

  /** Best-effort permission replay onto the new backend; a failure is not fatal. */
  private async applyPermissionAfterMigration(session: GatewaySession): Promise<void> {
    try {
      await this.forwardUnifiedMode(session, session.unifiedPermission);
    } catch (error) {
      this.log(`handoff permission not applied: ${String(error)}`);
    }
  }

  /**
   * Moves a session onto a failover chain entry. The conversation travels with
   * it; the failed turn is excluded so it is not replayed twice.
   */
  private async migrateSession(
    session: GatewaySession,
    target: FallbackEntry,
    historyLength?: number,
  ): Promise<void> {
    this.requireClient(target.agent);
    const origin = session.failoverOrigin ?? {
      agent: session.state?.name ?? target.agent,
      ...(session.backendModels?.currentModelId
        ? { model: session.backendModels.currentModelId }
        : {}),
    };
    const handoffMessages =
      historyLength === undefined ? undefined : session.history.messages.slice(0, historyLength);
    await this.performMigration(
      session,
      target.agent,
      target.model,
      handoffMessages ? { handoffMessages } : undefined,
    );
    session.failoverOrigin = origin;
  }

  /** Tells the client which models and modes the session exposes now. */
  private async notifyConfigOptions(session: GatewaySession): Promise<void> {
    const connection = this.connection;
    if (!connection) {
      return;
    }
    await connection.sessionUpdate({
      sessionId: session.gatewaySessionId,
      update: {
        sessionUpdate: "config_option_update",
        configOptions: this.boundConfigOptions(session),
      },
    });
  }

  /**
   * Moves sessions that failed over back to a recovered, higher-priority
   * backend. Sessions the client placed on a lower-priority agent are left
   * alone: only a failover leaves a trail to follow back.
   */
  async restoreFailedOverSessions(): Promise<void> {
    const failover = this.failover;
    if (!failover) {
      return;
    }
    for (const session of this.sessions.values()) {
      const origin = session.failoverOrigin;
      if (!origin || !this.canRestoreSession(session, failover)) {
        continue;
      }
      await this.restoreSession(session, origin);
    }
  }

  /** True when the session may move back to a recovered higher-priority backend. */
  private canRestoreSession(session: GatewaySession, failover: FailoverController): boolean {
    const origin = session.failoverOrigin;
    if (!origin || !session.state || !session.downstreamSessionId) {
      return false;
    }
    if (session.pendingPrompts > 0 || session.migration) {
      return false;
    }
    if (!failover.isHealthy(origin.agent)) {
      return false;
    }
    return failover.rankOf(origin.agent) < failover.rankOf(session.state.name);
  }

  private async restoreSession(
    session: GatewaySession,
    origin: { agent: string; model?: string },
  ): Promise<void> {
    const state = this.clients.get(origin.agent);
    if (!state) {
      return;
    }
    const models = state.discovery?.models;
    const modelId =
      origin.model && models?.availableModels.some((model) => model.modelId === origin.model)
        ? origin.model
        : undefined;
    try {
      await this.performMigration(session, origin.agent, modelId);
      session.failoverOrigin = undefined;
      this.log(`session ${session.gatewaySessionId} restored to ${origin.agent}`);
      await this.notifyConfigOptions(session);
    } catch (error) {
      this.log(
        `session ${session.gatewaySessionId} could not return to ${origin.agent}: ${String(error)}`,
      );
    }
  }

  private async closeQuietly(state: GatewayClientState, sessionId: string): Promise<void> {
    if (!state.client.supportsCloseSession()) {
      return;
    }
    try {
      await state.client.closeSession(sessionId);
    } catch (error) {
      this.log(`handoff close failed for ${state.name}/${sessionId}: ${String(error)}`);
    }
  }

  private async applyUnifiedMode(
    session: GatewaySession,
    value: string,
  ): Promise<SetSessionConfigOptionResponse> {
    if (!isUnifiedPermission(value)) {
      throw new RequestError(
        INVALID_PARAMS_ERROR_CODE,
        `Unknown permission mode "${value}" (expected one of: ask, code, bypass)`,
      );
    }
    if (!session.state || !session.downstreamSessionId) {
      return this.bufferUnifiedMode(session, value);
    }
    await this.forwardUnifiedMode(session, value);
    session.unifiedPermission = value;
    return { configOptions: this.boundConfigOptions(session) };
  }

  /** Records a unified permission chosen before the session is bound. */
  private bufferUnifiedMode(
    session: GatewaySession,
    value: UnifiedPermission,
  ): SetSessionConfigOptionResponse {
    session.unifiedPermission = value;
    session.bufferedMode = value;
    return { configOptions: this.preBindConfigOptions(session) };
  }

  /**
   * Translates a unified permission onto the bound backend. Q2: a backend that
   * exposes no matching mode accepts the value without forwarding.
   */
  private async forwardUnifiedMode(
    session: GatewaySession,
    value: UnifiedPermission,
  ): Promise<void> {
    const state = session.state!;
    const support = this.sessionModeSupport(session);
    const backendModeId = support ? toBackendModeId(value, support.advertisedIds) : undefined;
    if (!support || support.setPath === "none" || !backendModeId) {
      return;
    }
    if (support.setPath === "config_option" && support.configId) {
      const response = await state.client.setSessionConfigOption(
        session.downstreamSessionId!,
        support.configId,
        backendModeId,
        undefined,
      );
      this.updateBackendOptions(session, response);
      return;
    }
    await state.client.setSessionMode(session.downstreamSessionId!, backendModeId);
  }

  private async forwardConfigOption(
    session: GatewaySession,
    configId: string,
    value: string,
  ): Promise<SetSessionConfigOptionResponse> {
    const state = session.state!;
    const response = await state.client.setSessionConfigOption(
      session.downstreamSessionId!,
      configId,
      value,
      undefined,
    );
    this.updateBackendOptions(session, response);
    return { configOptions: this.boundConfigOptions(session) };
  }

  private async replayBuffered(session: GatewaySession): Promise<void> {
    if (session.bufferedMode !== undefined) {
      const mode = session.bufferedMode;
      session.bufferedMode = undefined;
      await this.applyUnifiedMode(session, mode);
    }
    const pending = session.bufferedConfigOptions.splice(0);
    for (const option of pending) {
      await this.forwardConfigOption(session, option.configId, option.value);
    }
  }

  private updateBackendOptions(
    session: GatewaySession,
    response: SetSessionConfigOptionResponse | undefined,
  ): void {
    if (!response) {
      return;
    }
    session.backendConfigOptions = response.configOptions;
    const models = modelStateFromSessionResponse({
      configOptions: session.backendConfigOptions,
      response,
    });
    if (models) {
      session.backendModels = filterModelState(models, session.state?.enabledModels);
    }
  }

  /** Splits a prefixed model reference, matching the longest known agent name. */
  private resolveModelRef(ref: string): { agentName: string; modelId: string } {
    const names = [...this.clients.keys()].toSorted((a, b) => b.length - a.length);
    for (const name of names) {
      if (ref.startsWith(`${name}/`)) {
        return { agentName: name, modelId: ref.slice(name.length + 1) };
      }
    }
    throw new RequestError(
      INVALID_PARAMS_ERROR_CODE,
      `Unknown model reference "${ref}"; expected "<agent>/<model>"`,
    );
  }

  /** Config options exposed before a session is bound. */
  private preBindConfigOptions(session: GatewaySession): SessionConfigOption[] {
    const options: SessionConfigOption[] = [];
    const modelOption = this.mergedModelOption();
    if (modelOption) {
      options.push(modelOption);
    }
    options.push(buildUnifiedModeOption(session.unifiedPermission));
    return options;
  }

  /** Config options exposed after a session is bound, with models prefixed and mode unified. */
  private boundConfigOptions(session: GatewaySession): SessionConfigOption[] {
    const options: SessionConfigOption[] = [];
    const modelOption = this.boundModelOption(session);
    if (modelOption) {
      options.push(modelOption);
    }
    options.push(buildUnifiedModeOption(session.unifiedPermission));
    for (const option of session.backendConfigOptions ?? []) {
      if (isPassthroughConfigOption(option)) {
        options.push(option);
      }
    }
    return options;
  }

  /**
   * A bound session normally advertises only its backend's models. With handoff
   * enabled the merged surface stays visible so the client can request a switch.
   */
  private boundModelOption(session: GatewaySession): SessionConfigOption | undefined {
    const state = session.state;
    if (!state || !session.backendModels) {
      return undefined;
    }
    const currentRef = modelRef(state.name, session.backendModels.currentModelId);
    if (!this.handoff) {
      return buildModelOption(state.name, session.backendModels);
    }
    return this.mergedModelOption(currentRef);
  }

  private mergedModelOption(currentRef?: string): SessionConfigOption | undefined {
    const surface = this.mergedSurface();
    const currentValue = currentRef ?? surface.defaultCurrent ?? surface.options[0]?.value;
    if (!currentValue) {
      return undefined;
    }
    if (!surface.options.some((option) => option.value === currentValue)) {
      // A session bound through _meta may sit on a model outside the merged
      // allowlist; keep the current value selectable so clients can render it.
      surface.options.unshift({ value: currentValue, name: currentValue });
    }
    return {
      id: UNIFIED_MODEL_CONFIG_ID,
      name: "Model",
      category: "model",
      type: "select",
      currentValue,
      options: surface.options,
    };
  }

  private mergedSurface(): {
    options: Array<{ value: string; name: string }>;
    defaultCurrent?: string;
  } {
    const options: Array<{ value: string; name: string }> = [];
    let defaultCurrent: string | undefined;
    const defaultAgentName = this.resolveDefaultAgent();
    for (const state of this.clients.values()) {
      const models = state.discovery?.models;
      if (!models) {
        continue;
      }
      this.collectMergedOptions(state, models, options);
      if (state.name === defaultAgentName) {
        const defaultRef = modelRef(state.name, models.currentModelId);
        if (this.mergedAllows(defaultRef)) {
          defaultCurrent = defaultRef;
        }
      }
    }
    return { options, ...(defaultCurrent ? { defaultCurrent } : {}) };
  }

  private collectMergedOptions(
    state: GatewayClientState,
    models: SessionModelState,
    options: Array<{ value: string; name: string }>,
  ): void {
    for (const model of models.availableModels) {
      const ref = modelRef(state.name, model.modelId);
      if (!this.mergedAllows(ref)) {
        continue;
      }
      options.push({
        value: ref,
        name: `${state.name}: ${model.name}`,
      });
    }
  }

  private mergedAllows(ref: string): boolean {
    return !this.mergedAllowlist || this.mergedAllowlist.has(ref);
  }

  private dropSession(session: GatewaySession): void {
    this.sessions.delete(session.gatewaySessionId);
    if (session.state && session.downstreamSessionId) {
      session.state.sessionRoutes.delete(session.downstreamSessionId);
    }
  }
}

function buildModelOption(agentName: string, models: SessionModelState): SessionConfigOption {
  return {
    id: UNIFIED_MODEL_CONFIG_ID,
    name: "Model",
    category: "model",
    type: "select",
    currentValue: modelRef(agentName, models.currentModelId),
    options: models.availableModels.map((model) => ({
      value: modelRef(agentName, model.modelId),
      name: `${agentName}: ${model.name}`,
    })),
  };
}

/** Passes through backend options that are neither a model nor a mode selector. */
function isPassthroughConfigOption(option: SessionConfigOption): boolean {
  const record = asRecord(option);
  if (!record) {
    return false;
  }
  return !isModelSelectOption(record) && !isModeSelectOption(record);
}

function dedupeAgents(agents: GatewayAgentSpec[]): GatewayAgentSpec[] {
  const seen = new Set<string>();
  const unique: GatewayAgentSpec[] = [];
  for (const agent of agents) {
    const key = JSON.stringify([
      agent.agentCommand,
      agent.agentArgv ?? [],
      agent.env ?? {},
      agent.enabledModels ?? [],
    ]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(agent);
  }
  return unique;
}

type BackendReadiness = GatewayBackendReadiness & {
  /** Starts and probes every backend; resolves once all pipelines settled. */
  begin(): Promise<void>;
};

/**
 * Starts and probes every backend in parallel.
 *
 * Nothing waits for the slowest agent: the gateway serves ACP while this runs
 * in the background and publishes each backend's models as soon as its probe
 * lands. A backend that cannot start is logged and skipped, like a failed
 * probe; binding to it surfaces the launch error.
 */
function createBackendReadiness(
  states: GatewayClientState[],
  getGateway: () => AcpGateway | undefined,
  cwd: string,
  log: (message: string) => void,
): BackendReadiness {
  const starts = new Map<string, Promise<void>>();
  return {
    waitForStart: async (agentName: string): Promise<void> => {
      await starts.get(agentName);
    },
    begin: async (): Promise<void> => {
      const pipelines = states.map((state) => {
        const started = state.client.start();
        starts.set(state.name, started);
        return started.then(
          async () => {
            log(`started agent: ${state.name}`);
            const discovery = await probeBackendQuietly(state, cwd, log);
            await getGateway()
              ?.setBackendDiscovery(state.name, discovery)
              .catch((error: unknown) => {
                log(`could not publish ${state.name} discovery: ${String(error)}`);
              });
          },
          (error: unknown) => {
            log(`agent ${state.name} failed to start: ${String(error)}`);
          },
        );
      });
      await Promise.all(pipelines);
    },
  };
}

/**
 * Probes a backend once to learn its models and modes. The probe session is
 * closed when the backend supports it, otherwise it lingers route-less.
 */
async function probeBackend(state: GatewayClientState, cwd: string): Promise<BackendDiscovery> {
  const created = await state.client.createSession(cwd);
  const discovery: BackendDiscovery = {
    configOptions: created.configOptions ?? [],
    models: created.models ? filterModelState(created.models, state.enabledModels) : undefined,
    mode: resolveBackendModeSupport({
      configOptions: created.configOptions,
      modes: created.modes,
    }),
  };
  if (state.client.supportsCloseSession()) {
    await state.client.closeSession(created.sessionId);
  }
  return discovery;
}

/**
 * A backend whose probe fails (for example an agent that needs auth before
 * `session/new`) is degraded rather than fatal: it is kept reachable via
 * `_meta.acpx.agent`, but contributes no models or modes to the merged surface.
 */
async function probeBackendQuietly(
  state: GatewayClientState,
  cwd: string,
  log: (message: string) => void,
): Promise<BackendDiscovery> {
  let discovery: BackendDiscovery;
  try {
    discovery = await probeBackend(state, cwd);
  } catch (error) {
    discovery = { configOptions: [], mode: { setPath: "none", advertisedIds: [] } };
    log(`probe failed for agent ${state.name}: ${String(error)} (no models advertised)`);
    return discovery;
  }
  log(
    `probed agent ${state.name}: models=${discovery.models?.availableModels.length ?? 0} modes=${discovery.mode.advertisedIds.length} (${discovery.mode.setPath})`,
  );
  return discovery;
}

function createGatewayLogger(verbose: boolean | undefined): (message: string) => void {
  if (!verbose) {
    return () => {};
  }
  return (message: string): void => {
    process.stderr.write(`[acpx gateway] ${message}\n`);
  };
}

function resolveHandoffOptions(
  handoff: GatewayHandoffOptions | undefined,
): Required<GatewayHandoffOptions> | undefined {
  if (!handoff) {
    return undefined;
  }
  return {
    recentTurns: handoff.recentTurns ?? DEFAULT_HANDOFF_TURNS,
    maxChars: handoff.maxChars ?? DEFAULT_HANDOFF_MAX_CHARS,
  };
}

function createClientState(
  agent: GatewayAgentSpec,
  options: RunAcpGatewayOptions,
  onSessionUpdate: (notification: SessionNotification) => void,
  onProcessExit: (exit: AcpProcessExit) => void,
): GatewayClientState {
  return {
    name: agent.name,
    client: new AcpClient({
      agentCommand: agent.agentCommand,
      agentArgv: agent.agentArgv,
      cwd: options.cwd,
      permissionMode: options.permissionMode,
      ...(agent.env ? { sessionOptions: { env: agent.env } } : {}),
      processLifecycle: { onExit: onProcessExit },
      verbose: options.verbose,
      suppressSdkConsoleErrors: true,
      onSessionUpdate,
    }),
    sessionRoutes: new Map<string, string>(),
    ...(agent.enabledModels ? { enabledModels: new Set<string>(agent.enabledModels) } : {}),
  };
}

function buildGateway(
  states: GatewayClientState[],
  options: RunAcpGatewayOptions,
  log: (message: string) => void,
  enabledModels: ReadonlySet<string> | undefined,
  handoff: Required<GatewayHandoffOptions> | undefined,
  failover: FailoverController | undefined,
  readiness: GatewayBackendReadiness,
): AcpGateway {
  return new AcpGateway({
    agents: states.map((state) => ({
      name: state.name,
      client: state.client,
      ...(state.enabledModels ? { enabledModels: state.enabledModels } : {}),
    })),
    defaultAgentName: options.defaultAgent ?? states[0].name,
    log,
    ...(enabledModels ? { enabledModels } : {}),
    ...(handoff ? { handoff } : {}),
    ...(failover ? { failover } : {}),
    readiness,
  });
}

/**
 * Builds the failover controller for a configured chain.
 *
 * Without a chain the gateway behaves exactly as before: no health state, no
 * timer, and every backend failure reaches the client unchanged.
 */
function createFailoverController(input: {
  fallbacks: readonly FallbackEntry[];
  agents: string[];
  statesByName: Map<string, GatewayClientState>;
  cwd: string;
  log: (message: string) => void;
  getGateway: () => AcpGateway | undefined;
  healthCheckIntervalMs?: number;
  restoreMode?: FailoverRestoreMode;
}): FailoverController | undefined {
  const { fallbacks, agents, statesByName, cwd, log, getGateway } = input;
  if (fallbacks.length === 0) {
    return undefined;
  }
  const served = new Set(agents);
  for (const entry of fallbacks) {
    if (!served.has(entry.agent)) {
      throw new Error(
        `Fallback agent "${entry.agent}" is not served by this gateway (available: ${[...served].join(", ")})`,
      );
    }
  }
  return new FailoverController({
    policy: {
      entries: [...fallbacks],
      healthCheckIntervalMs: input.healthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS,
      restoreMode: input.restoreMode ?? "optimistic",
    },
    agents,
    log,
    hooks: {
      respawn: async (agent) => {
        const state = statesByName.get(agent);
        if (!state) {
          return false;
        }
        try {
          await state.client.start();
          const discovery = await probeBackend(state, cwd);
          state.discovery = discovery;
          await getGateway()?.setBackendDiscovery(agent, discovery);
          log(`respawned agent ${agent}`);
          return true;
        } catch (error) {
          log(`respawn failed for agent ${agent}: ${String(error)}`);
          return false;
        }
      },
      verify: async (agent) => {
        const state = statesByName.get(agent);
        if (!state) {
          return false;
        }
        let sessionId: string | undefined;
        try {
          const created = await state.client.createSession(cwd);
          sessionId = created.sessionId;
          await state.client.prompt(created.sessionId, "ping");
          return true;
        } catch (error) {
          log(`canary probe failed for agent ${agent}: ${String(error)}`);
          return false;
        } finally {
          if (sessionId && state.client.supportsCloseSession()) {
            try {
              await state.client.closeSession(sessionId);
            } catch (error) {
              log(`canary probe cleanup failed for agent ${agent}: ${String(error)}`);
            }
          }
        }
      },
    },
    afterTick: async () => {
      await getGateway()?.restoreFailedOverSessions();
    },
  });
}

export async function runAcpGateway(options: RunAcpGatewayOptions): Promise<number> {
  const log = createGatewayLogger(options.verbose);
  const agents = dedupeAgents(options.agents);
  if (agents.length === 0) {
    throw new Error("Gateway requires at least one agent");
  }
  const enabledModels = options.enabledModels ? new Set<string>(options.enabledModels) : undefined;
  const fallbacks = options.fallbacks ?? [];

  let gatewayRef: AcpGateway | undefined;
  let failoverRef: FailoverController | undefined;
  let closing = false;
  const states = agents.map((agent) =>
    createClientState(
      agent,
      options,
      (notification) => {
        void gatewayRef?.relayUpdate(agent.name, notification).catch((error: unknown) => {
          log(`session update relay failed: ${String(error)}`);
        });
      },
      (exit) => {
        if (closing) {
          return;
        }
        failoverRef?.markDown(
          agent.name,
          `agent process exited (code ${exit.exitCode ?? "unknown"}, signal ${exit.signal ?? "none"})`,
        );
      },
    ),
  );
  const statesByName = new Map(states.map((state) => [state.name, state]));
  const failover = createFailoverController({
    fallbacks,
    agents: states.map((state) => state.name),
    statesByName,
    cwd: options.cwd,
    log,
    getGateway: () => gatewayRef,
    ...(options.healthCheckIntervalMs !== undefined
      ? { healthCheckIntervalMs: options.healthCheckIntervalMs }
      : {}),
    ...(options.restoreMode !== undefined ? { restoreMode: options.restoreMode } : {}),
  });
  failoverRef = failover;
  const readiness = createBackendReadiness(states, () => gatewayRef, options.cwd, log);
  const gateway = buildGateway(
    states,
    options,
    log,
    enabledModels,
    resolveHandoffOptions(options.handoff),
    failover,
    readiness,
  );
  gatewayRef = gateway;
  const startup = readiness.begin();

  // Backends boot and probe in the background: the gateway answers ACP right
  // away and pushes the merged model list when each discovery lands.
  void startup.then(() => {
    if (!closing) {
      failover?.start();
    }
  });

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      closing = true;
      failover?.stop();
      log("shutting down; retiring all agents");
      await Promise.allSettled(states.map((state) => state.client.close()));
      await startup;
    })();
    return shutdownPromise;
  };

  const onSignal = (): void => {
    void shutdown().finally(() => {
      process.exit(EXIT_CODES.INTERRUPTED);
    });
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const output = Writable.toWeb(process.stdout);
  const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(output, input);
  const connection = new AgentSideConnection((agentConnection) => {
    gateway.attachConnection(agentConnection);
    return gateway;
  }, stream);
  void connection;

  const stdinEof = new Promise<void>((resolve) => {
    process.stdin.once("end", () => resolve());
  });
  await stdinEof;
  await shutdown();
  log("upstream closed; gateway exit");
  return EXIT_CODES.SUCCESS;
}
