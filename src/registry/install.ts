import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { AGENT_REGISTRY, normalizeAgentName } from "../agent-registry.js";
import {
  isSafeAgentName,
  readAgentLaunchEntry,
  readRawConfigFile,
  removeAgentEntry,
  resolveGlobalConfigPath,
  upsertAgentEntry,
  writeRawConfigFile,
  type AgentLaunchEntry,
  type RawConfigFile,
} from "../config-file.js";
import { AcpxOperationalError } from "../errors.js";
import { resolveInstalledExecutable } from "../spawn-command-options.js";
import {
  registryPlatformKey,
  selectInstallMethod,
  type RegistryAgent,
  type RegistryBinaryPlatform,
  type RegistryEnv,
  type RegistryInstallMethod,
} from "./types.js";

export const DEFAULT_ARCHIVE_DOWNLOAD_TIMEOUT_MS = 600_000;

export type InstallOptions = {
  asName?: string;
  method?: RegistryInstallMethod;
  force?: boolean;
  homeDir?: string;
  fetchImpl?: typeof fetch;
  downloadTimeoutMs?: number;
  platform?: NodeJS.Platform;
  arch?: string;
  log?: (message: string) => void;
};

export type InstallResult = {
  agentId: string;
  registeredName: string;
  version: string;
  method: RegistryInstallMethod;
  argv: string[];
  env?: RegistryEnv;
  installDir?: string;
  archiveUrl?: string;
  reused: boolean;
  replacedConfigEntry: boolean;
  warnings: string[];
};

export type UninstallResult = {
  registeredName: string;
  removedConfigEntry: boolean;
  removedInstallDir?: string;
};

export function defaultRegistryConfigPath(homeDir: string = os.homedir()): string {
  return resolveGlobalConfigPath(homeDir);
}

export function defaultRegistryAgentsRoot(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".acpx", "agents");
}

type ResolvedInstall = {
  argv: string[];
  env?: RegistryEnv;
  installDir?: string;
  archiveUrl?: string;
  reused: boolean;
};

function requirePlatformKey(options: InstallOptions): string {
  const platformKey = registryPlatformKey(options.platform, options.arch);
  if (!platformKey) {
    throw new AcpxOperationalError(
      `Unsupported platform for registry installs: ${options.platform ?? process.platform}-${options.arch ?? process.arch}`,
      { origin: "cli", detailCode: "REGISTRY_PLATFORM_UNSUPPORTED" },
    );
  }
  return platformKey;
}

async function collectInstallWarnings(
  configPath: string,
  registeredName: string,
): Promise<{ warnings: string[]; replacedConfigEntry: boolean }> {
  const warnings: string[] = [];
  const replacedConfigEntry = await hasConfigAgentEntry(configPath, registeredName);
  if (replacedConfigEntry) {
    warnings.push(`replacing existing agents.${registeredName} config entry`);
  }
  if (Object.hasOwn(AGENT_REGISTRY, registeredName)) {
    warnings.push(
      `registry agent will override built-in ${registeredName} (config agents take precedence); use --as to install under another name`,
    );
  }
  return { warnings, replacedConfigEntry };
}

async function installDistribution(
  agent: RegistryAgent,
  method: RegistryInstallMethod,
  platformKey: string,
  options: ResolvedInstallOptions,
  warnings: string[],
): Promise<ResolvedInstall> {
  if (method === "binary") {
    return installBinaryMethod(agent, platformKey, options, warnings);
  }
  return installPackageMethod(agent, method, platformKey);
}

async function installBinaryMethod(
  agent: RegistryAgent,
  platformKey: string,
  options: ResolvedInstallOptions,
  warnings: string[],
): Promise<ResolvedInstall> {
  const platformEntry = agent.distribution.binary?.[platformKey];
  if (!platformEntry) {
    throw unsupportedDistributionError(agent, options.method, platformKey);
  }
  const binary = await installBinaryDistribution(agent, platformEntry, platformKey, options);
  if (!platformEntry.sha256) {
    warnings.push("registry entry has no sha256; archive integrity was not verified");
  }
  return {
    argv: binary.argv,
    ...(platformEntry.env ? { env: platformEntry.env } : {}),
    installDir: binary.installDir,
    archiveUrl: platformEntry.archive,
    reused: binary.reused,
  };
}

