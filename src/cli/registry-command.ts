import { Command, InvalidArgumentError } from "commander";
import {
  installRegistryAgent,
  uninstallRegistryAgent,
  type InstallResult,
} from "../registry/install.js";
import { loadAcpRegistry } from "../registry/registry-client.js";
import {
  findRegistryAgent,
  listAgentDistributionMethods,
  registryPlatformKey,
  selectInstallMethod,
  type RegistryAgent,
  type RegistryEnv,
  type RegistryInstallMethod,
} from "../registry/types.js";
import type { OutputFormat } from "../types.js";
import type { ResolvedAcpxConfig } from "./config.js";
import { parseNonEmptyValue, parseOutputFormat, resolveGlobalFlags } from "./flags.js";

const INSTALL_METHODS: ReadonlyArray<RegistryInstallMethod> = ["binary", "npx", "uvx"];

export type RegistryInstallFlags = {
  method?: RegistryInstallMethod;
  as?: string;
  force?: boolean;
};

function parseInstallMethod(value: string): RegistryInstallMethod {
  const normalized = value.trim().toLowerCase();
  if (!INSTALL_METHODS.includes(normalized as RegistryInstallMethod)) {
    throw new InvalidArgumentError(
      `Invalid method "${value}". Expected one of: ${INSTALL_METHODS.join(", ")}`,
    );
  }
  return normalized as RegistryInstallMethod;
}

function parseAgentId(value: string): string {
  return parseNonEmptyValue("Agent id", value);
}

function parseAgentName(value: string): string {
  return parseNonEmptyValue("Agent name", value);
}

async function loadRegistryAgentOrThrow(agentId: string): Promise<RegistryAgent> {
  const registry = await loadAcpRegistry();
  const agent = findRegistryAgent(registry, agentId);
  if (!agent) {
    throw new InvalidArgumentError(
      `Registry agent not found: ${agentId}. Use "acpx registry list" to see available agents.`,
    );
  }
  return agent;
}

function agentSummary(agent: { name: string; description?: string }): string {
  const summary = (agent.description ?? agent.name).replace(/\s+/gu, " ").trim();
  return summary.length > 64 ? `${summary.slice(0, 63)}…` : summary;
}

function renderEnv(env: RegistryEnv | undefined): string | undefined {
  if (!env || Object.keys(env).length === 0) {
    return undefined;
  }
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
}

async function handleRegistryList(command: Command, config: ResolvedAcpxConfig): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const registry = await loadAcpRegistry();
  const platformKey = registryPlatformKey();
  const agents = registry.agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    version: agent.version,
    ...(agent.description ? { description: agent.description } : {}),
    methods: listAgentDistributionMethods(agent),
    installable: selectInstallMethod(agent, undefined, platformKey) !== undefined,
  }));

  if (globalFlags.format === "json") {
    process.stdout.write(
      `${JSON.stringify({ registryVersion: registry.version, platform: platformKey, agents })}\n`,
    );
    return;
  }
  if (globalFlags.format === "quiet") {
    for (const agent of agents) {
      process.stdout.write(`${agent.id}\n`);
    }
    return;
  }

  if (agents.length === 0) {
    process.stdout.write("No agents found in the ACP registry.\n");
    return;
  }
  const idWidth = Math.max(...agents.map((agent) => agent.id.length));
  const versionWidth = Math.max(...agents.map((agent) => agent.version.length));
  const methodWidth = Math.max(
    ...agents.map((agent) => agent.methods.join("|").length),
    "methods".length,
  );
  for (const agent of agents) {
    const methods = agent.methods.join("|") || "none";
    process.stdout.write(
      `${agent.id.padEnd(idWidth)}  ${agent.version.padEnd(versionWidth)}  ${methods.padEnd(methodWidth)}  ${agentSummary(agent)}\n`,
    );
  }
}

type RegistryShowPayload = {
  id: string;
  name: string;
  version: string;
  description?: string;
  authors?: string[];
  license?: string;
  license_url?: string;
  repository?: string;
  website?: string;
  platform: string | undefined;
  methods: RegistryInstallMethod[];
  installable: boolean;
  distributions: {
    binary?: {
      platforms: string[];
      current?: {
        archive: string;
        cmd: string;
        args?: string[];
        env?: RegistryEnv;
        sha256?: string;
      };
    };
    npx?: { package: string; args?: string[]; env?: RegistryEnv };
    uvx?: { package: string; args?: string[]; env?: RegistryEnv };
  };
};

