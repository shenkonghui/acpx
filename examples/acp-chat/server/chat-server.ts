import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { z } from "zod";
import { normalizeAgentName } from "../../../src/agent-registry.js";
import { loadResolvedConfig } from "../../../src/cli/config.js";
import { AcpxOperationalError } from "../../../src/errors.js";
import {
  DEFAULT_ARCHIVE_DOWNLOAD_TIMEOUT_MS,
  installRegistryAgent,
  type InstallOptions,
  type InstallResult,
} from "../../../src/registry/install.js";
import { loadAcpRegistry } from "../../../src/registry/registry-client.js";
import {
  findRegistryAgent,
  listAgentDistributionMethods,
  registryPlatformKey,
  selectInstallMethod,
  type AcpRegistry,
  type RegistryAgent,
} from "../../../src/registry/types.js";
import type { PermissionMode } from "../../../src/types.js";
import { LiveAgentCatalog, type AgentCatalog, type AgentSummary } from "./agent-catalog.js";
import { CHAT_PROTOCOL, chatClientMessageSchema, type ChatServerMessage } from "./chat-protocol.js";
import { ChatSessionManager, type ChatRuntimeFactory } from "./chat-session.js";
import { DiagnosticsRunner, type AgentSpecInput } from "./diagnostics.js";
import { MutableAgentRegistry } from "./live-registry.js";
import { ModelProbeRunner, type ModelProbeResult } from "./model-probe.js";
import { formatChatOrigin, isAllowedChatRequest } from "./request-origin.js";
import {
  applySettingsMutation as applySettingsMutationToConfig,
  buildSettingsView,
  SettingsError,
  type SettingsMutation,
  type SettingsView,
} from "./settings.js";

export const CHAT_SERVER_ID = "acpx-acp-chat";

const MAX_API_BODY_BYTES = 64 * 1024;
export const DEFAULT_CHAT_HOST = "127.0.0.1";
export const DEFAULT_CHAT_PORT = 4174;

export type ChatServerOptions = {
  host?: string;
  port?: number;
  cwd?: string;
  permissionMode?: PermissionMode;
  stateDir?: string;
  gatewayConfigPath?: string;
  /** Set false to skip Vite (tests exercise the API/WS surface only). */
  serveUi?: boolean;
  verbose?: boolean;
  /** Disable `POST /api/registry/install` (default enabled). */
  allowInstall?: boolean;
  /** Disable ad-hoc command sessions (default enabled). */
  allowCommand?: boolean;
  /** Disable editing the agent config from the page (default enabled). */
  allowSettings?: boolean;
  /** Test seam: fixed agent catalog instead of reading the user config per request. */
  agentCatalog?: AgentCatalog;
  /** Test seam: replace the live catalog source. */
  liveCatalog?: { build(): Promise<AgentCatalog> };
  /** Test seam: replace how the ACP registry is loaded. */
  loadRegistry?: () => Promise<AcpRegistry>;
  /** Test seam: replace registry installs. */
  installAgent?: (agent: RegistryAgent, options: InstallOptions) => Promise<InstallResult>;
  /** Test seam: replace the runtime (used to inject fake agent registries). */
  createRuntime?: ChatRuntimeFactory;
};

export type ChatServerCapabilities = {
  install: boolean;
  command: boolean;
  settings: boolean;
};

export type ChatServer = {
  host: string;
  port: number;
  baseUrl: string;
  cwd: string;
  permissionMode: PermissionMode;
  stateDir: string;
  close(): Promise<void>;
};

export type ChatServerHealth = {
  service: string;
  cwd: string;
  permissionMode: string;
  stateDir: string;
  capabilities?: ChatServerCapabilities;
};

export function defaultChatStateDir(): string {
  return path.join(os.homedir(), ".acpx", "acp-chat");
}

