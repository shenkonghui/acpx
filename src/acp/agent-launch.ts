import { spawn, type ChildProcess } from "node:child_process";
import { resolveBuiltInAgentLaunch } from "../agent-registry.js";
import { buildAgentSpawnCommand } from "../spawn-command-options.js";
import type { AcpClientOptions } from "../types.js";
import {
  buildQoderAcpCommandArgs,
  ensureCopilotAcpSupport,
  isClaudeAcpCommand,
  isCopilotAcpCommand,
  isDevinAcpCommand,
  isGeminiAcpCommand,
  isQoderAcpCommand,
  resolveClaudeCodeExecutable,
  resolveGeminiCommandArgs,
  type AgentCommandContext,
} from "./agent-command.js";
import { buildAgentSpawnOptions } from "./auth-env.js";
import {
  isChildProcessRunning,
  resolveAgentCommandParts,
  waitForChildExit,
  waitForSpawn,
} from "./client-process.js";
import { captureCommandProbeOutput } from "./command-probe.js";
import { ProcessDescendants } from "./process-descendants.js";

const AGENT_CLOSE_TERM_GRACE_MS = 1_500;
const AGENT_CLOSE_KILL_GRACE_MS = 1_000;
const AGENT_CLEANUP_BUDGET_MS = 8_000;

export type AgentLaunchPlan = {
  spawnCommand: string;
  args: string[];
  resolvedBuiltInLaunch: ReturnType<typeof resolveBuiltInAgentLaunch>;
  devinAcp: boolean;
  geminiAcp: boolean;
  copilotAcp: boolean;
  claudeAcp: boolean;
  spawnOptions: ReturnType<typeof buildAgentSpawnOptions>;
  commandContext: AgentCommandContext;
};

export type AgentLaunchRequest = {
  agentCommand: string;
  agentArgv?: readonly string[];
  cwd: string;
  authCredentials?: Record<string, string>;
  sessionOptions?: AcpClientOptions["sessionOptions"];
  agentProcessEnv?: Record<string, string>;
};

export async function resolveAgentLaunchPlan(
  request: AgentLaunchRequest,
  createReadOutput: (
    spawnOptions: ReturnType<typeof buildAgentSpawnOptions>,
  ) => AgentCommandContext["readOutput"],
): Promise<AgentLaunchPlan> {
  const configuredCommand = resolveAgentCommandParts(request.agentCommand, request.agentArgv);
  const resolvedBuiltInLaunch = resolveBuiltInAgentLaunch(request.agentCommand);
  const spawnCommand = resolvedBuiltInLaunch?.command ?? configuredCommand.command;
  const spawnOptions = buildAgentSpawnOptions(
    request.cwd,
    request.authCredentials,
    request.sessionOptions?.env,
    request.agentProcessEnv,
  );
  const commandContext: AgentCommandContext = {
    env: spawnOptions.env,
    readOutput: createReadOutput(spawnOptions),
  };
  let args = resolvedBuiltInLaunch?.args ?? configuredCommand.args;
  args = await resolveGeminiCommandArgs(spawnCommand, args, commandContext);
  if (isQoderAcpCommand(spawnCommand, args)) {
    args = buildQoderAcpCommandArgs(args, { sessionOptions: request.sessionOptions });
  }
  return {
    spawnCommand,
    args,
    resolvedBuiltInLaunch,
    devinAcp: isDevinAcpCommand(spawnCommand, args),
    geminiAcp: isGeminiAcpCommand(spawnCommand, args),
    copilotAcp: isCopilotAcpCommand(spawnCommand, args),
    claudeAcp: isClaudeAcpCommand(spawnCommand, args),
    spawnOptions,
    commandContext,
  };
}

export function logAgentLaunch(plan: AgentLaunchPlan, log: (message: string) => void): void {
  const launch = plan.resolvedBuiltInLaunch;
  if (launch?.source === "installed") {
    log(
      `spawning installed built-in agent ${launch.packageName}${launch.packageVersion ? `@${launch.packageVersion}` : ""} via ${plan.spawnCommand} ${plan.args.join(" ")}`,
    );
    return;
  }
  if (launch?.source === "package-exec") {
    log(
      `spawning built-in agent ${launch.packageName}@${launch.packageRange} via current Node package exec bridge ${plan.spawnCommand} ${plan.args.join(" ")}`,
    );
    return;
  }
  log(`spawning agent: ${plan.spawnCommand} ${plan.args.join(" ")}`);
}

