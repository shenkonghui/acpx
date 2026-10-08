import { splitCommandLine } from "../../../src/acp/client-process.js";
import {
  AGENT_ARGV_REGISTRY,
  listBuiltInAgents,
  normalizeAgentName,
} from "../../../src/agent-registry.js";
import { loadResolvedConfig } from "../../../src/cli/config.js";
import {
  configAgentsObject,
  isPlainObject,
  isSafeAgentName,
  readRawConfigFile,
  removeAgentEntry,
  resolveGlobalConfigPath,
  writeRawConfigFile,
  type RawConfigFile,
} from "../../../src/config-file.js";
import {
  isGatewayLaunch,
  loadGatewayAgents,
  type AgentAvailability,
  type AgentRequirement,
} from "./agent-catalog.js";
import type { LiveAgentRegistry } from "./live-registry.js";

export type SettingsAgentSource = "config" | "gateway-config" | "built-in";

export type SettingsAgent = {
  name: string;
  enabled: boolean;
  source: SettingsAgentSource;
  isBuiltIn: boolean;
  hasConfigEntry: boolean;
  /** False for project-shadowed or gateway-only rows, which the global config cannot change. */
  writable: boolean;
  argv: string[];
  env?: Record<string, string>;
  /** Built-in launch command, offered as a reset target. */
  defaultArgv?: string[];
  availability: AgentAvailability;
  requirements?: AgentRequirement[];
  isDefault: boolean;
  /** Model ids the user enabled for this agent; empty/absent means all models. */
  enabledModels?: string[];
  /** True when the launch command is an `acpx gateway` process; such rows cannot be disabled. */
  isGateway: boolean;
};

export type SettingsView = {
  agents: SettingsAgent[];
  globalPath: string;
  projectPath: string;
  writable: boolean;
};

export type SettingsMutation =
  | {
      action: "upsert";
      name: string;
      enabled?: boolean;
      argv?: string[];
      env?: Record<string, string> | null;
      /** null/empty clears the list (all models allowed); an array restricts to those ids. */
      enabledModels?: string[] | null;
    }
  | { action: "remove"; name: string };

export class SettingsError extends Error {
  constructor(
    readonly code: "unsafe_name" | "invalid_argv" | "invalid_env",
    message: string,
  ) {
    super(message);
    this.name = "SettingsError";
  }
}