export async function createChatServer(options: ChatServerOptions = {}): Promise<ChatServer> {
  const host = options.host ?? DEFAULT_CHAT_HOST;
  const port = options.port ?? DEFAULT_CHAT_PORT;
  // Reject unrepresentable origins before allocating the Vite server or TCP listener.
  formatChatOrigin(host, port);

  const cwd = path.resolve(options.cwd ?? process.cwd());
  const permissionMode = options.permissionMode ?? "approve-all";
  const stateDir = options.stateDir ?? defaultChatStateDir();
  const allowInstall = options.allowInstall !== false;
  const allowCommand = options.allowCommand !== false;
  const allowSettings = options.allowSettings !== false;

  const registry = new MutableAgentRegistry();
  const fixedCatalog = options.agentCatalog;
  const catalogSource =
    fixedCatalog !== undefined
      ? { build: async (): Promise<AgentCatalog> => fixedCatalog }
      : (options.liveCatalog ??
        new LiveAgentCatalog(registry, {
          cwd,
          ...(options.gatewayConfigPath ? { gatewayConfigPath: options.gatewayConfigPath } : {}),
        }));
  if (fixedCatalog !== undefined) {
    registry.setConfigOverrides(fixedCatalog.overrides);
  } else {
    await catalogSource.build();
  }

  const manager = new ChatSessionManager(
    {
      cwd,
      stateDir,
      permissionMode,
      registry,
      allowCommand,
      ...(options.verbose !== undefined ? { verbose: options.verbose } : {}),
    },
    options.createRuntime,
  );

  const diagnostics = new DiagnosticsRunner({
    cwd,
    stateDir,
    registry,
    verbose: options.verbose === true,
  });

  const modelProbe = new ModelProbeRunner({
    cwd,
    stateDir,
    registry,
    verbose: options.verbose === true,
  });

  const vite = options.serveUi === false ? null : await createUiMiddleware(host, port);
  const chatSockets = createChatSocketServer(manager);

  let closePromise: Promise<void> | null = null;
  const requestClose = (): Promise<void> => {
    if (!closePromise) {
      closePromise = closeChatServer({ server, vite, chatSockets, manager });
    }
    return closePromise;
  };

  const server = http.createServer((request, response) => {
    if (!isAllowedChatRequest(request, host)) {
      writeJson(response, 403, { error: "Forbidden" });
      return;
    }
    const fail = (): void => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      writeJson(response, 500, { error: "acpx chat request failed" });
    };
    void handleApiRequest(request, response, {
      getCatalog: () => catalogSource.build(),
      cwd,
      permissionMode,
      stateDir,
      requestClose,
      allowInstall,
      allowCommand,
      allowSettings,
      diagnostics,
      probeModels: (agent: string) => modelProbe.probe(agent),
      getSettings: () =>
        buildSettingsView({
          cwd,
          registry,
          ...(options.gatewayConfigPath ? { gatewayConfigPath: options.gatewayConfigPath } : {}),
        }),
      applySettingsMutation: (mutation: SettingsMutation) =>
        applySettingsMutationToConfig(mutation, { homeDir: os.homedir() }),
      refreshSessionModels: (agent: string) => manager.refreshModelsForAgent(agent),
      loadRegistry: options.loadRegistry ?? (() => loadAcpRegistry()),
      installAgent: options.installAgent ?? installRegistryAgent,
    })
      .then((handled) => {
        if (handled) {
          return;
        }
        if (!vite) {
          response.statusCode = 404;
          response.end("Not found");
          return;
        }
        vite.middlewares(request, response, (error: unknown) => {
          if (error) {
            fail();
            return;
          }
          response.statusCode = 404;
          response.end("Not found");
        });
      })
      .catch(fail);
  });

  // Binary registry installs can block on a large download; keep the socket alive.
  server.requestTimeout = DEFAULT_ARCHIVE_DOWNLOAD_TIMEOUT_MS + 60_000;

  server.on("upgrade", (request, socket, head) => {
    try {
      if (!isAllowedChatRequest(request, host)) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", () =>
          socket.destroy(),
        );
        return;
      }
      if (!chatSockets.handleUpgrade(request, socket, head)) {
        socket.destroy();
      }
    } catch {
      socket.destroy();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  }).catch(async (error) => {
    await requestClose().catch(() => {});
    throw error;
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("acpx chat server failed to bind a TCP address.");
  }

  return {
    host,
    port: address.port,
    baseUrl: formatChatOrigin(host, address.port),
    cwd,
    permissionMode,
    stateDir,
    async close(): Promise<void> {
      await requestClose();
    },
  };
}

