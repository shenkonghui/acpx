import fs from "node:fs/promises";
import path from "node:path";
import {
  listBuiltInAgents,
  normalizeAgentName,
  type AcpAgentInspection,
} from "../../../src/agent-registry.js";
import { loadResolvedConfig } from "../../../src/cli/config.js";
import {
  parseGatewayConfig,
  resolveGatewayAgentsFromConfig,
} from "../../../src/cli/gateway-command.js";
import type { AdHocAgent, LiveAgentRegistry } from "./live-registry.js";

export type AgentAvailability = "installed" | "missing" | "unknown";

export type AgentSource = "config" | "built-in" | "gateway-config" | "ad-hoc";

export type AgentRequirement = {
  kind: "command" | "package";
  name: string;
};

export type AgentSummary = {
  id: string;
  name: string;
  source: AgentSource;
  availability: AgentAvailability;
  launch?: {
    argv: string[];
  };
  requirements?: AgentRequirement[];
  isDefault: boolean;
  /** False when the agent is explicitly disabled in config; only settings rows set this. */
  enabled?: boolean;
};

export type AgentCatalog = {
  agents: AgentSummary[];
  /** Registry overrides (name -> command or argv) used to spawn each listed agent. */
  overrides: Record<string, string | string[]>;
  defaultAgent: string;
};

export type AgentCatalogOptions = {
  cwd: string;
  /** Optional `acpx gateway --config` style JSON file with extra agent entries. */
  gatewayConfigPath?: string;
};

type ConfigAgentEntry = {
  command: string;
  argv?: string[];
  env?: Record<string, string>;
};

export type GatewayAgentEntry = {
  name: string;
  agentCommand: string;
  agentArgv?: string[];
};

export type AgentSourceEntry = {
  id: string;
  source: AgentSource;
  /** Present for config/gateway entries; built-ins resolve through their own definitions. */
  override?: string | string[];
};

const SOURCE_ORDER: Record<AgentSource, number> = {
  config: 0,
  "gateway-config": 1,
  "built-in": 2,
  "ad-hoc": 3,
};

/**
 * Rebuilds the catalog from the current config on every call so newly installed agents
 * (and ad-hoc commands registered on the live registry) appear without a restart.
 */
export class LiveAgentCatalog {
  constructor(
    private readonly registry: LiveAgentRegistry,
    private readonly options: AgentCatalogOptions,
  ) {}

  async build(): Promise<AgentCatalog> {
    const config = await loadResolvedConfig(this.options.cwd);
    const gateway = await loadGatewayAgents(this.options.gatewayConfigPath);
    const collected = collectAgentSources({
      configAgents: config.agents,
      configDefaultAgent: config.defaultAgent,
      disabledAgents: config.disabledAgents,
      ...(gateway ? { gateway } : {}),
      builtInIds: listBuiltInAgents(),
    });
    this.registry.setConfigOverrides(collected.overrides);
    this.registry.setConfigEnvs(collected.envs);

    return {
      agents: summarizeAgentSources(
        collected.sources,
        collected.defaultAgent,
        (id) => this.registry.inspect(id),
        this.registry.listAdHoc(),
      ),
      overrides: collected.overrides,
      defaultAgent: collected.defaultAgent,
    };
  }
}

/**
 * Resolves the ordered agent list and registry overrides. Config-defined agents win over
 * gateway-config entries, which win over built-ins when names collide (case-insensitive).
 */
export function collectAgentSources(params: {
  configAgents: Record<string, ConfigAgentEntry>;
  configDefaultAgent: string;
  /** Normalized names explicitly disabled with `enabled: false`. */
  disabledAgents?: string[];
  gateway?: {
    agents: GatewayAgentEntry[];
    defaultAgent: string;
  };
  builtInIds: string[];
}): {
  sources: AgentSourceEntry[];
  overrides: Record<string, string | string[]>;
  envs: Record<string, Record<string, string>>;
  defaultAgent: string;
} {
  const sources: AgentSourceEntry[] = [];
  const overrides: Record<string, string | string[]> = {};
  const envs: Record<string, Record<string, string>> = {};
  const seen = new Set<string>();
  const disabled = new Set((params.disabledAgents ?? []).map(normalizeAgentName));

  const add = (
    id: string,
    source: AgentSource,
    override?: string | string[],
    env?: Record<string, string>,
  ): void => {
    const key = normalizeAgentName(id);
    if (!key || seen.has(key) || disabled.has(key)) {
      return;
    }
    seen.add(key);
    if (override !== undefined) {
      overrides[key] = override;
    }
    if (env && Object.keys(env).length > 0) {
      envs[key] = { ...env };
    }
    sources.push({ id, source, ...(override !== undefined ? { override } : {}) });
  };

  for (const [name, entry] of Object.entries(params.configAgents)) {
    add(name, "config", entry.argv ?? entry.command, entry.env);
  }
  for (const entry of params.gateway?.agents ?? []) {
    add(entry.name, "gateway-config", entry.agentArgv ?? entry.agentCommand);
  }
  for (const id of params.builtInIds) {
    add(id, "built-in");
  }

  return {
    sources,
    overrides,
    envs,
    defaultAgent: params.gateway?.defaultAgent ?? params.configDefaultAgent,
  };
}