function installPackageMethod(
  agent: RegistryAgent,
  method: Exclude<RegistryInstallMethod, "binary">,
  platformKey: string,
): ResolvedInstall {
  const distribution = method === "npx" ? agent.distribution.npx : agent.distribution.uvx;
  if (!distribution) {
    throw unsupportedDistributionError(agent, method, platformKey);
  }
  ensureRuntimeCommandAvailable(method);
  const args = distribution.args ?? [];
  const argv =
    method === "npx"
      ? ["npx", "-y", distribution.package, ...args]
      : ["uvx", distribution.package, ...args];
  return {
    argv,
    ...(distribution.env ? { env: distribution.env } : {}),
    reused: false,
  };
}

export async function installRegistryAgent(
  agent: RegistryAgent,
  options: InstallOptions = {},
): Promise<InstallResult> {
  const homeDir = options.homeDir ?? os.homedir();
  const platformKey = requirePlatformKey(options);
  const method = selectInstallMethod(agent, options.method, platformKey);
  if (!method) {
    throw unsupportedDistributionError(agent, options.method, platformKey);
  }

  const registeredName = resolveRegisteredName(agent, options.asName);
  const configPath = defaultRegistryConfigPath(homeDir);
  const { warnings, replacedConfigEntry } = await collectInstallWarnings(
    configPath,
    registeredName,
  );
  const resolved = await installDistribution(
    agent,
    method,
    platformKey,
    { ...options, homeDir },
    warnings,
  );
  await upsertConfigAgentEntry(configPath, registeredName, resolved.argv, resolved.env);

  return {
    agentId: agent.id,
    registeredName,
    version: agent.version,
    method,
    argv: resolved.argv,
    ...(resolved.env ? { env: resolved.env } : {}),
    ...(resolved.installDir ? { installDir: resolved.installDir } : {}),
    ...(resolved.archiveUrl ? { archiveUrl: resolved.archiveUrl } : {}),
    reused: resolved.reused,
    replacedConfigEntry,
    warnings,
  };
}

function requireUninstallName(requestedName: string): string {
  const registeredName = normalizeAgentName(requestedName);
  if (!registeredName) {
    throw new AcpxOperationalError("Agent name is required for registry uninstall", {
      origin: "cli",
      detailCode: "REGISTRY_UNINSTALL_NAME_REQUIRED",
    });
  }
  return registeredName;
}

async function removeConfigAgentEntry(
  configPath: string,
  config: RawConfigFile | undefined,
  name: string,
): Promise<boolean> {
  if (config === undefined || !removeAgentEntry(config, name)) {
    return false;
  }
  await writeGlobalConfigFile(configPath, config);
  return true;
}