type ApiContext = {
  getCatalog: () => Promise<AgentCatalog>;
  cwd: string;
  permissionMode: PermissionMode;
  stateDir: string;
  requestClose: () => Promise<void>;
  allowInstall: boolean;
  allowCommand: boolean;
  allowSettings: boolean;
  diagnostics: DiagnosticsRunner;
  probeModels: (agent: string) => Promise<ModelProbeResult>;
  getSettings: () => Promise<SettingsView>;
  applySettingsMutation: (mutation: SettingsMutation) => Promise<{ name: string }>;
  /** Re-reads the model list for live sessions on an agent (after enabledModels changed). */
  refreshSessionModels: (agent: string) => Promise<void>;
  loadRegistry: () => Promise<AcpRegistry>;
  installAgent: (agent: RegistryAgent, options: InstallOptions) => Promise<InstallResult>;
};

const INSTALL_CLIENT_ERRORS = new Set([
  "REGISTRY_INVALID_NAME",
  "REGISTRY_UNSAFE_IDENTITY",
  "REGISTRY_DISTRIBUTION_UNAVAILABLE",
  "REGISTRY_RUNNER_MISSING",
  "REGISTRY_PLATFORM_UNSUPPORTED",
]);

const installRequestSchema = z.object({
  id: z.string().min(1),
  method: z.enum(["binary", "npx", "uvx"]).optional(),
  asName: z.string().min(1).optional(),
  force: z.boolean().optional(),
});

const settingsUpsertSchema = z
  .object({
    name: z.string().min(1),
    enabled: z.boolean().optional(),
    argv: z.array(z.string()).min(1).optional(),
    env: z.record(z.string(), z.string()).nullable().optional(),
    enabledModels: z.array(z.string()).nullable().optional(),
  })
  .refine(
    (value) =>
      value.enabled !== undefined ||
      value.argv !== undefined ||
      value.env !== undefined ||
      value.enabledModels !== undefined,
    { message: "Provide at least one of enabled, argv, env, or enabledModels" },
  );

const settingsRemoveSchema = z.object({ name: z.string().min(1) });

type ApiErrorBody = {
  code: string;
  message: string;
  detailCode?: string;
  retryable?: boolean;
};

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_API_BODY_BYTES) {
      throw new Error("Request body is too large");
    }
    chunks.push(buffer);
  }
  if (size === 0) {
    throw new Error("A JSON request body is required");
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function installErrorResponse(error: unknown): { status: number; body: ApiErrorBody } {
  if (error instanceof AcpxOperationalError) {
    const detailCode = error.detailCode;
    const status =
      detailCode !== undefined && INSTALL_CLIENT_ERRORS.has(detailCode)
        ? 400
        : error.retryable === true
          ? 502
          : 500;
    return {
      status,
      body: {
        code: detailCode ?? "install_failed",
        message: error.message,
        ...(detailCode !== undefined ? { detailCode } : {}),
        ...(error.retryable !== undefined ? { retryable: error.retryable } : {}),
      },
    };
  }
  return { status: 500, body: { code: "install_failed", message: errorMessage(error) } };
}

async function handleRegistryList(
  response: http.ServerResponse,
  context: ApiContext,
): Promise<void> {
  try {
    const registry = await context.loadRegistry();
    const platformKey = registryPlatformKey();
    const config = await loadResolvedConfig(context.cwd);
    const configured = new Set([
      ...Object.keys(config.agents).map((name) => normalizeAgentName(name)),
      ...config.disabledAgents,
    ]);
    const agents = registry.agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      version: agent.version,
      ...(agent.description ? { description: agent.description } : {}),
      methods: listAgentDistributionMethods(agent),
      installable: selectInstallMethod(agent, undefined, platformKey) !== undefined,
      installed: configured.has(normalizeAgentName(agent.id)),
    }));
    writeJson(response, 200, {
      registryVersion: registry.version,
      platform: platformKey,
      agents,
    });
  } catch (error) {
    writeJson(response, 502, { error: installErrorResponse(error).body });
  }
}