function identityMetadata(
  agent: RegistryAgent,
): Pick<
  RegistryShowPayload,
  "description" | "authors" | "license" | "license_url" | "repository" | "website"
> {
  return {
    ...(agent.description ? { description: agent.description } : {}),
    ...(agent.authors ? { authors: agent.authors } : {}),
    ...(agent.license ? { license: agent.license } : {}),
    ...(agent.license_url ? { license_url: agent.license_url } : {}),
    ...(agent.repository ? { repository: agent.repository } : {}),
    ...(agent.website ? { website: agent.website } : {}),
  };
}

function buildShowDistributions(
  agent: RegistryAgent,
  platformKey: string | undefined,
): RegistryShowPayload["distributions"] {
  const binary = agent.distribution.binary;
  const current = platformKey ? binary?.[platformKey] : undefined;
  return {
    ...(binary
      ? { binary: { platforms: Object.keys(binary), ...(current ? { current } : {}) } }
      : {}),
    ...(agent.distribution.npx ? { npx: agent.distribution.npx } : {}),
    ...(agent.distribution.uvx ? { uvx: agent.distribution.uvx } : {}),
  };
}

function buildShowPayload(
  agent: RegistryAgent,
  platformKey: string | undefined,
): RegistryShowPayload {
  return {
    id: agent.id,
    name: agent.name,
    version: agent.version,
    ...identityMetadata(agent),
    platform: platformKey,
    methods: listAgentDistributionMethods(agent),
    installable: selectInstallMethod(agent, undefined, platformKey) !== undefined,
    distributions: buildShowDistributions(agent, platformKey),
  };
}

function renderIdentityLines(payload: RegistryShowPayload): string[] {
  const lines: string[] = [];
  if (payload.description) {
    lines.push(`description: ${payload.description}`);
  }
  if (payload.authors) {
    lines.push(`authors:     ${payload.authors.join(", ")}`);
  }
  if (payload.license) {
    lines.push(`license:     ${payload.license}`);
  }
  if (payload.repository) {
    lines.push(`repository:  ${payload.repository}`);
  }
  if (payload.website) {
    lines.push(`website:     ${payload.website}`);
  }
  return lines;
}

function renderShowHeader(payload: RegistryShowPayload): string[] {
  return [
    `id:          ${payload.id}`,
    `name:        ${payload.name}`,
    `version:     ${payload.version}`,
    ...renderIdentityLines(payload),
    `platform:    ${payload.platform ?? "unsupported"}`,
    `methods:     ${payload.methods.join(", ") || "none"}`,
    `installable: ${payload.installable ? "yes" : "no (no distribution for this platform)"}`,
  ];
}

function renderBinaryLines(
  binary: RegistryShowPayload["distributions"]["binary"],
  platform: string | undefined,
): string[] {
  if (!binary) {
    return [];
  }
  const lines = [`binary platforms: ${binary.platforms.join(", ")}`];
  const current = binary.current;
  if (!current) {
    return lines;
  }
  lines.push(`binary archive (${platform}): ${current.archive}`);
  lines.push(`binary command: ${current.cmd}`);
  if (current.args) {
    lines.push(`binary args: ${current.args.join(" ")}`);
  }
  if (current.sha256) {
    lines.push(`binary sha256: ${current.sha256}`);
  }
  const env = renderEnv(current.env);
  if (env) {
    lines.push(`binary env: ${env}`);
  }
  return lines;
}

function renderPackageLines(
  label: "npx" | "uvx",
  distribution: RegistryShowPayload["distributions"]["npx"],
): string[] {
  if (!distribution) {
    return [];
  }
  const lines = [`${label} package: ${distribution.package}`];
  if (distribution.args) {
    lines.push(`${label} args: ${distribution.args.join(" ")}`);
  }
  const env = renderEnv(distribution.env);
  if (env) {
    lines.push(`${label} env: ${env}`);
  }
  return lines;
}

function renderShowText(payload: RegistryShowPayload): string {
  const { binary, npx, uvx } = payload.distributions;
  const lines = [
    ...renderShowHeader(payload),
    ...renderBinaryLines(binary, payload.platform),
    ...renderPackageLines("npx", npx),
    ...renderPackageLines("uvx", uvx),
  ];
  return `${lines.join("\n")}\n`;
}