/** Builds the settings rows for every agent the server knows about (including disabled ones). */
export async function buildSettingsView(params: {
  cwd: string;
  gatewayConfigPath?: string;
  registry: LiveAgentRegistry;
  builtInIds?: string[];
}): Promise<SettingsView> {
  const config = await loadResolvedConfig(params.cwd);
  const [globalRaw, projectRaw] = await Promise.all([
    readRawConfigFile(config.globalPath),
    readRawConfigFile(config.projectPath),
  ]);
  const gateway = await loadGatewayAgents(params.gatewayConfigPath);

  const builtInIds = params.builtInIds ?? listBuiltInAgents();
  const builtInKeys = new Set(builtInIds.map(normalizeAgentName));
  const disabledKeys = new Set(config.disabledAgents.map(normalizeAgentName));
  const globalEntries = normalizedEntries(globalRaw);
  const projectEntries = normalizedEntries(projectRaw);
  const gatewayEntries = new Map(
    (gateway?.agents ?? []).map((entry) => [normalizeAgentName(entry.name), entry]),
  );

  const names = new Map<string, string>();
  const addName = (name: string): void => {
    const key = normalizeAgentName(name);
    if (key && !names.has(key)) {
      names.set(key, name);
    }
  };
  for (const id of builtInIds) {
    addName(id);
  }
  for (const entry of globalEntries.values()) {
    addName(entry.name);
  }
  for (const entry of projectEntries.values()) {
    addName(entry.name);
  }
  for (const entry of gateway?.agents ?? []) {
    addName(entry.name);
  }

  const defaultKey = normalizeAgentName(config.defaultAgent);
  const agents: SettingsAgent[] = [];
  for (const [key, displayName] of names) {
    const globalEntry = globalEntries.get(key);
    const projectEntry = projectEntries.get(key);
    const gatewayEntry = gatewayEntries.get(key);
    const isBuiltIn = builtInKeys.has(key);
    const hasConfigEntry = globalEntry !== undefined || projectEntry !== undefined;
    const defaultArgv = isBuiltIn ? AGENT_ARGV_REGISTRY[key] : undefined;

    const launch: { argv: string[]; env?: Record<string, string> } | undefined =
      launchFromRaw(projectEntry?.entry) ??
      launchFromRaw(globalEntry?.entry) ??
      gatewayLaunch(gatewayEntry) ??
      (defaultArgv ? { argv: [...defaultArgv] } : undefined);

    const enabledModels =
      stringArray(projectEntry?.entry.enabledModels) ??
      stringArray(globalEntry?.entry.enabledModels) ??
      undefined;

    const inspection = params.registry.inspect(displayName);
    const availability: AgentAvailability =
      inspection === undefined
        ? "unknown"
        : inspection.launch.kind === "installed"
          ? "installed"
          : "missing";

    agents.push({
      name: displayName,
      enabled: !disabledKeys.has(key),
      source: hasConfigEntry ? "config" : gatewayEntry ? "gateway-config" : "built-in",
      isBuiltIn,
      hasConfigEntry,
      writable: !projectEntries.has(key) && (isBuiltIn || globalEntries.has(key)),
      argv: launch ? [...launch.argv] : [],
      ...(launch?.env ? { env: { ...launch.env } } : {}),
      ...(defaultArgv ? { defaultArgv: [...defaultArgv] } : {}),
      availability,
      ...(availability === "missing" && inspection?.launch.kind === "missing"
        ? {
            requirements: inspection.launch.requirements.map((item) => ({
              kind: item.kind,
              name: item.name,
            })),
          }
        : {}),
      ...(enabledModels ? { enabledModels } : {}),
      isGateway: isGatewayLaunch(launch?.argv),
      isDefault: key === defaultKey,
    });
  }

  agents.sort(
    (left, right) =>
      Number(right.enabled) - Number(left.enabled) || left.name.localeCompare(right.name),
  );

  return {
    agents,
    globalPath: config.globalPath,
    projectPath: config.projectPath,
    writable: true,
  };
}

/** Applies a settings mutation to the global config, preserving unknown fields. */
export async function applySettingsMutation(
  mutation: SettingsMutation,
  options: { homeDir?: string } = {},
): Promise<{ name: string }> {
  const name = normalizeAgentName(mutation.name);
  if (!name || !isSafeAgentName(name)) {
    throw new SettingsError("unsafe_name", `Invalid agent name: ${mutation.name}`);
  }

  const configPath = resolveGlobalConfigPath(options.homeDir);
  const raw = (await readRawConfigFile(configPath)) ?? {};

  if (mutation.action === "remove") {
    removeAgentEntry(raw, name);
    await writeRawConfigFile(configPath, raw);
    return { name };
  }

  if (mutation.argv !== undefined) {
    validateArgv(mutation.argv);
  }
  if (mutation.env !== undefined && mutation.env !== null) {
    validateEnv(mutation.env);
  }

  const agents = configAgentsObject(raw);
  const existingKey = Object.keys(agents).find((key) => normalizeAgentName(key) === name);
  const entry: RawConfigFile =
    existingKey !== undefined && isPlainObject(agents[existingKey])
      ? { ...agents[existingKey] }
      : {};

  if (mutation.argv !== undefined) {
    entry.argv = [...mutation.argv];
    // The parser rejects argv combined with the legacy command/args fields.
    delete entry.command;
    delete entry.args;
  }
  if (mutation.env !== undefined) {
    if (mutation.env === null || Object.keys(mutation.env).length === 0) {
      delete entry.env;
    } else {
      entry.env = { ...mutation.env };
    }
  }
  if (mutation.enabled !== undefined) {
    if (mutation.enabled) {
      delete entry.enabled;
    } else {
      entry.enabled = false;
    }
  }
  if (mutation.enabledModels !== undefined) {
    if (mutation.enabledModels === null || mutation.enabledModels.length === 0) {
      delete entry.enabledModels;
    } else {
      entry.enabledModels = [...new Set(mutation.enabledModels)];
    }
  }

  if (existingKey !== undefined && existingKey !== name) {
    delete agents[existingKey];
  }
  if (Object.keys(entry).length === 0) {
    delete agents[name];
  } else {
    agents[name] = entry;
  }

  await writeRawConfigFile(configPath, raw);
  return { name };
}