export function summarizeAgentSources(
  sources: AgentSourceEntry[],
  defaultAgent: string,
  inspect: (id: string) => AcpAgentInspection | undefined,
  adHoc: AdHocAgent[] = [],
): AgentSummary[] {
  const defaultKey = normalizeAgentName(defaultAgent);
  const agents: AgentSummary[] = sources.map((source) => {
    const inspection = inspect(source.id);
    return {
      id: source.id,
      name: inspection?.name ?? source.id,
      source: source.source,
      ...summarizeAvailability(inspection),
      isDefault: normalizeAgentName(source.id) === defaultKey,
    } satisfies AgentSummary;
  });

  for (const entry of adHoc) {
    agents.push({
      id: entry.name,
      name: entry.argv.join(" "),
      source: "ad-hoc",
      availability: "installed",
      launch: { argv: [...entry.argv] },
      isDefault: normalizeAgentName(entry.name) === defaultKey,
    });
  }

  agents.sort(
    (left, right) =>
      SOURCE_ORDER[left.source] - SOURCE_ORDER[right.source] || left.name.localeCompare(right.name),
  );
  return agents;
}

function summarizeAvailability(
  inspection: AcpAgentInspection | undefined,
): Pick<AgentSummary, "availability" | "launch" | "requirements"> {
  if (!inspection) {
    return { availability: "unknown" };
  }
  if (inspection.launch.kind === "installed") {
    return { availability: "installed", launch: { argv: [...inspection.launch.argv] } };
  }
  return {
    availability: "missing",
    requirements: inspection.launch.requirements.map((requirement) => ({ ...requirement })),
  };
}

export async function loadGatewayAgents(
  gatewayConfigPath: string | undefined,
): Promise<{ agents: GatewayAgentEntry[]; defaultAgent: string } | undefined> {
  if (!gatewayConfigPath) {
    return undefined;
  }
  let raw: string;
  try {
    raw = await fs.readFile(gatewayConfigPath, "utf8");
  } catch (error) {
    throw new Error(
      `Failed to read agents config ${gatewayConfigPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid JSON in agents config ${gatewayConfigPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const config = parseGatewayConfig(parsed, gatewayConfigPath);
  return { agents: config.agents, defaultAgent: config.defaultAgent };
}

/** True when the argv launches an `acpx gateway` process (with or without --config). */
export function isGatewayLaunch(argv: string[] | undefined): boolean {
  return Boolean(argv?.some((token) => token === "gateway"));
}

/**
 * Backend agent names behind a gateway launch argv, or undefined when the argv
 * is not a gateway. Legacy `--config <file>` argv reads the JSON file; a plain
 * gateway argv resolves backends from the main config at `cwd`. Any failure
 * returns undefined so callers degrade to single-backend probing.
 */
export async function detectGatewayBackendNames(
  argv: string[] | undefined,
  cwd: string,
): Promise<string[] | undefined> {
  if (!argv || !isGatewayLaunch(argv)) {
    return undefined;
  }
  const configIndex = argv.indexOf("--config");
  if (configIndex >= 0) {
    const configPath = argv[configIndex + 1];
    if (!configPath) {
      return undefined;
    }
    try {
      const raw: unknown = JSON.parse(await fs.readFile(path.resolve(cwd, configPath), "utf8"));
      return parseGatewayConfig(raw, configPath).agents.map((spec) => spec.name);
    } catch {
      return undefined;
    }
  }
  try {
    const config = await loadResolvedConfig(cwd);
    return resolveGatewayAgentsFromConfig(config).agents.map((spec) => spec.name);
  } catch {
    return undefined;
  }
}