async function handleRegistryInstall(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: ApiContext,
): Promise<void> {
  if (!context.allowInstall) {
    writeJson(response, 403, {
      error: {
        code: "install_disabled",
        message: "Registry installs are disabled (--no-install)",
      } satisfies ApiErrorBody,
    });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    writeJson(response, 400, {
      error: { code: "invalid_body", message: errorMessage(error) } satisfies ApiErrorBody,
    });
    return;
  }
  const parsed = installRequestSchema.safeParse(body);
  if (!parsed.success) {
    writeJson(response, 400, {
      error: {
        code: "invalid_body",
        message: parsed.error.issues[0]?.message ?? "Invalid install request",
      } satisfies ApiErrorBody,
    });
    return;
  }

  try {
    const registry = await context.loadRegistry();
    const agent = findRegistryAgent(registry, parsed.data.id);
    if (!agent) {
      writeJson(response, 404, {
        error: {
          code: "agent_not_found",
          message: `Registry agent not found: ${parsed.data.id}`,
        } satisfies ApiErrorBody,
      });
      return;
    }
    const result = await context.installAgent(agent, {
      ...(parsed.data.asName !== undefined ? { asName: parsed.data.asName } : {}),
      ...(parsed.data.method !== undefined ? { method: parsed.data.method } : {}),
      force: parsed.data.force === true,
    });
    // Refresh overrides so the freshly installed agent is selectable immediately.
    await context.getCatalog();
    writeJson(response, 200, { ok: true, result });
  } catch (error) {
    const { status, body: errorBody } = installErrorResponse(error);
    writeJson(response, status, { error: errorBody });
  }
}

function settingsErrorResponse(error: unknown): { status: number; body: ApiErrorBody } {
  if (error instanceof SettingsError) {
    return { status: 400, body: { code: error.code, message: error.message } };
  }
  return { status: 500, body: { code: "settings_write_failed", message: errorMessage(error) } };
}

async function handleSettingsList(
  response: http.ServerResponse,
  context: ApiContext,
): Promise<void> {
  try {
    const view = await context.getSettings();
    writeJson(response, 200, { ...view, writable: context.allowSettings });
  } catch (error) {
    writeJson(response, 500, { error: settingsErrorResponse(error).body });
  }
}

function writeInvalidSettingsBody(response: http.ServerResponse, error: z.ZodError): void {
  writeJson(response, 400, {
    error: {
      code: "invalid_body",
      message: error.issues[0]?.message ?? "Invalid settings request",
    } satisfies ApiErrorBody,
  });
}

async function handleSettingsMutation(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: ApiContext,
  action: "upsert" | "remove",
): Promise<void> {
  if (!context.allowSettings) {
    writeJson(response, 403, {
      error: {
        code: "settings_disabled",
        message: "Config editing is disabled (--no-settings)",
      } satisfies ApiErrorBody,
    });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    writeJson(response, 400, {
      error: { code: "invalid_body", message: errorMessage(error) } satisfies ApiErrorBody,
    });
    return;
  }

  let mutation: SettingsMutation;
  if (action === "remove") {
    const parsed = settingsRemoveSchema.safeParse(body);
    if (!parsed.success) {
      writeInvalidSettingsBody(response, parsed.error);
      return;
    }
    mutation = { action: "remove", name: parsed.data.name };
  } else {
    const parsed = settingsUpsertSchema.safeParse(body);
    if (!parsed.success) {
      writeInvalidSettingsBody(response, parsed.error);
      return;
    }
    const { name, enabled, argv, env, enabledModels } = parsed.data;
    mutation = {
      action: "upsert",
      name,
      ...(enabled !== undefined ? { enabled } : {}),
      ...(argv !== undefined ? { argv } : {}),
      ...(env !== undefined ? { env } : {}),
      ...(enabledModels !== undefined ? { enabledModels } : {}),
    };
  }

  try {
    const result = await context.applySettingsMutation(mutation);
    // Refresh the live registry so /api/agents reflects the change immediately.
    await context.getCatalog();
    // Push the new model allowlist to any live session on this agent.
    if (mutation.action === "upsert" && mutation.enabledModels !== undefined) {
      await context.refreshSessionModels(result.name);
    }
    writeJson(response, 200, { ok: true, name: result.name });
  } catch (error) {
    const { status, body: errorBody } = settingsErrorResponse(error);
    writeJson(response, status, { error: errorBody });
  }
}

