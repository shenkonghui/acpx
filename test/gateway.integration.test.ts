import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type InitializeResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type SessionNotification,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from "@agentclientprotocol/sdk";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));

const AGENT_ALPHA = "alpha";
const AGENT_BETA = "beta";

const AGENT_SCRIPT = `
import readline from 'node:readline';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
function argValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
const label = argValue('--label') ?? 'agent';
const pidFile = argValue('--pid-file');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
if (pidFile) writeFileSync(pidFile, \`\${process.pid}\\n\`);
let counter = 0;
const pendingPrompts = new Map();

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    return;
  }
  if (message.method === 'session/new') {
    counter += 1;
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: \`\${label}-s\${counter}\` } });
    return;
  }
  if (message.method === 'session/prompt') {
    const blocks = Array.isArray(message.params?.prompt) ? message.params.prompt : [];
    const text = blocks
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join(' ');
    if (text.trim() === 'hang') {
      pendingPrompts.set(message.id, message.params.sessionId);
      return;
    }
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: message.params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: \`\${label}:ok \${text}\` } },
      },
    });
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
    return;
  }
  if (message.method === 'session/cancel') {
    for (const [requestId] of pendingPrompts) {
      send({ jsonrpc: '2.0', id: requestId, result: { stopReason: 'cancelled' } });
    }
    pendingPrompts.clear();
    return;
  }
  if (message.id !== undefined && message.id !== null) {
    send({ jsonrpc: '2.0', id: message.id, result: {} });
  }
}).on('close', () => process.exit(0));
`;

class GatewayTestClient implements Client {
  readonly updates: SessionNotification[] = [];

  async sessionUpdate(params: SessionNotification): Promise<void> {
    this.updates.push(params);
  }

  async requestPermission(params: {
    options: Array<{ optionId: string; kind: string }>;
  }): Promise<{ outcome: { outcome: "selected"; optionId: string } }> {
    const allow = params.options.find(
      (option) => option.kind === "allow_once" || option.kind === "allow_always",
    );
    return { outcome: { outcome: "selected", optionId: (allow ?? params.options[0]).optionId } };
  }

  async readTextFile(_params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    return { content: "" };
  }

  async writeTextFile(_params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    return {};
  }

  updateTexts(): string[] {
    return this.updates.flatMap((update) => {
      const record = update.update as { content?: { type?: string; text?: string } };
      return record.content?.type === "text" && typeof record.content.text === "string"
        ? [record.content.text]
        : [];
    });
  }
}

type GatewayHarness = {
  client: GatewayTestClient;
  connection: ClientSideConnection;
  child: ReturnType<typeof spawn>;
  stderrText: string;
};

async function spawnAgentScript(
  homeDir: string,
  label: string,
): Promise<{ command: string; scriptPath: string; pidFile: string }> {
  const scriptPath = path.join(homeDir, `${label}-agent.mjs`);
  await fs.writeFile(scriptPath, AGENT_SCRIPT, "utf8");
  const pidFile = path.join(homeDir, `${label}.pid`);
  const command = `node ${JSON.stringify(scriptPath)} --label ${label} --pid-file ${JSON.stringify(pidFile)}`;
  return { command, scriptPath, pidFile };
}

function spawnGateway(
  homeDir: string,
  cwd: string,
  agentCommands: string[],
  configPath?: string,
): GatewayHarness {
  const agentArgs = configPath !== undefined ? ["--config", configPath] : agentCommands;
  const child = spawn(
    process.execPath,
    [CLI_PATH, "gateway", ...agentArgs, "--cwd", cwd, "--approve-all"],
    {
      cwd: homeDir,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  const input = Writable.toWeb(child.stdin);
  const output = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  const client = new GatewayTestClient();
  const connection = new ClientSideConnection(() => client, ndJsonStream(input, output));
  const harness: GatewayHarness = {
    client,
    connection,
    child,
    get stderrText(): string {
      return stderr;
    },
  };
  return harness;
}

async function initializeGateway(harness: GatewayHarness): Promise<InitializeResponse> {
  return await harness.connection.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      fs: {
        readTextFile: true,
        writeTextFile: true,
      },
    },
    clientInfo: {
      name: "acpx-gateway-test",
      version: "0.0.0",
    },
  });
}