export async function ensureAgentLaunchSupport(
  plan: AgentLaunchPlan,
  log: (message: string) => void,
): Promise<void> {
  if (plan.copilotAcp) {
    await ensureCopilotAcpSupport(plan.spawnCommand, plan.commandContext);
  }
  if (!plan.claudeAcp) {
    return;
  }
  const claudeExe = resolveClaudeCodeExecutable(process.platform, plan.spawnOptions.env);
  if (claudeExe) {
    plan.spawnOptions.env.CLAUDE_CODE_EXECUTABLE = claudeExe;
    log(`resolved system Claude Code executable: ${claudeExe}`);
  }
}

function endAgentStdin(child: ChildProcess): void {
  // Closing stdin is the most graceful shutdown signal for stdio-based ACP agents.
  if (!child.stdin || child.stdin.destroyed) {
    return;
  }
  try {
    child.stdin.end();
  } catch {
    // best effort
  }
}

async function signalAgentAndDescendants(
  child: ChildProcess,
  descendants: ProcessDescendants | undefined,
  signal: NodeJS.Signals,
  waitMs: number,
  deadline: number,
): Promise<boolean> {
  if (descendants && performance.now() < deadline) {
    await descendants.signal(signal, deadline - performance.now());
  }
  if (isChildProcessRunning(child)) {
    try {
      child.kill(signal);
    } catch {
      // The direct child may have exited during descendant inspection.
    }
  }
  const remaining = Math.min(waitMs, Math.max(0, deadline - performance.now()));
  const [exited, descendantsExited] = await Promise.all([
    waitForChildExit(child, remaining),
    descendants ? descendants.waitForExit(remaining) : Promise.resolve(true),
  ]);
  return exited && descendantsExited;
}

export async function retireAgentProcess(
  child: ChildProcess,
  descendants: ProcessDescendants | undefined,
  options: {
    stdinCloseGraceMs: number;
    log: (message: string) => void;
    budgetMs?: number;
  },
): Promise<void> {
  const deadline = performance.now() + (options.budgetMs ?? AGENT_CLEANUP_BUDGET_MS);
  if (descendants) {
    await descendants.capture(Math.max(1, deadline - performance.now()));
  }
  endAgentStdin(child);
  await waitForChildExit(
    child,
    Math.min(options.stdinCloseGraceMs, Math.max(0, deadline - performance.now())),
  );
  const exited = await signalAgentAndDescendants(
    child,
    descendants,
    "SIGTERM",
    AGENT_CLOSE_TERM_GRACE_MS,
    deadline,
  );
  if (!exited) {
    options.log("agent processes did not exit after SIGTERM; forcing SIGKILL");
    await signalAgentAndDescendants(
      child,
      descendants,
      "SIGKILL",
      AGENT_CLOSE_KILL_GRACE_MS,
      deadline,
    );
  }
}

export function createStandaloneCommandReader(
  spawnOptions: Pick<ReturnType<typeof buildAgentSpawnOptions>, "cwd" | "env">,
): AgentCommandContext["readOutput"] {
  return async (command, args, timeoutMs) => {
    const resolved = buildAgentSpawnCommand(command, args, process.platform, spawnOptions.env);
    let child: ChildProcess;
    try {
      child = spawn(resolved.command, resolved.args, {
        cwd: spawnOptions.cwd,
        env: spawnOptions.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: resolved.windowsVerbatimArguments,
        detached: process.platform !== "win32",
      });
    } catch {
      return undefined;
    }
    const descendants = new ProcessDescendants(child, { ownProcessGroup: true });
    let retiring: Promise<void> | undefined;
    const retire = () =>
      (retiring ??= retireAgentProcess(child, descendants, {
        stdinCloseGraceMs: 0,
        log: () => {},
      }).finally(() => descendants.retire()));
    const capture = captureCommandProbeOutput(child, timeoutMs, retire);
    try {
      await waitForSpawn(child);
      return await capture.result;
    } catch {
      return undefined;
    } finally {
      try {
        await retire();
      } finally {
        capture.dispose();
      }
    }
  };
}