export function validateArgv(argv: unknown): string[] {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((arg) => typeof arg !== "string")) {
    throw new SettingsError("invalid_argv", "argv must be a non-empty array of strings");
  }
  const result: string[] = argv;
  if (result[0].trim().length === 0) {
    throw new SettingsError("invalid_argv", "argv[0] must be a non-empty executable");
  }
  return result;
}

export function validateEnv(env: unknown): Record<string, string> {
  if (!isPlainObject(env)) {
    throw new SettingsError("invalid_env", "env must be an object of string values");
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") {
      throw new SettingsError("invalid_env", `env.${key} must be a string`);
    }
    if (key.length === 0 || key.includes("=") || key.includes("\0")) {
      throw new SettingsError("invalid_env", `invalid environment name ${JSON.stringify(key)}`);
    }
    result[key] = value;
  }
  return result;
}

function normalizedEntries(
  raw: RawConfigFile | undefined,
): Map<string, { name: string; entry: Record<string, unknown> }> {
  const result = new Map<string, { name: string; entry: Record<string, unknown> }>();
  const agents = raw?.agents;
  if (!isPlainObject(agents)) {
    return result;
  }
  for (const [name, entry] of Object.entries(agents)) {
    const key = normalizeAgentName(name);
    if (key && !result.has(key) && isPlainObject(entry)) {
      result.set(key, { name, entry });
    }
  }
  return result;
}

function launchFromRaw(
  entry: Record<string, unknown> | undefined,
): { argv: string[]; env?: Record<string, string> } | undefined {
  if (!entry) {
    return undefined;
  }
  const argv = stringArray(entry.argv);
  const command = typeof entry.command === "string" ? entry.command : undefined;
  const resolvedArgv = argv ?? (command ? splitCommandOrRaw(command) : undefined);
  if (!resolvedArgv || resolvedArgv.length === 0) {
    return undefined;
  }
  const env = stringRecord(entry.env);
  return { argv: resolvedArgv, ...(env ? { env } : {}) };
}

function gatewayLaunch(
  entry: { agentArgv?: string[]; agentCommand: string } | undefined,
): { argv: string[] } | undefined {
  if (!entry) {
    return undefined;
  }
  return { argv: [...(entry.agentArgv ?? splitCommandOrRaw(entry.agentCommand))] };
}

function splitCommandOrRaw(command: string): string[] {
  try {
    const parsed = splitCommandLine(command);
    return [parsed.command, ...parsed.args];
  } catch {
    return [command];
  }
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const result = value.filter((item): item is string => typeof item === "string");
  return result.length === value.length ? result : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      result[key] = item;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Reads the agent's enabled-model allowlist from the global config.
 * Returns undefined when unset (all models allowed) or the agent has no entry.
 */
export async function readEnabledModels(
  agent: string,
  options: { homeDir?: string } = {},
): Promise<string[] | undefined> {
  const name = normalizeAgentName(agent);
  if (!name) {
    return undefined;
  }
  const configPath = resolveGlobalConfigPath(options.homeDir);
  const raw = await readRawConfigFile(configPath).catch(() => undefined);
  const agents = raw?.agents;
  if (!isPlainObject(agents)) {
    return undefined;
  }
  const key = Object.keys(agents).find((candidate) => normalizeAgentName(candidate) === name);
  if (key === undefined) {
    return undefined;
  }
  const entry = agents[key];
  if (!isPlainObject(entry)) {
    return undefined;
  }
  return stringArray(entry.enabledModels);
}
