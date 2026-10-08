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
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
} from "@agentclientprotocol/sdk";
import { EXIT_CODES, type PermissionMode } from "../types.js";
import { AcpClient } from "./client.js";
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
};

export type RunAcpGatewayOptions = {
  agents: GatewayAgentSpec[];
  /** Agent name used when session/new has no _meta selection; defaults to the first agent. */
  defaultAgent?: string;
  cwd: string;
  permissionMode: PermissionMode;
  verbose?: boolean;
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
  /** Unified permission currently exposed to the client. */
  unifiedPermission: UnifiedPermission;
  /** Latest config options reported by the bound backend. */
  backendConfigOptions?: SessionConfigOption[];
  /** Latest model state reported by the bound backend. */
  backendModels?: SessionModelState;
  /** Unified permission set before binding, replayed once bound. */
  bufferedMode?: UnifiedPermission;
  /** Other config options set before binding, replayed once bound. */
  bufferedConfigOptions: Array<{ configId: string; value: string }>;
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

export class AcpGateway implements Agent {
  private readonly clients = new Map<string, GatewayClientState>();
  private readonly sessions = new Map<string, GatewaySession>();
  private readonly defaultAgentName: string;
  private readonly log: (message: string) => void;
  private connection?: AgentConnection;

  constructor(
    agents: Array<{ name: string; client: AcpClient }>,
    defaultAgentName: string,
    log: (message: string) => void = () => {},
  ) {
    if (agents.length === 0) {
      throw new Error("Gateway requires at least one agent");
    }
    for (const agent of agents) {
      this.clients.set(agent.name, {
        name: agent.name,
        client: agent.client,
        sessionRoutes: new Map<string, string>(),
      });
    }
    if (!this.clients.has(defaultAgentName)) {
      throw new Error(`Default agent is not part of the gateway: ${defaultAgentName}`);
    }
    this.defaultAgentName = defaultAgentName;
    this.log = log;
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

  /** Records the result of probing a backend (see runAcpGateway). */
  setBackendDiscovery(agentName: string, discovery: BackendDiscovery): void {
    this.requireClient(agentName).discovery = discovery;
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
      return this.translateModeUpdate(state, session, record, update);
    }
    if (record.sessionUpdate === "config_option_update" && Array.isArray(record.configOptions)) {
      return this.translateConfigOptionUpdate(session, record);
    }
    return update;
  }

  private translateModeUpdate(
    state: GatewayClientState,
    session: GatewaySession,
    record: Record<string, unknown>,
    update: SessionNotification["update"],
  ): SessionNotification["update"] {
    const backendModeId =
      typeof record.currentModeId === "string" ? record.currentModeId : undefined;
    const unified =
      backendModeId && state.discovery
        ? toUnifiedPermission(backendModeId, state.discovery.mode.advertisedIds)
        : undefined;
    if (!unified) {
      return update;
    }
    session.unifiedPermission = unified;
    return { ...record, currentModeId: unified } as SessionNotification["update"];
  }

  private translateConfigOptionUpdate(
    session: GatewaySession,
    record: Record<string, unknown>,
  ): SessionNotification["update"] {
    session.backendConfigOptions = record.configOptions as SessionConfigOption[];
    const models = modelStateFromSessionResponse({
      configOptions: session.backendConfigOptions,
      response: undefined,
    });
    if (models) {
      session.backendModels = models;
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
      bufferedConfigOptions: [],
    };

    if (requestedName) {
      // Compatibility: an explicit _meta agent binds immediately, preserving the
      // pre-lazy behavior for clients that route by agent name.
      await this.createBoundSession(session, requestedName, params.cwd);
      this.sessions.set(gatewaySessionId, session);
      return { sessionId: gatewaySessionId, configOptions: this.boundConfigOptions(session) };
    }

    const defaultState = this.clients.get(this.defaultAgentName);
    if (defaultState?.discovery) {
      session.unifiedPermission = resolveUnifiedCurrentPermission(defaultState.discovery.mode);
    }
    this.sessions.set(gatewaySessionId, session);
    return { sessionId: gatewaySessionId, configOptions: this.preBindConfigOptions(session) };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const session = this.requireSession(params.sessionId);
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
    if (session.state && session.downstreamSessionId) {
      await session.state.client.closeSession(session.downstreamSessionId);
    }
    this.dropSession(session);
    return {};
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.requireSession(params.sessionId);
    if (!session.state || !session.downstreamSessionId) {
      await this.bindSession(session, this.defaultAgentName);
      // A client may have chosen a permission before prompting without a model.
      await this.replayBuffered(session);
    }
    return await session.state!.client.prompt(session.downstreamSessionId!, params.prompt);
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.requireSession(params.sessionId);
    if (!session.state || !session.downstreamSessionId) {
      return;
    }
    await session.state.client.cancel(session.downstreamSessionId);
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = this.requireSession(params.sessionId);
    await this.applyUnifiedMode(session, params.modeId);
    return {};
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const session = this.requireSession(params.sessionId);
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
    const created = await state.client.createSession(cwd);
    session.state = state;
    session.downstreamSessionId = created.sessionId;
    session.backendConfigOptions = created.configOptions ?? state.discovery?.configOptions ?? [];
    session.backendModels = created.models ?? state.discovery?.models;
    if (state.discovery) {
      session.unifiedPermission = resolveUnifiedCurrentPermission(state.discovery.mode);
    }
    state.sessionRoutes.set(created.sessionId, session.gatewaySessionId);
    this.log(`bound session ${session.gatewaySessionId} to agent ${agentName}`);
  }

  private async applyModelSelection(
    session: GatewaySession,
    ref: string,
  ): Promise<SetSessionConfigOptionResponse> {
    const { agentName, modelId } = this.resolveModelRef(ref);
    await this.bindSession(session, agentName);
    const state = session.state!;
    const models = session.backendModels ?? state.discovery?.models;
    if (!models) {
      throw new RequestError(
        INVALID_PARAMS_ERROR_CODE,
        `Agent "${agentName}" does not advertise selectable models`,
      );
    }
    const response = await state.client.setSessionModel(
      session.downstreamSessionId!,
      modelId,
      models,
    );
    this.updateBackendOptions(session, response);
    await this.replayBuffered(session);
    return { configOptions: this.boundConfigOptions(session) };
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
    const support = state.discovery?.mode;
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
      session.backendModels = models;
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
    const state = session.state;
    const options: SessionConfigOption[] = [];
    if (state && session.backendModels) {
      options.push(buildModelOption(state.name, session.backendModels));
    }
    options.push(buildUnifiedModeOption(session.unifiedPermission));
    for (const option of session.backendConfigOptions ?? []) {
      const record = asRecord(option);
      if (!record || isModelSelectOption(record) || isModeSelectOption(record)) {
        continue;
      }
      options.push(option);
    }
    return options;
  }

  private mergedModelOption(): SessionConfigOption | undefined {
    const options: Array<{ value: string; name: string }> = [];
    let current: string | undefined;
    for (const state of this.clients.values()) {
      const models = state.discovery?.models;
      if (!models) {
        continue;
      }
      for (const model of models.availableModels) {
        options.push({
          value: modelRef(state.name, model.modelId),
          name: `${state.name}: ${model.name}`,
        });
      }
      if (state.name === this.defaultAgentName) {
        current = modelRef(state.name, models.currentModelId);
      }
    }
    if (options.length === 0) {
      return undefined;
    }
    return {
      id: UNIFIED_MODEL_CONFIG_ID,
      name: "Model",
      category: "model",
      type: "select",
      currentValue: current ?? options[0].value,
      options,
    };
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

function dedupeAgents(agents: GatewayAgentSpec[]): GatewayAgentSpec[] {
  const seen = new Set<string>();
  const unique: GatewayAgentSpec[] = [];
  for (const agent of agents) {
    const key = JSON.stringify([agent.agentCommand, agent.agentArgv ?? [], agent.env ?? {}]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(agent);
  }
  return unique;
}

async function startAgents(
  states: GatewayClientState[],
  started: GatewayClientState[],
  log: (message: string) => void,
): Promise<void> {
  for (const state of states) {
    await state.client.start();
    started.push(state);
    log(`started agent: ${state.name}`);
  }
}

/**
 * Probes each backend once to learn its models and modes. The probe session is
 * closed when the backend supports it, otherwise it lingers route-less.
 *
 * A backend whose probe fails (for example an agent that needs auth before
 * `session/new`) is degraded rather than fatal: it is kept reachable via
 * `_meta.acpx.agent`, but contributes no models or modes to the merged surface.
 */
async function probeBackends(
  states: GatewayClientState[],
  gateway: AcpGateway,
  cwd: string,
  log: (message: string) => void,
): Promise<void> {
  for (const state of states) {
    let discovery: BackendDiscovery;
    try {
      const created = await state.client.createSession(cwd);
      discovery = {
        configOptions: created.configOptions ?? [],
        models: created.models,
        mode: resolveBackendModeSupport({
          configOptions: created.configOptions,
          modes: created.modes,
        }),
      };
      if (state.client.supportsCloseSession()) {
        await state.client.closeSession(created.sessionId);
      }
    } catch (error) {
      discovery = { configOptions: [], mode: { setPath: "none", advertisedIds: [] } };
      log(`probe failed for agent ${state.name}: ${String(error)} (no models advertised)`);
    }
    state.discovery = discovery;
    gateway.setBackendDiscovery(state.name, discovery);
    log(
      `probed agent ${state.name}: models=${discovery.models?.availableModels.length ?? 0} modes=${discovery.mode.advertisedIds.length} (${discovery.mode.setPath})`,
    );
  }
}

export async function runAcpGateway(options: RunAcpGatewayOptions): Promise<number> {
  const log = (message: string): void => {
    if (options.verbose) {
      process.stderr.write(`[acpx gateway] ${message}\n`);
    }
  };

  const agents = dedupeAgents(options.agents);
  if (agents.length === 0) {
    throw new Error("Gateway requires at least one agent");
  }

  let gatewayRef: AcpGateway | undefined;

  const states: GatewayClientState[] = [];
  for (const agent of agents) {
    const state: GatewayClientState = {
      name: agent.name,
      client: new AcpClient({
        agentCommand: agent.agentCommand,
        agentArgv: agent.agentArgv,
        cwd: options.cwd,
        permissionMode: options.permissionMode,
        ...(agent.env ? { sessionOptions: { env: agent.env } } : {}),
        verbose: options.verbose,
        suppressSdkConsoleErrors: true,
        onSessionUpdate: (notification) => {
          void gatewayRef?.relayUpdate(agent.name, notification).catch((error: unknown) => {
            log(`session update relay failed: ${String(error)}`);
          });
        },
      }),
      sessionRoutes: new Map<string, string>(),
    };
    states.push(state);
  }

  const gateway = new AcpGateway(
    states.map((state) => ({ name: state.name, client: state.client })),
    options.defaultAgent ?? states[0].name,
    log,
  );
  gatewayRef = gateway;

  const started: GatewayClientState[] = [];
  try {
    await startAgents(states, started, log);
    await probeBackends(states, gateway, options.cwd, log);
  } catch (error) {
    await Promise.allSettled(started.map((state) => state.client.close()));
    throw error;
  }

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      log("shutting down; retiring all agents");
      await Promise.allSettled(states.map((state) => state.client.close()));
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
