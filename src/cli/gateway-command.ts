import fs from "node:fs/promises";
import path from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { renderArgvIdentity, splitCommandLine } from "../acp/client-process.js";
import type { GatewayAgentSpec } from "../acp/gateway.js";
import {
  normalizeAgentName,
  resolveAgentArgv,
  resolveAgentCommand as resolveAgentCommandFromRegistry,
  resolveCanonicalAgentName,
} from "../agent-registry.js";
import { isAgentDisabled, type ResolvedAcpxConfig, type ResolvedAgentConfig } from "./config.js";
import { parseNonEmptyValue, resolvePermissionMode } from "./flags.js";
import type { PermissionFlags } from "./flags.js";

export type GatewayFlags = PermissionFlags & {
  cwd?: string;
  verbose?: boolean;
  config?: string;
};

type GatewayFileAgentEntry = {
  name: string;
  agentCommand: string;
  agentArgv?: string[];
  enabledModels?: string[];
  isDefault: boolean;
};

type GatewayLaunchPlan = {
  agentCommand: string;
  agentArgv?: string[];
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(source: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function launchFromArgv(value: unknown, label: string, sourcePath: string): GatewayLaunchPlan {
  if (!isStringArray(value) || value.length === 0 || value[0].trim().length === 0) {
    throw new InvalidArgumentError(
      `Invalid gateway config ${label}.argv in ${sourcePath}: expected non-empty array of strings`,
    );
  }
  // agentArgv must carry the full argv (executable included) so that
  // resolveAgentCommandParts uses it verbatim; agentCommand is the identity string.
  return { agentCommand: renderArgvIdentity(value), agentArgv: [...value] };
}

function launchFromCommand(
  raw: Record<string, unknown>,
  label: string,
  sourcePath: string,
): GatewayLaunchPlan {
  const command = raw.command;
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new InvalidArgumentError(
      `Invalid gateway config ${label}.command in ${sourcePath}: expected non-empty string`,
    );
  }
  const trimmedCommand = command.trim();
  if (!hasOwn(raw, "args")) {
    return { agentCommand: trimmedCommand };
  }
  if (/[\s'"]/u.test(trimmedCommand)) {
    throw new InvalidArgumentError(
      `Invalid gateway config ${label}.command in ${sourcePath}: command must be an unquoted executable with no whitespace when args is present; migrate the complete launch to argv`,
    );
  }
  const args = raw.args;
  if (!isStringArray(args)) {
    throw new InvalidArgumentError(
      `Invalid gateway config ${label}.args in ${sourcePath}: expected array of strings`,
    );
  }
  const fullArgv = [trimmedCommand, ...args];
  return { agentCommand: renderArgvIdentity(fullArgv), agentArgv: fullArgv };
}

function resolveEntryLaunch(
  raw: Record<string, unknown>,
  label: string,
  sourcePath: string,
): GatewayLaunchPlan {
  const usesArgv = hasOwn(raw, "argv");
  if (usesArgv && (hasOwn(raw, "command") || hasOwn(raw, "args"))) {
    throw new InvalidArgumentError(
      `Invalid gateway config ${label} in ${sourcePath}: use argv alone, not command or args`,
    );
  }
  return usesArgv
    ? launchFromArgv(raw.argv, label, sourcePath)
    : launchFromCommand(raw, label, sourcePath);
}

function parseEntryDefault(
  raw: Record<string, unknown>,
  label: string,
  sourcePath: string,
): boolean {
  const isDefault = raw.default;
  if (isDefault !== undefined && isDefault !== true && isDefault !== false) {
    throw new InvalidArgumentError(
      `Invalid gateway config ${label}.default in ${sourcePath}: expected true or false`,
    );
  }
  return isDefault === true;
}

function parseGatewayFileAgentEntry(
  raw: unknown,
  index: number,
  sourcePath: string,
): GatewayFileAgentEntry {
  const label = `agents[${index}]`;
  if (!isObject(raw)) {
    throw new InvalidArgumentError(
      `Invalid gateway config ${label} in ${sourcePath}: expected object`,
    );
  }
  const name = raw.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new InvalidArgumentError(
      `Invalid gateway config ${label}.name in ${sourcePath}: expected non-empty string`,
    );
  }
  const launch = resolveEntryLaunch(raw, label, sourcePath);
  const enabledModels = parseEntryEnabledModels(raw.enabledModels, label, sourcePath);
  return {
    name,
    agentCommand: launch.agentCommand,
    ...(launch.agentArgv ? { agentArgv: launch.agentArgv } : {}),
    ...(enabledModels ? { enabledModels } : {}),
    isDefault: parseEntryDefault(raw, label, sourcePath),
  };
}

function parseEntryEnabledModels(
  value: unknown,
  label: string,
  sourcePath: string,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !isStringArray(value) ||
    value.length === 0 ||
    value.some((item) => item.trim().length === 0)
  ) {
    throw new InvalidArgumentError(
      `Invalid gateway config ${label}.enabledModels in ${sourcePath}: expected non-empty array of non-empty strings`,
    );
  }
  return [...new Set(value)];
}