function newSessionMeta(agentName: string): { acpx: { agent: string } } {
  return { acpx: { agent: agentName } };
}

async function waitForAgentExit(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-gateway-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    await run(homeDir);
  } finally {
    process.env.HOME = previousHome;
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

test("gateway: initialize handshake", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-gateway-cwd-"));
    const alpha = await spawnAgentScript(homeDir, AGENT_ALPHA);
    const harness = spawnGateway(homeDir, cwd, [alpha.command]);
    try {
      const result = await initializeGateway(harness);
      assert.equal(typeof result.protocolVersion, "number");
      assert.equal(result.authMethods?.length ?? 0, 0);
    } finally {
      harness.child.kill("SIGTERM");
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("gateway: routes sessions by _meta agent selection", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-gateway-cwd-"));
    const alpha = await spawnAgentScript(homeDir, AGENT_ALPHA);
    const beta = await spawnAgentScript(homeDir, AGENT_BETA);
    const harness = spawnGateway(homeDir, cwd, [alpha.command, beta.command]);
    try {
      await initializeGateway(harness);

      const defaultSession = await harness.connection.newSession({
        cwd,
        mcpServers: [],
      });
      await harness.connection.prompt({
        sessionId: defaultSession.sessionId,
        prompt: [{ type: "text", text: "hello" }],
      });
      assert.ok(
        harness.client.updateTexts().some((text) => text.includes(`${AGENT_ALPHA}:ok hello`)),
        `expected default agent alpha output, got: ${harness.client.updateTexts().join(" | ")}`,
      );

      const betaSession = await harness.connection.newSession({
        cwd,
        mcpServers: [],
        _meta: newSessionMeta(beta.command),
      });
      await harness.connection.prompt({
        sessionId: betaSession.sessionId,
        prompt: [{ type: "text", text: "hello" }],
      });
      assert.ok(
        harness.client.updateTexts().some((text) => text.includes(`${AGENT_BETA}:ok hello`)),
        `expected beta agent output, got: ${harness.client.updateTexts().join(" | ")}`,
      );
    } finally {
      harness.child.kill("SIGTERM");
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("gateway: concurrent prompts on different agents", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-gateway-cwd-"));
    const alpha = await spawnAgentScript(homeDir, AGENT_ALPHA);
    const beta = await spawnAgentScript(homeDir, AGENT_BETA);
    const harness = spawnGateway(homeDir, cwd, [alpha.command, beta.command]);
    try {
      await initializeGateway(harness);
      const alphaSession = await harness.connection.newSession({ cwd, mcpServers: [] });
      const betaSession = await harness.connection.newSession({
        cwd,
        mcpServers: [],
        _meta: newSessionMeta(beta.command),
      });
      const [alphaResult, betaResult] = await Promise.all([
        harness.connection.prompt({
          sessionId: alphaSession.sessionId,
          prompt: [{ type: "text", text: "one" }],
        }),
        harness.connection.prompt({
          sessionId: betaSession.sessionId,
          prompt: [{ type: "text", text: "two" }],
        }),
      ]);
      assert.equal(alphaResult.stopReason, "end_turn");
      assert.equal(betaResult.stopReason, "end_turn");
      const texts = harness.client.updateTexts().join(" | ");
      assert.match(texts, /alpha:ok one/);
      assert.match(texts, /beta:ok two/);
    } finally {
      harness.child.kill("SIGTERM");
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("gateway: cancel routes to the bound agent", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-gateway-cwd-"));
    const alpha = await spawnAgentScript(homeDir, AGENT_ALPHA);
    const harness = spawnGateway(homeDir, cwd, [alpha.command]);
    try {
      await initializeGateway(harness);
      const session = await harness.connection.newSession({ cwd, mcpServers: [] });
      const promptPromise = harness.connection.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "hang" }],
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      await harness.connection.cancel({ sessionId: session.sessionId });
      const result = await promptPromise;
      assert.equal(result.stopReason, "cancelled");
    } finally {
      harness.child.kill("SIGTERM");
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("gateway: unknown session and unknown agent produce protocol errors", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-gateway-cwd-"));
    const alpha = await spawnAgentScript(homeDir, AGENT_ALPHA);
    const harness = spawnGateway(homeDir, cwd, [alpha.command]);
    try {
      await initializeGateway(harness);

      await assert.rejects(
        harness.connection.prompt({
          sessionId: "gw-does-not-exist",
          prompt: [{ type: "text", text: "hi" }],
        }),
        (error: unknown) => {
          const code = (error as { code?: unknown }).code;
          return code === -32602;
        },
      );

      await assert.rejects(
        harness.connection.newSession({
          cwd,
          mcpServers: [],
          _meta: newSessionMeta("no-such-agent"),
        }),
        (error: unknown) => {
          const message = (error as { message?: unknown }).message;
          return typeof message === "string" && message.includes("no-such-agent");
        },
      );
    } finally {
      harness.child.kill("SIGTERM");
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("gateway: --config file routes by agent name", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-gateway-cwd-"));
    const alpha = await spawnAgentScript(homeDir, AGENT_ALPHA);
    const beta = await spawnAgentScript(homeDir, AGENT_BETA);
    const configPath = path.join(homeDir, "gateway.agents.json");
    const config = {
      agents: [
        {
          name: "alpha",
          command: "node",
          args: [alpha.scriptPath, "--label", AGENT_ALPHA, "--pid-file", alpha.pidFile],
          default: true,
        },
        { name: "beta", argv: ["node", beta.scriptPath, "--label", AGENT_BETA] },
      ],
    };
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    const harness = spawnGateway(homeDir, cwd, [], configPath);
    try {
      await initializeGateway(harness);

      const defaultSession = await harness.connection.newSession({ cwd, mcpServers: [] });
      await harness.connection.prompt({
        sessionId: defaultSession.sessionId,
        prompt: [{ type: "text", text: "hello" }],
      });
      assert.ok(
        harness.client.updateTexts().some((text) => text.includes(`${AGENT_ALPHA}:ok hello`)),
        `expected default agent alpha output, got: ${harness.client.updateTexts().join(" | ")}`,
      );

      const betaSession = await harness.connection.newSession({
        cwd,
        mcpServers: [],
        _meta: newSessionMeta("beta"),
      });
      await harness.connection.prompt({
        sessionId: betaSession.sessionId,
        prompt: [{ type: "text", text: "hello" }],
      });
      assert.ok(
        harness.client.updateTexts().some((text) => text.includes(`${AGENT_BETA}:ok hello`)),
        `expected beta agent output, got: ${harness.client.updateTexts().join(" | ")}`,
      );
    } finally {
      harness.child.kill("SIGTERM");
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("gateway: upstream stdin EOF retires all agents and exits cleanly", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-gateway-cwd-"));
    const alpha = await spawnAgentScript(homeDir, AGENT_ALPHA);
    const beta = await spawnAgentScript(homeDir, AGENT_BETA);
    const harness = spawnGateway(homeDir, cwd, [alpha.command, beta.command]);
    try {
      await initializeGateway(harness);
      const exited = new Promise<number | null>((resolve) => {
        harness.child.once("exit", (code) => resolve(code));
      });
      harness.child.stdin?.end();
      assert.equal(await exited, 0, `gateway stderr: ${harness.stderrText}`);
      assert.equal(
        await waitForAgentExit(await readPid(alpha.pidFile)),
        true,
        "alpha agent must exit",
      );
      assert.equal(
        await waitForAgentExit(await readPid(beta.pidFile)),
        true,
        "beta agent must exit",
      );
    } finally {
      if (harness.child.exitCode === null) {
        harness.child.kill("SIGKILL");
      }
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

async function readPid(pidFile: string): Promise<number> {
  const content = await fs.readFile(pidFile, "utf8");
  const pid = Number.parseInt(content.trim(), 10);
  assert.equal(Number.isInteger(pid), true, `invalid pid file ${pidFile}: ${content}`);
  return pid;
}
