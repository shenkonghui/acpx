import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { PermissionMode } from "../../src/types.js";
import {
  createChatServer,
  DEFAULT_CHAT_HOST,
  DEFAULT_CHAT_PORT,
  defaultChatStateDir,
  fetchChatServerHealth,
  requestChatServerShutdown,
} from "./server/chat-server.js";
import { formatChatOrigin } from "./server/request-origin.js";

export type ChatCliCommand = "start" | "status" | "stop";

export type ChatCliOptions = {
  command: ChatCliCommand;
  host: string;
  port: number;
  cwd: string;
  permissionMode: PermissionMode;
  stateDir: string;
  agentsConfig?: string;
  allowInstall: boolean;
  allowCommand: boolean;
  open: boolean;
  verbose: boolean;
};

export const CHAT_HELP_TEXT = `Usage: pnpm chat [start|status|stop] [options]

Options:
  --host <host>                 Host to bind or inspect (default: 127.0.0.1)
  --port <port>                 Port to bind or inspect (default: 4174; 0 picks a free port)
  --cwd <dir>                   Default working directory for agent sessions (default: cwd)
  --permission-mode <mode>      approve-all | approve-reads | deny-all (default: approve-all)
  --state-dir <path>            Session state directory (default: ~/.acpx/acp-chat)
  --agents-config <path>        Extra agents from an acpx gateway --config JSON file
  --no-install                  Disable installing agents from the ACP registry in the page
  --no-command                  Disable running ad-hoc commands from the page
  --verbose                     Log chat lifecycle events to stderr
  --open                        Open the chat page in a browser after start
  -h, --help                    Show help
`;

const PERMISSION_MODES: readonly PermissionMode[] = ["approve-all", "approve-reads", "deny-all"];