type FsDirEntry = { name: string; path: string };

const diagnosticsRequestSchema = z.object({
  agents: z
    .array(
      z.object({
        name: z.string().min(1),
        argv: z.array(z.string()).optional(),
      }),
    )
    .optional(),
});

/** Starts a diagnostics run over the catalog's installed agents (or an explicit list). */
async function handleDiagnosticsStart(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: ApiContext,
): Promise<void> {
  let body: unknown = {};
  try {
    const raw = await readJsonBody(request);
    body = raw ?? {};
  } catch (error) {
    // An absent body means "use the defaults"; only reject real parse failures.
    const message = errorMessage(error);
    if (!/unexpected end|json request body is required/i.test(message)) {
      writeJson(response, 400, {
        error: { code: "invalid_body", message } satisfies ApiErrorBody,
      });
      return;
    }
    body = {};
  }
  const parsed = diagnosticsRequestSchema.safeParse(body);
  if (!parsed.success) {
    writeJson(response, 400, {
      error: {
        code: "invalid_body",
        message: parsed.error.issues[0]?.message ?? "Invalid body",
      } satisfies ApiErrorBody,
    });
    return;
  }

  let specs: AgentSpecInput[];
  if (parsed.data.agents !== undefined) {
    specs = parsed.data.agents.map((agent) => toAgentSpec(agent.name, agent.argv));
  } else {
    const catalog = await context.getCatalog();
    specs = catalog.agents
      .filter((agent) => agent.availability === "installed")
      .map((agent) => toAgentSpec(agent.id, agent.launch?.argv));
  }

  if (context.diagnostics.running) {
    writeJson(response, 409, {
      error: {
        code: "diagnostics_running",
        message: "A diagnostics run is already in progress",
      } satisfies ApiErrorBody,
    });
    return;
  }
  writeJson(response, 200, { ok: true, run: context.diagnostics.start(specs) });
}

const FS_DIR_LIMIT = 500;

/** Builds one diagnostics agent spec, omitting `argv` when it is unknown. */
function toAgentSpec(name: string, argv: string[] | undefined): AgentSpecInput {
  return argv ? { name, argv } : { name };
}

/** Spawns the agent once and returns its advertised model list (for the settings editor). */
async function handleModelProbe(
  response: http.ServerResponse,
  url: URL,
  context: ApiContext,
): Promise<void> {
  const agent = url.searchParams.get("agent")?.trim() ?? "";
  if (agent.length === 0) {
    writeJson(response, 400, {
      error: { code: "invalid_body", message: "An agent query parameter is required" },
    });
    return;
  }
  try {
    const result = await context.probeModels(agent);
    writeJson(response, 200, { ok: true, ...result });
  } catch (error) {
    writeJson(response, 502, {
      ok: false,
      error: { code: "model_probe_failed", message: errorMessage(error) },
    });
  }
}

/** Lists the subdirectories of one absolute path for the page's directory picker. */
async function handleFsDirs(response: http.ServerResponse, url: URL): Promise<void> {
  const requested = url.searchParams.get("path")?.trim() || os.homedir();
  const target = path.resolve(requested);
  try {
    const stat = await fs.promises.stat(target);
    if (!stat.isDirectory()) {
      writeJson(response, 400, { code: "fs_error", message: `Not a directory: ${target}` });
      return;
    }
    const dirents = await fs.promises.readdir(target, { withFileTypes: true });
    const entries: FsDirEntry[] = dirents
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => ({ name: dirent.name, path: path.join(target, dirent.name) }))
      .toSorted((left, right) => left.name.localeCompare(right.name))
      .slice(0, FS_DIR_LIMIT);
    const parent = path.dirname(target);
    writeJson(response, 200, {
      path: target,
      parent: parent === target ? null : parent,
      entries,
    });
  } catch (error) {
    writeJson(response, 400, { code: "fs_error", message: errorMessage(error) });
  }
}