export type ParsedGatewayConfig = {
  agents: GatewayAgentSpec[];
  defaultAgent: string;
};

function assertUniqueAgentNames(entries: GatewayFileAgentEntry[], sourcePath: string): void {
  const names = new Set<string>();
  for (const entry of entries) {
    if (names.has(entry.name)) {
      throw new InvalidArgumentError(
        `Invalid gateway config in ${sourcePath}: duplicate agent name "${entry.name}"`,
      );
    }
    names.add(entry.name);
  }
}

function resolveDefaultAgentName(entries: GatewayFileAgentEntry[], sourcePath: string): string {
  const defaults = entries.filter((entry) => entry.isDefault);
  if (defaults.length > 1) {
    throw new InvalidArgumentError(
      `Invalid gateway config in ${sourcePath}: only one agent may set default: true`,
    );
  }
  return (defaults[0] ?? entries[0]).name;
}

function toAgentSpecs(entries: GatewayFileAgentEntry[]): GatewayAgentSpec[] {
  return entries.map((entry) => ({
    name: entry.name,
    agentCommand: entry.agentCommand,
    ...(entry.agentArgv ? { agentArgv: entry.agentArgv } : {}),
    ...(entry.enabledModels ? { enabledModels: entry.enabledModels } : {}),
  }));
}

export function parseGatewayConfig(raw: unknown, sourcePath: string): ParsedGatewayConfig {
  if (!isObject(raw)) {
    throw new InvalidArgumentError(
      `Invalid gateway config in ${sourcePath}: expected a JSON object with an agents array`,
    );
  }
  const agentsRaw = raw.agents;
  if (!Array.isArray(agentsRaw) || agentsRaw.length === 0) {
    throw new InvalidArgumentError(
      `Invalid gateway config agents in ${sourcePath}: expected non-empty array`,
    );
  }
  const entries = agentsRaw.map((entry, index) =>
    parseGatewayFileAgentEntry(entry, index, sourcePath),
  );
  assertUniqueAgentNames(entries, sourcePath);
  return {
    agents: toAgentSpecs(entries),
    defaultAgent: resolveDefaultAgentName(entries, sourcePath),
  };
}

