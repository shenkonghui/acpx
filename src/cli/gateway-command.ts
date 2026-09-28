import fs from "node:fs/promises";
import path from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { renderArgvIdentity } from "../acp/client-process.js";
import type { GatewayAgentSpec } from "../acp/gateway.js";
import {
  normalizeAgentName,
  resolveAgentArgv,
  resolveAgentCommand as resolveAgentCommandFromRegistry,
  resolveCanonicalAgentName,
} from "../agent-registry.js";
import type { ResolvedAcpxConfig } from "./config.js";
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
  return {
    name,
    agentCommand: launch.agentCommand,
    ...(launch.agentArgv ? { agentArgv: launch.agentArgv } : {}),
    isDefault: parseEntryDefault(raw, label, sourcePath),
  };
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
  const normalizedAgentName = normalizeAgentName(name);
  const canonicalAgentName = resolveCanonicalAgentName(name);
  const configuredAgent = Object.hasOwn(config.agents, normalizedAgentName)
    ? config.agents[normalizedAgentName]
    : Object.hasOwn(config.agents, canonicalAgentName)
      ? config.agents[canonicalAgentName]
      : undefined;
  if (configuredAgent) {
    return {
      name,
      agentCommand: configuredAgent.command,
      ...(configuredAgent.argv ? { agentArgv: [...configuredAgent.argv] } : {}),
    };
  }
  const agentArgv = resolveAgentArgv(name);
  return {
    name,
    agentCommand: resolveAgentCommandFromRegistry(name),
    ...(agentArgv ? { agentArgv } : {}),
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
      "Agent names or raw commands (the first agent is the default; or use --config)",
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
      if (flags.config !== undefined) {
        const parsed = await loadGatewayConfigFile(flags.config);
        specs = parsed.agents;
        defaultAgent = parsed.defaultAgent;
      } else {
        if (agents.length === 0) {
          throw new InvalidArgumentError(
            "At least one agent is required (positional agents or --config)",
          );
        }
        specs = agents.map((name) => resolveGatewayAgent(name, config));
      }

      const permissionMode = resolvePermissionMode(flags, config.defaultPermissions);
      const { runAcpGateway } = await import("../acp/gateway.js");
      process.exitCode = await runAcpGateway({
        agents: specs,
        ...(defaultAgent !== undefined ? { defaultAgent } : {}),
        cwd: path.resolve(flags.cwd ?? process.cwd()),
        permissionMode,
        verbose: flags.verbose === true,
      });
    });
}
