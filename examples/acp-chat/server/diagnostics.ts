import path from "node:path";
import type { AcpInspectableAgentRegistry } from "../../../src/agent-registry.js";
import {
  createAcpRuntime,
  createFileSessionStore,
  type AcpRuntime,
  type AcpRuntimeTurn,
} from "../../../src/runtime.js";
import { detectGatewayBackendNames } from "./agent-catalog.js";

export type DiagnosticPhaseStatus = "pending" | "running" | "ok" | "failed" | "skipped";

export type DiagnosticInit = {
  status: DiagnosticPhaseStatus;
  ms?: number;
  error?: string;
};

export type DiagnosticModels = {
  status: DiagnosticPhaseStatus;
  names: string[];
  error?: string;
};

export type DiagnosticPing = {
  status: DiagnosticPhaseStatus;
  ms?: number;
  reply?: string;
  error?: string;
};

export type DiagnosticBackend = {
  name: string;
  status: DiagnosticPhaseStatus;
  names: string[];
  error?: string;
};

export type AgentDiagnostic = {
  name: string;
  argv?: string[];
  init: DiagnosticInit;
  models: DiagnosticModels;
  ping: DiagnosticPing;
  /** Present when the agent is an acpx gateway: models per backend agent. */
  isGateway?: boolean;
  backends?: DiagnosticBackend[];
};

export type DiagnosticsRun = {
  id: number;
  startedAt: number;
  finishedAt?: number;
  agents: AgentDiagnostic[];
};

export type AgentSpecInput = {
  name: string;
  argv?: string[];
};

export type DiagnosticsRunnerOptions = {
  cwd: string;
  stateDir: string;
  registry: AcpInspectableAgentRegistry;
  verbose?: boolean;
};

const INIT_TIMEOUT_MS = 60_000;
const PING_TIMEOUT_MS = 120_000;
const GATEWAY_DISCOVERY_TIMEOUT_MS = 10_000;
const DISCOVERY_POLL_INTERVAL_MS = 100;
const DIAGNOSTIC_CONCURRENCY = 3;
const REPLY_PREVIEW_LIMIT = 200;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * One-click health checks for installed agents. Each agent runs three phases in
 * its own runtime session: `init` (spawn + ACP handshake), `models` (advertised
 * model list), and `ping` (an end-to-end prompt turn). Sessions are discarded
 * afterwards so diagnostics never pollute the page's persisted sessions.
 */
export class DiagnosticsRunner {
  private runtime: AcpRuntime | undefined;
  private current: DiagnosticsRun | undefined;
  private runCounter = 0;

  constructor(private readonly options: DiagnosticsRunnerOptions) {}

  get running(): boolean {
    return this.current !== undefined && this.current.finishedAt === undefined;
  }

  snapshot(): DiagnosticsRun | undefined {
    return this.current;
  }

  /** Starts a run; returns the existing run unchanged when one is active. */
  start(agentSpecs: readonly AgentSpecInput[]): DiagnosticsRun {
    if (this.running) {
      return this.current as DiagnosticsRun;
    }
    this.runCounter += 1;
    const run: DiagnosticsRun = {
      id: this.runCounter,
      startedAt: Date.now(),
      agents: agentSpecs.map((spec) => ({
        name: spec.name,
        ...(spec.argv ? { argv: [...spec.argv] } : {}),
        init: { status: "pending" },
        models: { status: "pending", names: [] },
        ping: { status: "pending" },
      })),
    };
    this.current = run;
    void this.execute(run);
    return run;
  }

  private execute(run: DiagnosticsRun): Promise<void> {
    const queue = [...run.agents];
    const workerCount = Math.min(DIAGNOSTIC_CONCURRENCY, queue.length);
    const workers = Array.from({ length: workerCount }, async () => {
      for (;;) {
        const agent = queue.shift();
        if (!agent) {
          return;
        }
        await this.testAgent(run, agent).catch((error: unknown) => {
          agent.init = { status: "failed", error: errorMessage(error) };
          agent.models = { status: "skipped", names: [] };
          agent.ping = { status: "skipped" };
        });
      }
    });
    return Promise.all(workers).then(() => {
      run.finishedAt = Date.now();
    });
  }

  /**
   * Reads the session's models, waiting up to `discoveryBudgetMs` when the
   * agent is a gateway: it answers `session/new` before its backends finish
   * probing and pushes the merged model list once they do.
   */
  private async readModelNames(
    runtime: AcpRuntime,
    handle: Parameters<AcpRuntime["close"]>[0]["handle"],
    discoveryBudgetMs: number,
  ): Promise<string[]> {
    const deadline = Date.now() + discoveryBudgetMs;
    for (;;) {
      const status = (await runtime.getStatus?.({ handle })) ?? undefined;
      const models = status?.models;
      const names = models
        ? (models.availableModels?.map((model) => model.name) ?? [...models.availableModelIds])
        : [];
      if (names.length > 0 || Date.now() >= deadline) {
        return names;
      }
      await new Promise((resolve) => setTimeout(resolve, DISCOVERY_POLL_INTERVAL_MS));
    }
  }

