import path from "node:path";
import type { AcpInspectableAgentRegistry } from "../../../src/agent-registry.js";
import { createAcpRuntime, createFileSessionStore, type AcpRuntime } from "../../../src/runtime.js";
import { detectGatewayBackendNames } from "./agent-catalog.js";

export type ProbedModel = { modelId: string; name: string };

export type ModelProbeResult = {
  models: ProbedModel[];
  /** True when the agent is an acpx gateway; models are the union across backends. */
  isGateway: boolean;
};

export type ModelProbeOptions = {
  cwd: string;
  stateDir: string;
  registry: AcpInspectableAgentRegistry;
  verbose?: boolean;
};

const PROBE_TIMEOUT_MS = 60_000;

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
 * Spawns an agent in a throwaway ACP session to list its advertised models.
 * For `acpx gateway` launches, every backend's models are probed through
 * `session/new` `_meta` routing and merged into one deduplicated list.
 */
export class ModelProbeRunner {
  private runtime: AcpRuntime | undefined;
  /** One runtime per gateway backend; each spawns gateways limited to that backend. */
  private backendRuntimes = new Map<string, AcpRuntime>();

  constructor(private readonly options: ModelProbeOptions) {}

  async probe(agent: string): Promise<ModelProbeResult> {
    const runtime = this.runtimeFor();
    const sessionKey = `probe:${agent}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

    // Gateway launches skip the default-backend session entirely: every model
    // comes from explicit per-backend probes.
    const inspection = this.options.registry.inspect(agent);
    const argv = inspection?.launch.kind === "installed" ? inspection.launch.argv : undefined;
    const backends = await detectGatewayBackendNames(argv, this.options.cwd);
    if (backends !== undefined) {
      // A failing backend (missing executable, auth error) must not sink the
      // whole probe; the union just skips its models.
      const backendResults = await Promise.all(
        backends.map((backend) =>
          this.probeBackend(agent, `${sessionKey}:${backend}`, backend).catch(() => undefined),
        ),
      );
      // Results stay in backend order, so the merged order is deterministic.
      const merged = new Map<string, ProbedModel>();
      for (const backendModels of backendResults) {
        if (backendModels === undefined) {
          continue;
        }
        for (const model of backendModels) {
          if (!merged.has(model.modelId)) {
            merged.set(model.modelId, model);
          }
        }
      }
      return { models: [...merged.values()], isGateway: true };
    }

    const handle = await withTimeout(
      runtime.ensureSession({
        sessionKey,
        agent,
        mode: "persistent",
        cwd: this.options.cwd,
      }),
      PROBE_TIMEOUT_MS,
      "initialize",
    );
    try {
      return { models: await this.modelsFor(runtime, handle), isGateway: false };
    } finally {
      await runtime
        .close({ handle, reason: "probe_done", discardPersistentState: true })
        .catch(() => {});
    }
  }

  private async probeBackend(
    agent: string,
    sessionKey: string,
    backend: string,
  ): Promise<ProbedModel[]> {
    const runtime = this.runtimeForBackend(backend);
    const backendHandle = await withTimeout(
      runtime.ensureSession({
        sessionKey,
        agent,
        mode: "persistent",
        cwd: this.options.cwd,
        sessionOptions: { gatewayAgent: backend },
      }),
      PROBE_TIMEOUT_MS,
      `backend ${backend}`,
    );
    try {
      return await this.modelsFor(runtime, backendHandle);
    } finally {
      await runtime
        .close({ handle: backendHandle, reason: "probe_done", discardPersistentState: true })
        .catch(() => {});
    }
  }

  private async modelsFor(
    runtime: AcpRuntime,
    handle: Parameters<AcpRuntime["close"]>[0]["handle"],
  ) {
    const status = (await runtime.getStatus?.({ handle })) ?? undefined;
    const models = status?.models;
    if (!models) {
      return [];
    }
    return models.availableModels
      ? models.availableModels.map((model) => ({
          modelId: model.modelId,
          name: model.name,
        }))
      : models.availableModelIds.map((modelId) => ({ modelId, name: modelId }));
  }

  private runtimeFor(): AcpRuntime {
    if (!this.runtime) {
      this.runtime = this.createRuntime(this.options.registry);
    }
    return this.runtime;
  }

  /**
   * A runtime whose gateways serve only `backend`: the backend name is appended
   * as a positional `acpx gateway` argument, so a probe does not boot every
   * configured backend just to reach one of them.
   */
  private runtimeForBackend(backend: string): AcpRuntime {
    const existing = this.backendRuntimes.get(backend);
    if (existing) {
      return existing;
    }
    const base = this.options.registry;
    const scoped: AcpInspectableAgentRegistry = {
      resolve: (agentName: string) => {
        const resolved = base.resolve(agentName);
        return Array.isArray(resolved) && resolved.includes("gateway")
          ? [...resolved, backend]
          : resolved;
      },
      list: () => base.list(),
      inspect: (agentId: string) => {
        const inspection = base.inspect(agentId);
        if (inspection?.launch.kind === "installed" && inspection.launch.argv.includes("gateway")) {
          return {
            ...inspection,
            launch: { kind: "installed" as const, argv: [...inspection.launch.argv, backend] },
          };
        }
        return inspection;
      },
    };
    const runtime = this.createRuntime(scoped);
    this.backendRuntimes.set(backend, runtime);
    return runtime;
  }

  private createRuntime(registry: AcpInspectableAgentRegistry): AcpRuntime {
    return createAcpRuntime({
      cwd: this.options.cwd,
      sessionStore: createFileSessionStore({
        stateDir: path.join(this.options.stateDir, "model-probe"),
      }),
      agentRegistry: registry,
      permissionMode: "approve-all",
      nonInteractivePermissions: "deny",
      verbose: this.options.verbose === true,
    });
  }
}