async function loadGatewayConfigFile(
  configPath: string,
): Promise<{ agents: GatewayAgentSpec[]; defaultAgent: string }> {
  let rawContent: string;
  try {
    rawContent = await fs.readFile(configPath, "utf8");
  } catch (error) {
    throw new InvalidArgumentError(
      `Cannot read gateway config ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(rawContent) as unknown;
  } catch (error) {
    throw new InvalidArgumentError(
      `Cannot parse gateway config ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseGatewayConfig(raw, configPath);
}

function resolveGatewayAgent(name: string, config: ResolvedAcpxConfig): GatewayAgentSpec {
  if (isAgentDisabled(config, name)) {
    throw new InvalidArgumentError(
      `Agent "${name}" is disabled (enabled: false) in ${config.globalPath}`,
    );
  }
  const normalizedAgentName = normalizeAgentName(name);
  const canonicalAgentName = resolveCanonicalAgentName(name);
  const configuredAgent = resolveConfiguredAgent(config, normalizedAgentName, canonicalAgentName);
  if (configuredAgent) {
    return toGatewayAgentSpec(name, configuredAgent);
  }
  const agentArgv = resolveAgentArgv(name);
  return {
    name,
    agentCommand: resolveAgentCommandFromRegistry(name),
    ...(agentArgv ? { agentArgv } : {}),
  };
}

function resolveConfiguredAgent(
  config: ResolvedAcpxConfig,
  normalizedAgentName: string,
  canonicalAgentName: string,
): ResolvedAgentConfig | undefined {
  if (Object.hasOwn(config.agents, normalizedAgentName)) {
    return config.agents[normalizedAgentName];
  }
  if (Object.hasOwn(config.agents, canonicalAgentName)) {
    return config.agents[canonicalAgentName];
  }
  return undefined;
}

/** True when the agent's launch argv runs an `acpx gateway` process. */
export function isGatewayProcessLaunch(agent: ResolvedAgentConfig): boolean {
  const argv = agent.argv ?? splitCommandTokens(agent.command);
  return argv.some((token) => token === "gateway");
}

function splitCommandTokens(command: string): string[] {
  try {
    const parsed = splitCommandLine(command);
    return [parsed.command, ...parsed.args];
  } catch {
    return [command];
  }
}

export type GatewayConfigSelection = {
  agents: GatewayAgentSpec[];
  defaultAgent: string;
  /** Merged-surface allowlist taken from the config's own `acpx gateway` entries. */
  gatewayEnabledModels?: string[];
};

/**
 * Every enabled config agent except gateway launches; the first entry in config
 * order is the default. Config agents whose launch runs an `acpx gateway`
 * process are excluded so a config-driven gateway does not spawn itself; their
 * `enabledModels` entries filter the merged model surface instead.
 */
export function resolveGatewayAgentsFromConfig(config: ResolvedAcpxConfig): GatewayConfigSelection {
  const specs: GatewayAgentSpec[] = [];
  const gatewayEnabledModels: string[] = [];
  for (const [name, entry] of Object.entries(config.agents)) {
    if (isGatewayProcessLaunch(entry)) {
      gatewayEnabledModels.push(...(entry.enabledModels ?? []));
      continue;
    }
    specs.push(toGatewayAgentSpec(name, entry));
  }
  if (specs.length === 0) {
    throw new InvalidArgumentError(
      `No agents to serve: define agents in ${config.globalPath} or ${config.projectPath}; agents whose launch runs an acpx gateway process are excluded to avoid recursion`,
    );
  }
  return {
    agents: specs,
    defaultAgent: specs[0].name,
    ...(gatewayEnabledModels.length > 0
      ? { gatewayEnabledModels: [...new Set(gatewayEnabledModels)] }
      : {}),
  };
}

function toGatewayAgentSpec(name: string, entry: ResolvedAgentConfig): GatewayAgentSpec {
  return {
    name,
    agentCommand: entry.command,
    ...(entry.argv ? { agentArgv: [...entry.argv] } : {}),
    ...(entry.env ? { env: { ...entry.env } } : {}),
    ...(entry.enabledModels ? { enabledModels: [...entry.enabledModels] } : {}),
  };
}

export function registerGatewayCommand(program: Command, config: ResolvedAcpxConfig): void {
  program
    .command("gateway")
    .description(
      "Serve multiple agents as one ACP server over stdio; route each session via session/new _meta {acpx:{agent}}",
    )
    .argument(
      "[agents...]",
      "Agent names or raw commands (the first agent is the default); omit to serve every enabled agent from the config",
    )
    .option("--config <path>", "Load gateway agents from a JSON config file", (value: string) =>
      parseNonEmptyValue("Gateway config", value),
    )
    .option("--cwd <dir>", "Working directory for agent processes", process.cwd())
    .option("--verbose", "Log gateway lifecycle events to stderr")
    .option("--approve-all", "Auto-approve all permission requests")
    .option("--approve-reads", "Auto-approve read/search requests and prompt for writes")
    .option("--deny-all", "Deny all permission requests")
    .action(async function (this: Command, agents: string[], flags: GatewayFlags) {
      if (flags.config !== undefined && agents.length > 0) {
        throw new InvalidArgumentError("Use either positional agents or --config, not both");
      }

      let specs: GatewayAgentSpec[];
      let defaultAgent: string | undefined;
      let gatewayEnabledModels: string[] | undefined;
      if (flags.config !== undefined) {
        const parsed = await loadGatewayConfigFile(flags.config);
        specs = parsed.agents;
        defaultAgent = parsed.defaultAgent;
      } else if (agents.length === 0) {
        const selection = resolveGatewayAgentsFromConfig(config);
        specs = selection.agents;
        defaultAgent = selection.defaultAgent;
        gatewayEnabledModels = selection.gatewayEnabledModels;
      } else {
        specs = agents.map((name) => resolveGatewayAgent(name, config));
      }

      const permissionMode = resolvePermissionMode(flags, config.defaultPermissions);
      const { runAcpGateway } = await import("../acp/gateway.js");
      process.exitCode = await runAcpGateway({
        agents: specs,
        ...(defaultAgent !== undefined ? { defaultAgent } : {}),
        ...(gatewayEnabledModels !== undefined ? { enabledModels: gatewayEnabledModels } : {}),
        cwd: path.resolve(flags.cwd ?? process.cwd()),
        permissionMode,
        verbose: flags.verbose === true,
      });
    });
}
