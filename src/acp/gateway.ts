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
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
} from "@agentclientprotocol/sdk";
import { EXIT_CODES, type PermissionMode } from "../types.js";
import { AcpClient } from "./client.js";
import { asRecord } from "./jsonrpc.js";

const GATEWAY_SESSION_PREFIX = "gw-";
const AGENT_META_KEY = "acpx";
const AGENT_META_AGENT_FIELD = "agent";
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

type GatewayClientState = {
  name: string;
  client: AcpClient;
  /** downstream session id -> gateway session id */
  sessionRoutes: Map<string, string>;
};

type RoutedSession = {
  gatewaySessionId: string;
  downstreamSessionId: string;
  state: GatewayClientState;
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

export class AcpGateway implements Agent {
  private readonly clients = new Map<string, GatewayClientState>();
  private readonly routes = new Map<string, RoutedSession>();
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
    return this.routes.size;
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

  private requireRoute(sessionId: string): RoutedSession {
    const route = this.routes.get(sessionId);
    if (!route) {
      throw unknownGatewaySessionError(sessionId);
    }
    return route;
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
      update: notification.update,
    });
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
    const agentName = requestedName ?? this.defaultAgentName;
    const state = this.requireClient(agentName);

    const created = await state.client.createSession(params.cwd);
    const gatewaySessionId = `${GATEWAY_SESSION_PREFIX}${randomUUID()}`;
    this.routes.set(gatewaySessionId, {
      gatewaySessionId,
      downstreamSessionId: created.sessionId,
      state,
    });
    state.sessionRoutes.set(created.sessionId, gatewaySessionId);

    const response: NewSessionResponse = { sessionId: gatewaySessionId };
    if (created.configOptionsPresent) {
      response.configOptions = created.configOptions;
    }
    return response;
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const route = this.requireRoute(params.sessionId);
    await route.state.client.loadSession(route.downstreamSessionId, params.cwd);
    return {};
  }

  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    const route = this.requireRoute(params.sessionId);
    await route.state.client.resumeSession(route.downstreamSessionId, params.cwd);
    return {};
  }

  async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    const route = this.requireRoute(params.sessionId);
    await route.state.client.closeSession(route.downstreamSessionId);
    this.dropRoute(route);
    return {};
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const route = this.requireRoute(params.sessionId);
    return await route.state.client.prompt(route.downstreamSessionId, params.prompt);
  }

  async cancel(_params: CancelNotification): Promise<void> {
    const route = this.requireRoute(_params.sessionId);
    await route.state.client.cancel(route.downstreamSessionId);
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const route = this.requireRoute(params.sessionId);
    await route.state.client.setSessionMode(route.downstreamSessionId, params.modeId);
    return {};
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const route = this.requireRoute(params.sessionId);
    const rawValue = typeof params.value === "boolean" ? String(params.value) : params.value;
    return await route.state.client.setSessionConfigOption(
      route.downstreamSessionId,
      params.configId,
      rawValue,
      undefined,
    );
  }

  async extMethod(method: string): Promise<never> {
    throw new RequestError(METHOD_NOT_FOUND_ERROR_CODE, `Unsupported gateway method: ${method}`);
  }

  private dropRoute(route: RoutedSession): void {
    this.routes.delete(route.gatewaySessionId);
    route.state.sessionRoutes.delete(route.downstreamSessionId);
  }
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
    for (const state of states) {
      await state.client.start();
      started.push(state);
      log(`started agent: ${state.name}`);
    }
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