async function removeInstallTree(
  installDir: string | undefined,
  log: ((message: string) => void) | undefined,
): Promise<string | undefined> {
  if (!installDir || !(await pathExists(installDir))) {
    return undefined;
  }
  await fs.rm(installDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  log?.(`removed ${installDir}`);
  return installDir;
}

function notInstalledError(
  registeredName: string,
  configPath: string,
  agentsRoot: string,
): AcpxOperationalError {
  return new AcpxOperationalError(
    `No registry install found for "${registeredName}". Checked config entry ${configPath} and install directory ${agentsRoot}.`,
    { origin: "cli", detailCode: "REGISTRY_NOT_INSTALLED" },
  );
}

export async function uninstallRegistryAgent(
  requestedName: string,
  options: { homeDir?: string; log?: (message: string) => void } = {},
): Promise<UninstallResult> {
  const homeDir = options.homeDir ?? os.homedir();
  const registeredName = requireUninstallName(requestedName);
  const configPath = defaultRegistryConfigPath(homeDir);
  const agentsRoot = defaultRegistryAgentsRoot(homeDir);
  const config = await readGlobalConfigFile(configPath);
  const installDir = resolveInstalledAgentDir(
    readAgentLaunchEntry(config, registeredName),
    agentsRoot,
    registeredName,
  );

  const removedConfigEntry = await removeConfigAgentEntry(configPath, config, registeredName);
  const removedInstallDir = await removeInstallTree(installDir, options.log);
  if (!removedConfigEntry && !removedInstallDir) {
    throw notInstalledError(registeredName, configPath, agentsRoot);
  }

  return {
    registeredName,
    removedConfigEntry,
    ...(removedInstallDir ? { removedInstallDir } : {}),
  };
}

function resolveRegisteredName(agent: RegistryAgent, asName: string | undefined): string {
  const name = normalizeAgentName(asName ?? agent.id);
  if (!name || !isSafeAgentName(name)) {
    throw new AcpxOperationalError(
      `Invalid agent name for registry install: ${JSON.stringify(asName ?? agent.id)}`,
      { origin: "cli", detailCode: "REGISTRY_INVALID_NAME" },
    );
  }
  return name;
}

function unsupportedDistributionError(
  agent: RegistryAgent,
  preferred: RegistryInstallMethod | undefined,
  platformKey: string,
): AcpxOperationalError {
  const methods: string[] = [];
  if (agent.distribution.binary) {
    methods.push(`binary (${Object.keys(agent.distribution.binary).join(", ") || "no platforms"})`);
  }
  if (agent.distribution.npx) {
    methods.push(`npx (${agent.distribution.npx.package})`);
  }
  if (agent.distribution.uvx) {
    methods.push(`uvx (${agent.distribution.uvx.package})`);
  }
  const requested = preferred ? `method "${preferred}"` : `platform "${platformKey}"`;
  return new AcpxOperationalError(
    `Registry agent ${agent.id} cannot be installed for ${requested}. Available distributions: ${
      methods.join("; ") || "none"
    }.`,
    { origin: "cli", detailCode: "REGISTRY_DISTRIBUTION_UNAVAILABLE" },
  );
}

function ensureRuntimeCommandAvailable(method: RegistryInstallMethod): void {
  const command = method === "npx" ? "npx" : "uvx";
  if (resolveInstalledExecutable(command)) {
    return;
  }
  const remediation =
    method === "npx"
      ? "npx ships with npm; install Node.js with npm or fix PATH"
      : "uvx ships with uv; install uv (https://docs.astral.sh/uv/) or fix PATH";
  throw new AcpxOperationalError(
    `Registry install method "${method}" requires the "${command}" command, which was not found on PATH. ${remediation}.`,
    { origin: "cli", detailCode: "REGISTRY_RUNNER_MISSING" },
  );
}

type BinaryInstallResult = {
  argv: string[];
  installDir: string;
  reused: boolean;
};

type ResolvedInstallOptions = InstallOptions & { homeDir: string };

function assertSafeIdentity(agent: RegistryAgent): void {
  if (!isSafeAgentName(agent.id) || !isSafeAgentName(agent.version)) {
    throw new AcpxOperationalError(
      `Registry agent has an unsafe id or version for installation: ${agent.id}@${agent.version}`,
      { origin: "cli", detailCode: "REGISTRY_UNSAFE_IDENTITY" },
    );
  }
}

function assertArchiveChecksum(
  agent: RegistryAgent,
  platformKey: string,
  platformEntry: RegistryBinaryPlatform,
  actualSha256: string,
): void {
  if (platformEntry.sha256 && platformEntry.sha256.toLowerCase() !== actualSha256) {
    throw new AcpxOperationalError(
      `Archive checksum mismatch for ${agent.id} (${platformKey}). Expected sha256 ${platformEntry.sha256}, got ${actualSha256}.`,
      { origin: "cli", detailCode: "REGISTRY_CHECKSUM_MISMATCH", retryable: true },
    );
  }
}

async function assertExtractedCommand(
  agent: RegistryAgent,
  platformKey: string,
  platformEntry: RegistryBinaryPlatform,
  extractDir: string,
): Promise<void> {
  const extractedBinary = resolveContainedPath(
    extractDir,
    platformEntry.cmd,
    platformEntry.archive,
  );
  if (await pathExists(extractedBinary)) {
    return;
  }
  throw new AcpxOperationalError(
    `Archive for ${agent.id} (${platformKey}) does not contain the expected command "${platformEntry.cmd}".`,
    {
      origin: "cli",
      detailCode: "REGISTRY_ARCHIVE_LAYOUT_UNEXPECTED",
      retryable: true,
    },
  );
}

async function materializeBinaryArchive(
  agent: RegistryAgent,
  platformEntry: RegistryBinaryPlatform,
  platformKey: string,
  options: ResolvedInstallOptions,
  agentsRoot: string,
  installDir: string,
  log: (message: string) => void,
): Promise<void> {
  await fs.mkdir(agentsRoot, { recursive: true });
  const stagingDir = await fs.mkdtemp(path.join(agentsRoot, `.staging-${agent.id}-`));
  try {
    const archivePath = path.join(stagingDir, "archive");
    log(`downloading ${platformEntry.archive}`);
    const download = await downloadArchive(platformEntry.archive, archivePath, {
      fetchImpl: options.fetchImpl,
      timeoutMs: options.downloadTimeoutMs ?? DEFAULT_ARCHIVE_DOWNLOAD_TIMEOUT_MS,
    });
    assertArchiveChecksum(agent, platformKey, platformEntry, download.sha256);
    log(`downloaded ${(download.bytes / 1_048_576).toFixed(1)} MiB`);

    const extractDir = path.join(stagingDir, "extract");
    await extractArchive(archivePath, extractDir, platformEntry.archive, log);
    await assertExtractedCommand(agent, platformKey, platformEntry, extractDir);
    await fs.mkdir(path.dirname(installDir), { recursive: true });
    await fs.rename(extractDir, installDir);
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

async function finalizeBinaryPermissions(
  binaryPath: string,
  platform: NodeJS.Platform,
): Promise<void> {
  if (platform !== "win32") {
    await fs.chmod(binaryPath, 0o755);
  }
}

async function installBinaryDistribution(
  agent: RegistryAgent,
  platformEntry: RegistryBinaryPlatform,
  platformKey: string,
  options: ResolvedInstallOptions,
): Promise<BinaryInstallResult> {
  assertSafeIdentity(agent);
  const agentsRoot = defaultRegistryAgentsRoot(options.homeDir);
  const installDir = path.join(agentsRoot, agent.id, agent.version);
  const binaryPath = resolveContainedPath(installDir, platformEntry.cmd, platformEntry.archive);
  const log = options.log ?? (() => {});

  if (!options.force && (await pathExists(binaryPath))) {
    log(`reusing existing install at ${installDir}`);
    return { argv: [binaryPath, ...(platformEntry.args ?? [])], installDir, reused: true };
  }
  if (options.force) {
    await removePathIfExists(installDir);
  }

  await materializeBinaryArchive(
    agent,
    platformEntry,
    platformKey,
    options,
    agentsRoot,
    installDir,
    log,
  );
  await finalizeBinaryPermissions(binaryPath, options.platform ?? process.platform);
  return { argv: [binaryPath, ...(platformEntry.args ?? [])], installDir, reused: false };
}

function resolveContainedPath(root: string, cmd: string, archiveUrl: string): string {
  if (path.isAbsolute(cmd)) {
    throw new AcpxOperationalError(
      `Registry entry declares an absolute command path "${cmd}" for ${archiveUrl}, which is not allowed.`,
      { origin: "cli", detailCode: "REGISTRY_CMD_UNSAFE" },
    );
  }
  const resolved = path.resolve(root, cmd);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new AcpxOperationalError(
      `Registry entry command "${cmd}" must stay inside the install directory for ${archiveUrl}.`,
      { origin: "cli", detailCode: "REGISTRY_CMD_UNSAFE" },
    );
  }
  return resolved;
}

type DownloadResult = {
  sha256: string;
  bytes: number;
};

async function downloadArchive(
  url: string,
  destinationPath: string,
  options: { fetchImpl?: typeof fetch; timeoutMs: number },
): Promise<DownloadResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: "follow",
    });
    if (!response.ok) {
      throw new AcpxOperationalError(
        `Failed to download registry archive from ${url}: HTTP ${response.status} ${response.statusText}`.trim(),
        {
          origin: "cli",
          detailCode: "REGISTRY_ARCHIVE_DOWNLOAD_FAILED",
          retryable: true,
        },
      );
    }
    if (!response.body) {
      throw new AcpxOperationalError(`Registry archive response from ${url} has no body`, {
        origin: "cli",
        detailCode: "REGISTRY_ARCHIVE_DOWNLOAD_FAILED",
        retryable: true,
      });
    }

    const hash = createHash("sha256");
    let bytes = 0;
    const body = Readable.fromWeb(response.body as unknown as NodeWebReadableStream);
    await pipeline(
      body,
      async function* (source: AsyncIterable<Uint8Array>) {
        for await (const chunk of source) {
          hash.update(chunk);
          bytes += chunk.byteLength;
          yield chunk;
        }
      },
      createWriteStream(destinationPath),
    );
    return { sha256: hash.digest("hex"), bytes };
  } catch (error) {
    if (error instanceof AcpxOperationalError) {
      throw error;
    }
    if (controller.signal.aborted) {
      throw new AcpxOperationalError(
        `Timed out downloading registry archive from ${url} after ${options.timeoutMs}ms`,
        { origin: "cli", detailCode: "REGISTRY_ARCHIVE_DOWNLOAD_TIMEOUT", retryable: true },
      );
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new AcpxOperationalError(`Failed to download registry archive from ${url}: ${reason}`, {
      origin: "cli",
      detailCode: "REGISTRY_ARCHIVE_DOWNLOAD_FAILED",
      retryable: true,
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }
}

type ArchiveKind = "tar" | "zip" | "raw";

function posixBasename(url: string): string | undefined {
  try {
    const base = path.posix.basename(new URL(url).pathname);
    return base.length > 0 ? base : undefined;
  } catch {
    return undefined;
  }
}

function classifyArchive(url: string): ArchiveKind {
  const base = posixBasename(url);
  if (base === undefined) {
    return "raw";
  }
  if (/\.(tar|tar\.gz|tgz|tar\.bz2|tbz2?|tar\.xz|txz)$/iu.test(base)) {
    return "tar";
  }
  if (/\.zip$/iu.test(base)) {
    return "zip";
  }
  return "raw";
}

async function extractArchive(
  archivePath: string,
  extractDir: string,
  archiveUrl: string,
  log: (message: string) => void,
): Promise<void> {
  const kind = classifyArchive(archiveUrl);
  await fs.mkdir(extractDir, { recursive: true });

  if (kind === "raw") {
    const fileName = posixBasename(archiveUrl) ?? "agent-binary";
    await fs.copyFile(archivePath, path.join(extractDir, fileName));
    return;
  }

  if (kind === "tar") {
    const result = await runArchiveTool("tar", ["-xf", archivePath, "-C", extractDir]);
    if (result.code !== 0) {
      throw archiveExtractionError(archiveUrl, "tar", result.stderr);
    }
    return;
  }

  const tarResult = await runArchiveTool("tar", ["-xf", archivePath, "-C", extractDir]);
  if (tarResult.code === 0) {
    return;
  }
  log(`tar could not extract the zip archive; retrying with unzip (${tarResult.stderr.trim()})`);
  const unzipResult = await runArchiveTool("unzip", ["-q", archivePath, "-d", extractDir]);
  if (unzipResult.code === 0) {
    return;
  }
  throw new AcpxOperationalError(
    `Failed to extract zip archive from ${archiveUrl}. "tar -xf" failed (${tarResult.stderr.trim()}); "unzip" failed (${unzipResult.stderr.trim()}). Install unzip, or retry with --method npx when the agent provides an npx distribution.`,
    {
      origin: "cli",
      detailCode: "REGISTRY_ARCHIVE_EXTRACT_FAILED",
      retryable: true,
    },
  );
}

function archiveExtractionError(
  archiveUrl: string,
  tool: string,
  stderr: string,
): AcpxOperationalError {
  return new AcpxOperationalError(
    `Failed to extract archive from ${archiveUrl}: ${tool} failed (${stderr.trim()}). Verify the system ${tool} command, or retry with another install method when the agent provides one.`,
    { origin: "cli", detailCode: "REGISTRY_ARCHIVE_EXTRACT_FAILED", retryable: true },
  );
}

type ArchiveToolResult = {
  code: number | null;
  stderr: string;
};

function runArchiveTool(command: string, args: string[]): Promise<ArchiveToolResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
    }
    child.on("error", (error) => {
      resolve({ code: null, stderr: `failed to launch ${command}: ${error.message}` });
    });
    child.on("close", (code) => {
      resolve({ code, stderr });
    });
  });
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function removePathIfExists(target: string): Promise<void> {
  if (await pathExists(target)) {
    await fs.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

async function readGlobalConfigFile(configPath: string): Promise<RawConfigFile | undefined> {
  try {
    return await readRawConfigFile(configPath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new AcpxOperationalError(reason, {
      origin: "cli",
      detailCode: "REGISTRY_CONFIG_INVALID",
      cause: error,
    });
  }
}

async function writeGlobalConfigFile(configPath: string, config: RawConfigFile): Promise<void> {
  await writeRawConfigFile(configPath, config);
}

async function upsertConfigAgentEntry(
  configPath: string,
  name: string,
  argv: string[],
  env: RegistryEnv | undefined,
): Promise<void> {
  const config = (await readGlobalConfigFile(configPath)) ?? {};
  upsertAgentEntry(config, name, env ? { argv, env } : { argv });
  await writeGlobalConfigFile(configPath, config);
}

async function hasConfigAgentEntry(configPath: string, name: string): Promise<boolean> {
  const config = await readGlobalConfigFile(configPath);
  const agents = config?.agents;
  return isObject(agents) && Object.hasOwn(agents, name);
}

function firstLaunchCommand(entry: AgentLaunchEntry | undefined): string | undefined {
  if (!entry) {
    return undefined;
  }
  return entry.argv?.[0] ?? entry.command;
}

function resolveInstallDirFromLaunch(
  entry: AgentLaunchEntry | undefined,
  agentsRoot: string,
): string | undefined {
  const launchCommand = firstLaunchCommand(entry);
  if (!launchCommand) {
    return undefined;
  }
  const prefix = `${agentsRoot}${path.sep}`;
  const absolute = path.resolve(launchCommand);
  if (!absolute.startsWith(prefix)) {
    return undefined;
  }
  const agentId = absolute.slice(prefix.length).split(path.sep)[0];
  return agentId && agentId !== ".staging" ? path.join(agentsRoot, agentId) : undefined;
}

function resolveInstalledAgentDir(
  entry: AgentLaunchEntry | undefined,
  agentsRoot: string,
  registeredName: string,
): string | undefined {
  const fromLaunch = resolveInstallDirFromLaunch(entry, agentsRoot);
  if (fromLaunch) {
    return fromLaunch;
  }
  const byName = path.join(agentsRoot, registeredName);
  return byName === agentsRoot ? undefined : byName;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
