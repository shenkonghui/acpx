import { z } from "zod";
import { AcpxOperationalError } from "../errors.js";

export const DEFAULT_ACP_REGISTRY_URL =
  "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

export const ACP_REGISTRY_URL_ENV = "ACPX_REGISTRY_URL";

export type RegistryEnv = Record<string, string>;

export type RegistryPackageDistribution = {
  package: string;
  args?: string[];
  env?: RegistryEnv;
};

export type RegistryBinaryPlatform = {
  archive: string;
  cmd: string;
  args?: string[];
  env?: RegistryEnv;
  sha256?: string;
};

export type RegistryBinaryDistribution = Record<string, RegistryBinaryPlatform>;

export type RegistryDistribution = {
  npx?: RegistryPackageDistribution;
  uvx?: RegistryPackageDistribution;
  binary?: RegistryBinaryDistribution;
};

export type RegistryAgent = {
  id: string;
  name: string;
  version: string;
  description?: string;
  authors?: string[];
  license?: string;
  license_url?: string;
  repository?: string;
  website?: string;
  distribution: RegistryDistribution;
};

export type AcpRegistry = {
  version: string;
  agents: RegistryAgent[];
};

export type RegistryInstallMethod = "binary" | "npx" | "uvx";

const envSchema = z.record(z.string().min(1), z.string());

const packageDistributionSchema = z.object({
  package: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: envSchema.optional(),
});

const binaryPlatformSchema = z.object({
  archive: z.string().min(1),
  cmd: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: envSchema.optional(),
  sha256: z.string().optional(),
});

const distributionSchema = z
  .object({
    npx: packageDistributionSchema.optional(),
    uvx: packageDistributionSchema.optional(),
    binary: z.record(z.string(), binaryPlatformSchema).optional(),
  })
  .passthrough();

const agentSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    version: z.string().min(1),
    description: z.string().optional(),
    authors: z.array(z.string()).optional(),
    license: z.string().optional(),
    license_url: z.string().optional(),
    repository: z.string().optional(),
    website: z.string().optional(),
    distribution: distributionSchema,
  })
  .passthrough();

const registrySchema = z
  .object({
    version: z.string().optional(),
    agents: z.array(agentSchema),
    extensions: z.array(z.unknown()).optional(),
  })
  .passthrough();

type RawRegistryAgent = z.infer<typeof agentSchema>;

function normalizeDistribution(
  distribution: RawRegistryAgent["distribution"],
): RegistryDistribution {
  return {
    ...(distribution.npx !== undefined ? { npx: distribution.npx } : {}),
    ...(distribution.uvx !== undefined ? { uvx: distribution.uvx } : {}),
    ...(distribution.binary !== undefined ? { binary: distribution.binary } : {}),
  };
}

function normalizeAgent(agent: RawRegistryAgent): RegistryAgent {
  return {
    id: agent.id,
    name: agent.name,
    version: agent.version,
    ...(agent.description !== undefined ? { description: agent.description } : {}),
    ...(agent.authors !== undefined ? { authors: agent.authors } : {}),
    ...(agent.license !== undefined ? { license: agent.license } : {}),
    ...(agent.license_url !== undefined ? { license_url: agent.license_url } : {}),
    ...(agent.repository !== undefined ? { repository: agent.repository } : {}),
    ...(agent.website !== undefined ? { website: agent.website } : {}),
    distribution: normalizeDistribution(agent.distribution),
  };
}

function parseRegistryJson(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new AcpxOperationalError(`ACP registry is not valid JSON: ${reason}`, {
      origin: "cli",
      detailCode: "REGISTRY_INVALID_JSON",
      cause: error,
    });
  }
}

function registryShapeError(error: z.ZodError): AcpxOperationalError {
  const issue = error.issues[0];
  const location = issue && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
  return new AcpxOperationalError(
    `ACP registry has an unexpected shape${location}: ${issue?.message ?? "unknown validation error"}`,
    {
      origin: "cli",
      detailCode: "REGISTRY_INVALID_SHAPE",
    },
  );
}

export function parseAcpRegistry(payload: string): AcpRegistry {
  const result = registrySchema.safeParse(parseRegistryJson(payload));
  if (!result.success) {
    throw registryShapeError(result.error);
  }

  return {
    version: result.data.version ?? "1.0.0",
    agents: result.data.agents.map(normalizeAgent),
  };
}

export function resolveRegistryUrl(override?: string): string {
  return (override ?? process.env[ACP_REGISTRY_URL_ENV] ?? DEFAULT_ACP_REGISTRY_URL).trim();
}

const REGISTRY_OS_KEYS: Partial<Record<NodeJS.Platform, string>> = {
  win32: "windows",
  darwin: "darwin",
  linux: "linux",
};

const REGISTRY_ARCH_KEYS: Partial<Record<string, string>> = {
  x64: "x86_64",
  arm64: "aarch64",
};

export function registryPlatformKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | undefined {
  const osKey = REGISTRY_OS_KEYS[platform];
  const archKey = REGISTRY_ARCH_KEYS[arch];
  return osKey && archKey ? `${osKey}-${archKey}` : undefined;
}

export function findRegistryAgent(
  registry: AcpRegistry,
  agentId: string,
): RegistryAgent | undefined {
  const normalized = agentId.trim().toLowerCase();
  return registry.agents.find((agent) => agent.id.toLowerCase() === normalized);
}

export function listAgentDistributionMethods(agent: RegistryAgent): RegistryInstallMethod[] {
  const methods: RegistryInstallMethod[] = [];
  if (agent.distribution.binary && Object.keys(agent.distribution.binary).length > 0) {
    methods.push("binary");
  }
  if (agent.distribution.npx) {
    methods.push("npx");
  }
  if (agent.distribution.uvx) {
    methods.push("uvx");
  }
  return methods;
}

function hasBinaryForPlatform(agent: RegistryAgent, platformKey: string | undefined): boolean {
  return Boolean(platformKey && agent.distribution.binary?.[platformKey]);
}

function firstPackageMethod(agent: RegistryAgent): RegistryInstallMethod | undefined {
  if (agent.distribution.npx) {
    return "npx";
  }
  if (agent.distribution.uvx) {
    return "uvx";
  }
  return undefined;
}

export function selectInstallMethod(
  agent: RegistryAgent,
  preferred: RegistryInstallMethod | undefined,
  platformKey: string | undefined,
): RegistryInstallMethod | undefined {
  if (preferred === "binary") {
    return hasBinaryForPlatform(agent, platformKey) ? "binary" : undefined;
  }
  if (preferred) {
    return agent.distribution[preferred] ? preferred : undefined;
  }
  if (hasBinaryForPlatform(agent, platformKey)) {
    return "binary";
  }
  return firstPackageMethod(agent);
}