export async function handleApiRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: ApiContext,
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://chat.invalid");

  if (url.pathname === "/api/health") {
    writeJson(response, 200, {
      service: CHAT_SERVER_ID,
      cwd: context.cwd,
      permissionMode: context.permissionMode,
      stateDir: context.stateDir,
      capabilities: {
        install: context.allowInstall,
        command: context.allowCommand,
        settings: context.allowSettings,
      },
    } satisfies ChatServerHealth);
    return true;
  }

  if (url.pathname === "/api/fs/dirs" && request.method === "GET") {
    await handleFsDirs(response, url);
    return true;
  }

  if (url.pathname === "/api/diagnostics" && request.method === "GET") {
    writeJson(response, 200, {
      running: context.diagnostics.running,
      run: context.diagnostics.snapshot() ?? null,
    });
    return true;
  }

  if (url.pathname === "/api/diagnostics" && request.method === "POST") {
    await handleDiagnosticsStart(request, response, context);
    return true;
  }

  if (url.pathname === "/api/agents" && request.method !== "POST") {
    const catalog = await context.getCatalog();
    writeJson(response, 200, { agents: catalog.agents satisfies AgentSummary[] });
    return true;
  }

  if (url.pathname === "/api/registry" && request.method === "GET") {
    await handleRegistryList(response, context);
    return true;
  }

  if (url.pathname === "/api/registry/install" && request.method === "POST") {
    await handleRegistryInstall(request, response, context);
    return true;
  }

  if (url.pathname === "/api/settings" && request.method === "GET") {
    await handleSettingsList(response, context);
    return true;
  }

  if (url.pathname === "/api/settings/agents" && request.method === "POST") {
    await handleSettingsMutation(request, response, context, "upsert");
    return true;
  }

  if (url.pathname === "/api/settings/agents/remove" && request.method === "POST") {
    await handleSettingsMutation(request, response, context, "remove");
    return true;
  }

  if (url.pathname === "/api/settings/models" && request.method === "GET") {
    await handleModelProbe(response, url, context);
    return true;
  }

  if (url.pathname === "/api/control/shutdown" && request.method === "POST") {
    writeJson(response, 200, { ok: true });
    setImmediate(() => {
      void context.requestClose().catch((error: unknown) => {
        console.error("acpx chat shutdown failed", error);
      });
    });
    return true;
  }

  return false;
}