  private runtimeFor(): AcpRuntime {
    if (!this.runtime) {
      this.runtime = createAcpRuntime({
        cwd: this.options.cwd,
        sessionStore: createFileSessionStore({
          stateDir: path.join(this.options.stateDir, "diagnostics"),
        }),
        agentRegistry: this.options.registry,
        permissionMode: "approve-all",
        nonInteractivePermissions: "deny",
        verbose: this.options.verbose === true,
      });
    }
    return this.runtime;
  }

  private async testAgent(run: DiagnosticsRun, agent: AgentDiagnostic): Promise<void> {
    agent.init.status = "running";
    const runtime = this.runtimeFor();
    const sessionKey = `diag:${agent.name}:run${run.id}`;
    const t0 = Date.now();
    let handle;
    try {
      handle = await withTimeout(
        runtime.ensureSession({
          sessionKey,
          agent: agent.name,
          mode: "persistent",
          cwd: this.options.cwd,
        }),
        INIT_TIMEOUT_MS,
        "initialize",
      );
      agent.init = { status: "ok", ms: Date.now() - t0 };
    } catch (error) {
      agent.init = { status: "failed", ms: Date.now() - t0, error: errorMessage(error) };
      agent.models = { status: "skipped", names: [] };
      agent.ping = { status: "skipped" };
      return;
    }

    const backendNames = await detectGatewayBackendNames(agent.argv, this.options.cwd);
    const isGateway = backendNames !== undefined;

    agent.models.status = "running";
    try {
      const names = await this.readModelNames(
        runtime,
        handle,
        isGateway ? GATEWAY_DISCOVERY_TIMEOUT_MS : 0,
      );
      agent.models = { status: "ok", names };
    } catch (error) {
      agent.models = { status: "failed", names: [], error: errorMessage(error) };
    }

    // Gateway expansion: when the agent is an acpx gateway, enumerate every
    // backend agent's models through it via session/new _meta routing.
    if (isGateway) {
      agent.isGateway = true;
      agent.backends = backendNames.map((name) => ({ name, status: "pending", names: [] }));
      const gateway = this.runtimeFor();
      for (const backend of agent.backends) {
        backend.status = "running";
        try {
          const backendHandle = await withTimeout(
            gateway.ensureSession({
              sessionKey: `diag:${agent.name}:${run.id}:${backend.name}`,
              agent: agent.name,
              mode: "persistent",
              cwd: this.options.cwd,
              sessionOptions: { gatewayAgent: backend.name },
            }),
            INIT_TIMEOUT_MS,
            `backend ${backend.name}`,
          );
          const backendStatus = (await gateway.getStatus?.({ handle: backendHandle })) ?? undefined;
          const backendModels = backendStatus?.models;
          backend.names = backendModels
            ? (backendModels.availableModels?.map((model) => model.name) ?? [
                ...backendModels.availableModelIds,
              ])
            : [];
          backend.status = "ok";
          await gateway
            .close({
              handle: backendHandle,
              reason: "diagnostics_done",
              discardPersistentState: true,
            })
            .catch(() => {});
        } catch (error) {
          backend.status = "failed";
          backend.error = errorMessage(error);
        }
      }
    }

    agent.ping.status = "running";
    const t1 = Date.now();
    let turn: AcpRuntimeTurn;
    try {
      turn = runtime.startTurn({
        handle,
        text: "ping",
        mode: "prompt",
        requestId: `${sessionKey}:ping`,
      });
    } catch (error) {
      agent.ping = { status: "failed", ms: Date.now() - t1, error: errorMessage(error) };
      await this.closeHandle(runtime, handle);
      return;
    }

    let reply = "";
    const collect = (async () => {
      for await (const event of turn.events) {
        if (event.type === "text_delta" && event.stream !== "thought") {
          reply += event.text;
        }
      }
    })().catch(() => {});

    try {
      const result = await withTimeout(turn.result, PING_TIMEOUT_MS, "ping");
      await collect;
      agent.ping = {
        status: "ok",
        ms: Date.now() - t1,
        ...(reply.trim()
          ? { reply: reply.trim().slice(0, REPLY_PREVIEW_LIMIT) }
          : result.status === "completed" && result.stopReason
            ? { reply: result.stopReason }
            : {}),
      };
    } catch (error) {
      agent.ping = { status: "failed", ms: Date.now() - t1, error: errorMessage(error) };
    }
    await this.closeHandle(runtime, handle);
  }

  private async closeHandle(
    runtime: AcpRuntime,
    handle: Parameters<AcpRuntime["close"]>[0]["handle"],
  ): Promise<void> {
    await runtime
      .close({ handle, reason: "diagnostics_done", discardPersistentState: true })
      .catch(() => {});
  }
}
