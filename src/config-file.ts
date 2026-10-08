import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Shared primitives for reading and writing acpx JSON config files.
 *
 * Writes are read-modify-write and preserve unknown top-level keys, so callers
 * (registry install, web settings) can safely edit `agents` without clobbering
 * unrelated config authored by hand.
 */

export type RawConfigFile = Record<string, unknown>;

export type AgentLaunchEntry = { argv?: string[]; command?: string };

export const SAFE_AGENT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/u;

export function isSafeAgentName(name: string): boolean {
  return SAFE_AGENT_NAME_PATTERN.test(name);
}

export function resolveGlobalConfigPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".acpx", "config.json");
}

export function projectConfigPath(cwd: string): string {
  return path.join(path.resolve(cwd), ".acpxrc.json");
}

export function isPlainObject(value: unknown): value is RawConfigFile {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function readRawConfigFile(configPath: string): Promise<RawConfigFile | undefined> {
  let payload: string;
  try {
    payload = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Config is not valid JSON (${configPath}): ${reason}`, { cause: error });
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`Config has an unexpected shape (${configPath}): expected a JSON object`);
  }
  return parsed;
}

/**
 * Atomically replaces the config file: writes a sibling temp file (0600) and
 * renames it over the target, so a crash mid-write cannot truncate the config.
 */
export async function writeRawConfigFile(configPath: string, config: RawConfigFile): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const tempPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    await fs.rename(tempPath, configPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

export function configAgentsObject(config: RawConfigFile): Record<string, unknown> {
  const agents = config.agents;
  if (agents == null) {
    const created: Record<string, unknown> = {};
    config.agents = created;
    return created;
  }
  if (!isPlainObject(agents)) {
    throw new Error("Config agents must be an object mapping agent names to launch definitions");
  }
  return agents;
}

export function upsertAgentEntry(config: RawConfigFile, name: string, entry: RawConfigFile): void {
  configAgentsObject(config)[name] = entry;
}

/** Returns false when the agent has no config entry to remove. */
export function removeAgentEntry(config: RawConfigFile, name: string): boolean {
  const agents = configAgentsObject(config);
  if (!Object.hasOwn(agents, name)) {
    return false;
  }
  delete agents[name];
  return true;
}

/**
 * Toggles `enabled` for an agent entry. Disabling keeps the existing launch
 * definition (so the command survives and can be re-enabled); enabling removes
 * the flag entirely, restoring the default (enabled).
 */
export function setAgentEnabled(config: RawConfigFile, name: string, enabled: boolean): void {
  const agents = configAgentsObject(config);
  const existing = agents[name];
  const entry = isPlainObject(existing) ? { ...existing } : {};
  if (enabled) {
    delete entry.enabled;
  } else {
    entry.enabled = false;
  }
  agents[name] = entry;
}

export function readAgentLaunchEntry(
  config: RawConfigFile | undefined,
  name: string,
): AgentLaunchEntry | undefined {
  const entry = readAgentEntry(config, name);
  if (!entry) {
    return undefined;
  }
  const argv = readStringArray(entry.argv);
  const command = typeof entry.command === "string" ? entry.command : undefined;
  if (!argv && !command) {
    return undefined;
  }
  return { ...(argv ? { argv } : {}), ...(command ? { command } : {}) };
}

function readAgentEntry(
  config: RawConfigFile | undefined,
  name: string,
): RawConfigFile | undefined {
  const agents = config?.agents;
  if (!isPlainObject(agents)) {
    return undefined;
  }
  const entry = agents[name];
  return isPlainObject(entry) ? entry : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((item): item is string => typeof item === "string");
}