export async function fetchChatServerHealth(baseUrl: string): Promise<ChatServerHealth | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 500);
  try {
    const response = await fetch(`${baseUrl}/api/health`, { signal: controller.signal });
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as Partial<ChatServerHealth>;
    return payload.service === CHAT_SERVER_ID && typeof payload.cwd === "string"
      ? {
          service: payload.service,
          cwd: payload.cwd,
          permissionMode: payload.permissionMode ?? "",
          stateDir: payload.stateDir ?? "",
        }
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function requestChatServerShutdown(baseUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 500);
  try {
    const response = await fetch(`${baseUrl}/api/control/shutdown`, {
      method: "POST",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

type ChatSocketServer = {
  handleUpgrade(
    request: http.IncomingMessage,
    socket: import("node:stream").Duplex,
    head: Buffer,
  ): boolean;
  close(): Promise<void>;
};

function createChatSocketServer(manager: ChatSessionManager): ChatSocketServer {
  const server = new WebSocketServer({ noServer: true });
  const chatsBySocket = new Map<WebSocket, Set<string>>();

  server.on("connection", (socket) => {
    const chats = new Set<string>();
    chatsBySocket.set(socket, chats);
    send(socket, { type: "ready", protocol: CHAT_PROTOCOL });

    socket.on("message", (data) => {
      void handleSocketMessage(socket, chats, data, manager).catch((error: unknown) => {
        send(socket, {
          type: "error",
          code: "internal_error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    });
    socket.on("error", () => socket.terminate());
    socket.on("close", () => {
      for (const chatId of chats) {
        manager.detach(chatId);
      }
      chatsBySocket.delete(socket);
    });
  });

  return {
    handleUpgrade(request, socket, head) {
      if (request.url !== "/api/chat") {
        return false;
      }
      server.handleUpgrade(request, socket, head, (ws) => {
        server.emit("connection", ws, request);
      });
      return true;
    },
    async close() {
      for (const socket of chatsBySocket.keys()) {
        socket.terminate();
      }
      chatsBySocket.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function handleSocketMessage(
  socket: WebSocket,
  chats: Set<string>,
  data: RawData,
  manager: ChatSessionManager,
): Promise<void> {
  let message: ReturnType<typeof chatClientMessageSchema.parse>;
  try {
    message = chatClientMessageSchema.parse(JSON.parse(rawDataToString(data)));
  } catch {
    send(socket, {
      type: "error",
      code: "protocol_error",
      message: "Invalid acpx chat message payload.",
    });
    return;
  }

  switch (message.type) {
    case "hello":
      if (message.protocol !== CHAT_PROTOCOL) {
        send(socket, {
          type: "error",
          code: "protocol_error",
          message: `Unsupported chat protocol: ${message.protocol}`,
        });
      }
      return;
    case "ping":
      send(socket, { type: "pong" });
      return;
    case "open_session": {
      chats.add(message.chatId);
      manager.attach(message.chatId, (outbound) => send(socket, outbound));
      const opened =
        message.command !== undefined
          ? await manager.openCommandSession({
              chatId: message.chatId,
              command: message.command,
              ...(message.cwd ? { cwd: message.cwd } : {}),
              ...(message.permissionMode ? { permissionMode: message.permissionMode } : {}),
            })
          : await manager.openSession({
              chatId: message.chatId,
              agent: message.agent ?? "",
              ...(message.cwd ? { cwd: message.cwd } : {}),
              ...(message.model ? { model: message.model } : {}),
              ...(message.permissionMode ? { permissionMode: message.permissionMode } : {}),
            });
      if (opened) {
        send(socket, {
          type: "session_opened",
          chatId: message.chatId,
          sessionKey: opened.sessionKey,
          agent: opened.agent,
          cwd: opened.cwd,
          ...(opened.model !== undefined ? { model: opened.model } : {}),
          ...(opened.models !== undefined ? { models: opened.models } : {}),
          ...(opened.permissionMode ? { permissionMode: opened.permissionMode } : {}),
        });
      }
      return;
    }
    case "set_model":
      await manager.setModel(message.chatId, message.model);
      return;
    case "send":
      await manager.send({
        chatId: message.chatId,
        text: message.text,
        requestId: message.requestId,
      });
      return;
    case "cancel":
      await manager.cancel(message.chatId);
      return;
    case "close_session":
      await manager.closeSession(message.chatId, message.discard === true);
      return;
  }
}

async function createUiMiddleware(host: string, port: number): Promise<ViteDevServer> {
  const uiDir = path.dirname(fileURLToPath(import.meta.url));
  return await createViteServer({
    configFile: resolveViteConfigFile(uiDir),
    appType: "spa",
    server: {
      middlewareMode: true,
      hmr: false,
      ws: false,
      host,
      port,
      strictPort: false,
    },
  });
}

function resolveViteConfigFile(serverDir: string): string {
  const coLocated = path.join(serverDir, "..", "vite.config.ts");
  if (fs.existsSync(coLocated)) {
    return coLocated;
  }
  return path.resolve(process.cwd(), "examples/acp-chat/vite.config.ts");
}

async function closeChatServer(input: {
  server: http.Server;
  vite: ViteDevServer | null;
  chatSockets: ChatSocketServer;
  manager: ChatSessionManager;
}): Promise<void> {
  await input.chatSockets.close();
  await new Promise<void>((resolve, reject) => {
    input.server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  }).finally(async () => {
    await input.vite?.close();
    await input.manager.shutdown();
  });
}

function send(socket: WebSocket, message: ChatServerMessage): void {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify(message));
}

function rawDataToString(data: RawData): string {
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

function writeJson(response: http.ServerResponse, statusCode: number, value: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