async function handleRegistryShow(
  agentId: string,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const agent = await loadRegistryAgentOrThrow(agentId);
  const payload = buildShowPayload(agent, registryPlatformKey());

  if (globalFlags.format === "json") {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  if (globalFlags.format === "quiet") {
    process.stdout.write(`${payload.id}\n`);
    return;
  }
  process.stdout.write(renderShowText(payload));
}

function progressLogger(format: OutputFormat): (message: string) => void {
  return (message) => {
    if (format === "text") {
      process.stderr.write(`${message}\n`);
    }
  };
}

function renderInstallText(result: InstallResult): string {
  const nameSuffix =
    result.registeredName === result.agentId ? "" : ` as "${result.registeredName}"`;
  const action = result.reused ? "Reused" : "Installed";
  const lines = [`${action} ${result.agentId} ${result.version} (${result.method})${nameSuffix}`];
  if (result.installDir) {
    lines.push(`  install dir: ${result.installDir}`);
  }
  lines.push(`  launch: ${result.argv.join(" ")}`);
  const env = renderEnv(result.env);
  if (env) {
    lines.push(`  env: ${env}`);
  }
  lines.push(`Usage: acpx ${result.registeredName} sessions new`);
  return `${lines.join("\n")}\n`;
}

async function handleRegistryInstall(
  agentId: string,
  flags: RegistryInstallFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const agent = await loadRegistryAgentOrThrow(agentId);
  const result = await installRegistryAgent(agent, {
    ...(flags.as ? { asName: flags.as } : {}),
    ...(flags.method ? { method: flags.method } : {}),
    force: flags.force === true,
    log: progressLogger(globalFlags.format),
  });

  if (globalFlags.format === "json") {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (globalFlags.format === "quiet") {
    return;
  }

  for (const warning of result.warnings) {
    process.stderr.write(`warning: ${warning}\n`);
  }
  process.stdout.write(renderInstallText(result));
}

async function handleRegistryUninstall(
  agentName: string,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const result = await uninstallRegistryAgent(agentName, {
    log: progressLogger(globalFlags.format),
  });

  if (globalFlags.format === "json") {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (globalFlags.format === "quiet") {
    return;
  }

  process.stdout.write(`Removed registry agent "${result.registeredName}"\n`);
  if (result.removedConfigEntry) {
    process.stdout.write("  removed config entry\n");
  }
  if (result.removedInstallDir) {
    process.stdout.write(`  removed install dir: ${result.removedInstallDir}\n`);
  }
}

export function registerRegistryCommand(program: Command, config: ResolvedAcpxConfig): void {
  const registryCommand = program
    .command("registry")
    .description("Install ACP servers from the official ACP agent registry");

  registryCommand
    .command("list")
    .description("List agents available in the ACP registry")
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .action(async function (this: Command) {
      await handleRegistryList(this, config);
    });

  registryCommand
    .command("show")
    .description("Show registry metadata and distributions for one agent")
    .argument("<agent-id>", "Registry agent id", parseAgentId)
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .action(async function (this: Command, agentId: string) {
      await handleRegistryShow(agentId, this, config);
    });

  registryCommand
    .command("install")
    .description("Install a registry agent and register it in the global config")
    .argument("<agent-id>", "Registry agent id", parseAgentId)
    .option("--method <method>", "Distribution to install: binary, npx, or uvx", parseInstallMethod)
    .option("--as <name>", "Register under a different agent name", parseAgentName)
    .option("--force", "Re-download even if this version is already installed")
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .action(async function (this: Command, agentId: string, flags: RegistryInstallFlags) {
      await handleRegistryInstall(agentId, flags, this, config);
    });

  registryCommand
    .command("uninstall")
    .description("Remove an installed registry agent from config and disk")
    .argument("<name>", "Registered agent name", parseAgentName)
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .action(async function (this: Command, agentName: string) {
      await handleRegistryUninstall(agentName, this, config);
    });

  registryCommand.action(async function (this: Command) {
    throw new InvalidArgumentError(
      'A registry subcommand is required: "list", "show", "install", or "uninstall"',
    );
  });
}
