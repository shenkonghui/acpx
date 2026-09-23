import { spawn, type ChildProcessByStdio } from "node:child_process";
import { Transform, type Readable, type Writable, type TransformCallback } from "node:stream";
import { AgentSpawnError } from "../errors.js";
import { buildAgentSpawnCommand } from "../spawn-command-options.js";
import { EXIT_CODES, type AcpClientOptions } from "../types.js";
import {
  resolveAgentCloseAfterStdinEndMs,
  shouldIgnoreNonJsonAgentOutputLine,
} from "./agent-command.js";
import {
  createStandaloneCommandReader,
  ensureAgentLaunchSupport,
  logAgentLaunch,
  resolveAgentLaunchPlan,
  retireAgentProcess,
  type AgentLaunchPlan,
} from "./agent-launch.js";
import { requireAgentStdio, waitForSpawn } from "./client-process.js";
import { withDevinClientIdentity } from "./client-protocol.js";
import { asRecord } from "./jsonrpc.js";
import { ProcessDescendants } from "./process-descendants.js";

const DEVIN_DIAGNOSTICS_METHOD = "_cognition.ai/request_diagnostics";

type JsonObject = Record<string, unknown>;
type AgentChild = ChildProcessByStdio<Writable, Readable, Readable>;
type LineMapper = (line: string) => string | undefined;
type ProxyRetireReason = "upstream-eof" | "signal";

type AcpProxyOptions = {
  agentCommand: string;
  agentArgv?: readonly string[];
  cwd: string;
  authCredentials?: Record<string, string>;
  sessionOptions?: AcpClientOptions["sessionOptions"];
  agentProcessEnv?: Record<string, string>;
  verbose?: boolean;
};

class JsonLineMapper extends Transform {
  private fragment = "";

  constructor(private readonly mapLine: LineMapper) {
    super();
  }

  override _transform(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const parts = this.fragment + chunk.toString("utf8");
    const lines = parts.split("\n");
    this.fragment = lines.pop() ?? "";
    for (const line of lines) {
      const forwarded = this.mapLine(line);
      if (forwarded !== undefined) {
        this.push(`${forwarded}\n`);
      }
    }
    callback();
  }

  override _flush(callback: TransformCallback): void {
    const forwarded = this.fragment.trim() ? this.mapLine(this.fragment) : undefined;
    this.fragment = "";
    if (forwarded !== undefined) {
      this.push(`${forwarded}\n`);
    }
    callback();
  }
}

function parseJsonObject(line: string): JsonObject | undefined {
  try {
    return asRecord(JSON.parse(line)) ?? undefined;
  } catch {
    return undefined;
  }
}

function rewriteInitializeForDevin(message: JsonObject): JsonObject {
  const params = asRecord(message.params);
  if (message.method === "initialize" && params) {
    return { ...message, params: withDevinClientIdentity(params) };
  }
  return message;
}

function answerDevinDiagnostics(child: AgentChild, message: JsonObject): JsonObject | undefined {
  if (message.method === DEVIN_DIAGNOSTICS_METHOD && Object.hasOwn(message, "id")) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} })}\n`);
    return undefined;
  }
  return message;
}

function mapClientLine(line: string, devin: boolean): string | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }
  const message = parseJsonObject(trimmed);
  if (!message || !devin) {
    return line;
  }
  const rewritten = rewriteInitializeForDevin(message);
  return rewritten === message ? line : JSON.stringify(rewritten);
}

function mapAgentLine(
  line: string,
  agentCommand: string,
  child: AgentChild,
  devin: boolean,
): string | undefined {
  const trimmed = line.trim();
  if (!trimmed || shouldIgnoreNonJsonAgentOutputLine(agentCommand, trimmed)) {
    return undefined;
  }
  const message = parseJsonObject(trimmed);
  if (!message) {
    // Agent stdout is a protocol stream; stray output must not corrupt it.
    process.stderr.write(`[acpx] agent stdout (non-JSON): ${line}\n`);
    return undefined;
  }
  if (!devin) {
    return line;
  }
  const rewritten = answerDevinDiagnostics(child, message);
  return rewritten === undefined
    ? undefined
    : rewritten === message
      ? line
      : JSON.stringify(rewritten);
}

async function spawnProxyAgent(plan: AgentLaunchPlan, agentCommand: string): Promise<AgentChild> {
  const resolved = buildAgentSpawnCommand(
    plan.spawnCommand,
    plan.args,
    process.platform,
    plan.spawnOptions.env,
  );
  let spawnedChild;
  try {
    spawnedChild = spawn(resolved.command, resolved.args, {
      ...plan.spawnOptions,
      windowsVerbatimArguments: resolved.windowsVerbatimArguments,
    });
    await waitForSpawn(spawnedChild);
  } catch (error) {
    throw new AgentSpawnError(agentCommand, error);
  }
  return requireAgentStdio(spawnedChild);
}

function waitForAgentClose(child: AgentChild): Promise<number | null> {
  return new Promise((resolve) => {
    child.once("close", (code) => resolve(code));
  });
}

async function relayProxyTraffic(
  child: AgentChild,
  plan: AgentLaunchPlan,
  options: AcpProxyOptions,
  log: (message: string) => void,
): Promise<number> {
  const descendants = new ProcessDescendants(child);
  process.stdin.setEncoding("utf8");
  child.stdout.setEncoding("utf8");

  const clientToAgent = new JsonLineMapper((line) => mapClientLine(line, plan.devinAcp));
  const agentToClient = new JsonLineMapper((line) =>
    mapAgentLine(line, options.agentCommand, child, plan.devinAcp),
  );
  process.stdin.pipe(clientToAgent).pipe(child.stdin);
  child.stdout.pipe(agentToClient).pipe(process.stdout, { end: false });

  let reason: ProxyRetireReason | undefined;
  let retiring: Promise<void> | undefined;
  const finish = () => {
    descendants.retire();
    process.stdin.destroy();
  };
  const retire = (next: ProxyRetireReason): void => {
    reason ??= next;
    retiring ??= retireAgentProcess(child, descendants, {
      stdinCloseGraceMs: resolveAgentCloseAfterStdinEndMs(options.agentCommand),
      log,
    }).finally(finish);
  };

  const onSignal = () => retire("signal");
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  clientToAgent.on("end", () => retire("upstream-eof"));

  try {
    const code = await waitForAgentClose(child);
    if (reason === "signal") {
      return EXIT_CODES.INTERRUPTED;
    }
    return reason === "upstream-eof" ? EXIT_CODES.SUCCESS : (code ?? 1);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    if (!retiring) {
      finish();
    }
    await retiring;
  }
}

export async function runAcpProxy(options: AcpProxyOptions): Promise<number> {
  const log = (message: string): void => {
    if (options.verbose) {
      process.stderr.write(`[acpx] ${message}\n`);
    }
  };
  const plan = await resolveAgentLaunchPlan(
    {
      agentCommand: options.agentCommand,
      agentArgv: options.agentArgv,
      cwd: options.cwd,
      authCredentials: options.authCredentials,
      sessionOptions: options.sessionOptions,
      agentProcessEnv: options.agentProcessEnv,
    },
    createStandaloneCommandReader,
  );
  logAgentLaunch(plan, log);
  await ensureAgentLaunchSupport(plan, log);

  const child = await spawnProxyAgent(plan, options.agentCommand);
  child.stderr.pipe(process.stderr);
  // Agent may die while upstream still writes; close/exit code already reports that.
  child.stdin.on("error", () => {});

  return await relayProxyTraffic(child, plan, options, log);
}