export function parseChatCliArgs(argv: readonly string[]): ChatCliOptions {
  let command: ChatCliCommand = "start";
  let host = DEFAULT_CHAT_HOST;
  let port = DEFAULT_CHAT_PORT;
  let cwd = process.cwd();
  let permissionMode: PermissionMode = "approve-all";
  let stateDir = defaultChatStateDir();
  let agentsConfig: string | undefined;
  let allowInstall = true;
  let allowCommand = true;
  let open = false;
  let verbose = false;

  const args = [...argv];
  const first = args[0];
  if (first === "start" || first === "status" || first === "stop") {
    command = first;
    args.shift();
  }

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (!current) {
      continue;
    }
    if (current === "--open") {
      open = true;
      continue;
    }
    if (current === "--verbose") {
      verbose = true;
      continue;
    }
    if (current === "--no-install") {
      allowInstall = false;
      continue;
    }
    if (current === "--no-command") {
      allowCommand = false;
      continue;
    }
    const [flag, inline] = splitInlineFlag(current);
    switch (flag) {
      case "--host":
        host = inline ?? requireArgValue(args, ++index, "--host");
        break;
      case "--port":
        port = parsePort(inline ?? requireArgValue(args, ++index, "--port"));
        break;
      case "--cwd":
        cwd = path.resolve(inline ?? requireArgValue(args, ++index, "--cwd"));
        break;
      case "--permission-mode":
        permissionMode = parsePermissionMode(
          inline ?? requireArgValue(args, ++index, "--permission-mode"),
        );
        break;
      case "--state-dir":
        stateDir = path.resolve(inline ?? requireArgValue(args, ++index, "--state-dir"));
        break;
      case "--agents-config":
        agentsConfig = path.resolve(inline ?? requireArgValue(args, ++index, "--agents-config"));
        break;
      default:
        throw new Error(`Unknown acpx chat argument: ${current}`);
    }
  }

  return {
    command,
    host,
    port,
    cwd,
    permissionMode,
    stateDir,
    ...(agentsConfig !== undefined ? { agentsConfig } : {}),
    allowInstall,
    allowCommand,
    open,
    verbose,
  };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (argv[0] === "help" || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(CHAT_HELP_TEXT);
    return;
  }

  const options = parseChatCliArgs(argv);
  const baseUrl = formatChatOrigin(options.host, options.port);

  switch (options.command) {
    case "status": {
      const health = await fetchChatServerHealth(baseUrl);
      if (!health) {
        process.stdout.write(`acpx chat is not running at ${baseUrl}/\n`);
        return;
      }
      process.stdout.write(`acpx chat is running at ${baseUrl}/\n`);
      process.stdout.write(`cwd: ${health.cwd}\n`);
      process.stdout.write(`permissions: ${health.permissionMode}\n`);
      process.stdout.write(`state dir: ${health.stateDir}\n`);
      return;
    }
    case "stop": {
      const stopped = await requestChatServerShutdown(baseUrl);
      process.stdout.write(
        stopped
          ? `Stopped acpx chat at ${baseUrl}/\n`
          : `acpx chat is not running at ${baseUrl}/\n`,
      );
      return;
    }
    case "start": {
      const health = await fetchChatServerHealth(baseUrl);
      if (health) {
        if (normalizeDir(health.cwd) !== normalizeDir(options.cwd)) {
          throw new Error(
            `acpx chat is already running at ${baseUrl}/ for ${health.cwd}, not ${options.cwd}`,
          );
        }
        process.stdout.write(`Reused existing acpx chat at ${baseUrl}/\n`);
        if (options.open) {
          await openChatUrl(baseUrl);
        }
        return;
      }

      const server = await createChatServer({
        host: options.host,
        port: options.port,
        cwd: options.cwd,
        permissionMode: options.permissionMode,
        stateDir: options.stateDir,
        verbose: options.verbose,
        allowInstall: options.allowInstall,
        allowCommand: options.allowCommand,
        ...(options.agentsConfig !== undefined ? { gatewayConfigPath: options.agentsConfig } : {}),
      });

      process.stdout.write(`Started acpx chat at ${server.baseUrl}/\n`);
      process.stdout.write(`cwd: ${server.cwd}\n`);
      process.stdout.write(`permissions: ${server.permissionMode}\n`);

      if (options.open) {
        await openChatUrl(server.baseUrl);
      }

      const close = async (): Promise<void> => {
        await server.close();
      };
      process.on("SIGINT", () => {
        void close().finally(() => process.exit(0));
      });
      process.on("SIGTERM", () => {
        void close().finally(() => process.exit(0));
      });
      return;
    }
  }
}

async function openChatUrl(url: string): Promise<void> {
  const { command, args } = resolveOpenCommand(url);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`chat open command exited with code ${code ?? "null"}`));
    });
  });
}

function resolveOpenCommand(url: string): { command: string; args: string[] } {
  switch (process.platform) {
    case "darwin":
      return { command: "open", args: [url] };
    case "win32":
      return { command: "cmd", args: ["/c", "start", "", url] };
    default:
      return { command: "xdg-open", args: [url] };
  }
}

function splitInlineFlag(value: string): [string, string | undefined] {
  if (!value.startsWith("--")) {
    return [value, undefined];
  }
  const equals = value.indexOf("=");
  if (equals === -1) {
    return [value, undefined];
  }
  return [value.slice(0, equals), value.slice(equals + 1)];
}

function normalizeDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

function requireArgValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index]?.trim();
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePort(rawPort: string): number {
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid acpx chat port: ${rawPort}`);
  }
  return port;
}

function parsePermissionMode(rawMode: string): PermissionMode {
  if (!PERMISSION_MODES.includes(rawMode as PermissionMode)) {
    throw new Error(
      `Invalid permission mode: ${rawMode} (expected one of ${PERMISSION_MODES.join(", ")})`,
    );
  }
  return rawMode as PermissionMode;
}

function isChatEntrypoint(argv: readonly string[]): boolean {
  const entry = argv[1];
  if (!entry) {
    return false;
  }
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isChatEntrypoint(process.argv)) {
  void main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  });
}
