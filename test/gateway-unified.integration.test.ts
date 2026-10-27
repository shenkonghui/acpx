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
  type SessionConfigOption,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from "@agentclientprotocol/sdk";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));

const AGENT_ALPHA = "alpha";
const AGENT_BETA = "beta";
const AGENT_GAMMA = "gamma";

/**
 * Configurable ACP backend. Advertises a per-instance model list and either a
 * `category:"mode"` config option (`--mode-path config`) or the SDK `modes`
 * field (`--mode-path sdk`). Prompts echo the session's current model/mode so
 * tests can assert what the gateway actually forwarded.
 */
const UNIFIED_AGENT_SCRIPT = `
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
function argValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
const label = argValue('--label') ?? 'agent';
const models = (argValue('--models') ?? 'default-model').split(',').filter(Boolean);
const modes = (argValue('--modes') ?? 'read-only,auto,full-access,plan,default').split(',').filter(Boolean);
const modePath = argValue('--mode-path') ?? 'config';
const promptLog = argValue('--prompt-log');
const failNewSession = args.includes('--fail-new-session');
const failPrompt = argValue('--fail-prompt');
const failPromptText = argValue('--fail-prompt-text');
const initDelay = Number(argValue('--init-delay') ?? 0);
const newSessionDelay = Number(argValue('--new-session-delay') ?? 0);
const sleep = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

const QUOTA_ERROR = { code: -32000, message: 'Quota exceeded for this account' };

const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const sessions = new Map();
const pendingPrompts = new Map();
let counter = 0;

function buildConfigOptions(session) {
  const options = [];
  if (modePath === 'config') {
    options.push({
      id: 'mode', name: 'Session Mode', category: 'mode', type: 'select',
      currentValue: session.mode, options: modes.map((value) => ({ value, name: value })),
    });
  }
  options.push({
    id: 'model', name: 'Model', category: 'model', type: 'select',
    currentValue: session.model, options: models.map((value) => ({ value, name: value })),
  });
  return options;
}

function sessionResponse(sessionId) {
  const session = sessions.get(sessionId);
  const result = { sessionId, configOptions: buildConfigOptions(session) };
  if (modePath === 'sdk') {
    result.modes = { currentModeId: session.mode, availableModes: modes.map((id) => ({ id, name: id })) };
  }
  return result;
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const message = JSON.parse(line);
  const method = message.method;
  const params = message.params ?? {};

  if (method === 'initialize') {
    await sleep(initDelay);
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    return;
  }
  if (method === 'session/new') {
    await sleep(newSessionDelay);
    if (failNewSession) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Authentication required: Authentication is required.' } });
      return;
    }
    counter += 1;
    const sessionId = label + '-s' + counter;
    sessions.set(sessionId, { model: models[0], mode: modes.includes('auto') ? 'auto' : modes[0] });
    send({ jsonrpc: '2.0', id: message.id, result: sessionResponse(sessionId) });
    return;
  }
  if (method === 'session/set_config_option') {
    const session = sessions.get(params.sessionId);
    if (session) {
      if (params.configId === 'model') session.model = params.value;
      if (params.configId === 'mode') session.mode = params.value;
    }
    send({ jsonrpc: '2.0', id: message.id, result: { configOptions: buildConfigOptions(session) } });
    return;
  }
  if (method === 'session/set_mode') {
    const session = sessions.get(params.sessionId);
    if (session) session.mode = params.modeId;
    send({ jsonrpc: '2.0', id: message.id, result: {} });
    return;
  }
  if (method === 'session/prompt') {
    const session = sessions.get(params.sessionId);
    const blocks = Array.isArray(params.prompt) ? params.prompt : [];
    const text = blocks
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join(' ');
    if (promptLog) {
      appendFileSync(promptLog, JSON.stringify({ label, sessionId: params.sessionId, text }) + '\\n');
    }
    if (failPrompt && (!failPromptText || text.includes(failPromptText))) {
      if (failPrompt === 'quota-after-output') {
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: label + ':partial ' + text },
            },
          },
        });
      }
      send({ jsonrpc: '2.0', id: message.id, error: QUOTA_ERROR });
      return;
    }
    if (text.trim() === 'hang') {
      pendingPrompts.set(message.id, params.sessionId);
      return;
    }
    if (text.includes('TOOLCALL')) {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-1',
            title: 'Read gateway.ts',
            kind: 'read',
            status: 'completed',
            locations: [{ path: 'src/acp/gateway.ts' }],
          },
        },
      });
    }
    if (text.includes('PLAN')) {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'plan',
            entries: [{ content: 'wire structured handoff', status: 'in_progress', priority: 'high' }],
          },
        },
      });
    }
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: label + ':ok ' + text + ' [model=' + (session?.model) + ' mode=' + (session?.mode) + ']',
          },
        },
      },
    });
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
    return;
  }
  if (method === 'session/cancel') {
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

  /** Latest config options pushed for `sessionId`, if any. */
  latestConfigOptions(sessionId: string): SessionConfigOption[] | undefined {
    let latest: SessionConfigOption[] | undefined;
    for (const update of this.updates) {
      if (update.sessionId !== sessionId) {
        continue;
      }
      const record = update.update as {
        sessionUpdate?: string;
        configOptions?: SessionConfigOption[];
      };
      if (record.sessionUpdate === "config_option_update" && record.configOptions) {
        latest = record.configOptions;
      }
    }
    return latest;
  }

  /**
   * Waits for a pushed surface that advertises every model in `expected`.
   * Backends publish their discovery independently, so a single push can carry
   * a partial merged surface and the full one may land several pushes later.
   */
  async waitForModels(
    sessionId: string,
    expected: string[],
    timeoutMs = 10_000,
  ): Promise<SessionConfigOption[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const latest = this.latestConfigOptions(sessionId);
      if (latest) {
        const values = selectValues(findOption(latest, "model"));
        if (expected.every((model) => values.includes(model))) {
          return latest;
        }
      }
      if (Date.now() > deadline) {
        const seen = selectValues(findOption(this.latestConfigOptions(sessionId), "model"));
        throw new Error(
          `no config_option_update for ${sessionId} advertising ${expected.join(", ")} within ${timeoutMs}ms (last: ${seen.join(", ")})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
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

type SelectOptionShape = { options: unknown; currentValue?: unknown };

function selectValues(option: SelectOptionShape | undefined): string[] {
  if (!option || !Array.isArray(option.options)) {
    return [];
  }
  return option.options.flatMap((entry) => {
    const record = entry as { value?: unknown; options?: unknown };
    if (typeof record.value === "string") {
      return [record.value];
    }
    if (Array.isArray(record.options)) {
      return record.options.flatMap((nested) => {
        const value = (nested as { value?: unknown }).value;
        return typeof value === "string" ? [value] : [];
      });
    }
    return [];
  });
}

function findOption(
  configOptions: ReadonlyArray<{ id: string }> | null | undefined,
  id: string,
): SelectOptionShape | undefined {
  return configOptions?.find((option) => option.id === id) as SelectOptionShape | undefined;
}

async function writeAgentScript(homeDir: string): Promise<string> {
  const scriptPath = path.join(homeDir, "unified-agent.mjs");
  await fs.writeFile(scriptPath, UNIFIED_AGENT_SCRIPT, "utf8");
  return scriptPath;
}

function agentArgv(
  scriptPath: string,
  label: string,
  models: string,
  modes: string,
  modePath: string,
  extraArgs: string[] = [],
): string[] {
  return [
    process.execPath,
    scriptPath,
    "--label",
    label,
    "--models",
    models,
    "--modes",
    modes,
    "--mode-path",
    modePath,
    ...extraArgs,
  ];
}

function spawnGateway(
  homeDir: string,
  cwd: string,
  configPath: string,
  extraArgs: string[] = [],
): GatewayHarness {
  const child = spawn(
    process.execPath,
    [CLI_PATH, "gateway", "--config", configPath, "--cwd", cwd, "--approve-all", ...extraArgs],
    { cwd: homeDir, stdio: ["pipe", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  const input = Writable.toWeb(child.stdin);
  const output = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  const client = new GatewayTestClient();
  const connection = new ClientSideConnection(() => client, ndJsonStream(input, output));
  return {
    client,
    connection,
    child,
    get stderrText(): string {
      return stderr;
    },
  };
}

async function initializeGateway(harness: GatewayHarness): Promise<InitializeResponse> {
  return await harness.connection.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    clientInfo: { name: "acpx-gateway-unified-test", version: "0.0.0" },
  });
}

/**
 * Opens a session and returns the config options a client would end up with.
 *
 * Backends boot and probe in the background, so `session/new` may answer before
 * the merged model surface exists; the gateway then pushes it. This mirrors what
 * a real client does and keeps assertions on `configOptions` meaningful.
 */
async function openSession(
  harness: GatewayHarness,
  params: { cwd: string; mcpServers: []; _meta?: Record<string, unknown> },
  expectedModels: string[],
): Promise<{ sessionId: string; configOptions?: SessionConfigOption[] | null }> {
  const session = await harness.connection.newSession(params);
  const hasAll = (options: SessionConfigOption[] | null | undefined): boolean => {
    const values = selectValues(findOption(options, "model"));
    return expectedModels.every((model) => values.includes(model));
  };
  if (hasAll(session.configOptions)) {
    return session;
  }
  return {
    sessionId: session.sessionId,
    configOptions: await harness.client.waitForModels(session.sessionId, expectedModels),
  };
}

/** Polls `check` until it returns true; rejects after `timeoutMs`. */
async function pollUntil(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-gateway-unified-"));
  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    await run(homeDir);
  } finally {
    process.env.HOME = previousHome;
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

type PromptLogEntry = {
  label: string;
  sessionId: string;
  text: string;
};

async function readPromptLog(file: string): Promise<PromptLogEntry[]> {
  const raw = await fs.readFile(file, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as PromptLogEntry);
}

async function withPromptLog(run: (promptLog: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-gateway-handoff-log-"));
  try {
    await run(path.join(dir, "prompts.jsonl"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

type GatewayAgentConfig = {
  name: string;
  argv: string[];
  default?: boolean;
  enabledModels?: string[];
};

function defaultGatewayAgents(scriptPath: string, promptLog?: string): GatewayAgentConfig[] {
  const logArgs = promptLog ? ["--prompt-log", promptLog] : [];
  return [
    {
      name: AGENT_ALPHA,
      argv: agentArgv(
        scriptPath,
        AGENT_ALPHA,
        "alpha-1,alpha-2",
        "read-only,auto,full-access,plan,default",
        "config",
        logArgs,
      ),
      default: true,
    },
    {
      name: AGENT_BETA,
      argv: agentArgv(
        scriptPath,
        AGENT_BETA,
        "beta-1",
        "read-only,auto,full-access,plan,default",
        "config",
        logArgs,
      ),
    },
    {
      name: AGENT_GAMMA,
      argv: agentArgv(
        scriptPath,
        AGENT_GAMMA,
        "gamma-1,gamma-2,gamma-3",
        "auto,plan",
        "sdk",
        logArgs,
      ),
    },
  ];
}

async function withGateway(
  run: (harness: GatewayHarness, cwd: string) => Promise<void>,
  buildAgents: (scriptPath: string) => GatewayAgentConfig[] = defaultGatewayAgents,
  extraArgs: string[] = [],
  fallbacks?: unknown[],
): Promise<void> {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-gateway-unified-cwd-"));
    const scriptPath = await writeAgentScript(homeDir);
    const config = {
      agents: buildAgents(scriptPath),
      ...(fallbacks ? { fallbacks } : {}),
    };
    const configPath = path.join(homeDir, "gateway.agents.json");
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    const harness = spawnGateway(homeDir, cwd, configPath, extraArgs);
    try {
      await run(harness, cwd);
    } finally {
      harness.child.kill("SIGTERM");
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
}

test("gateway: session/new exposes merged prefixed models and unified mode", async () => {
  await withGateway(async (harness, cwd) => {
    await initializeGateway(harness);
    const session = await openSession(harness, { cwd, mcpServers: [] }, [
      "alpha/alpha-1",
      "alpha/alpha-2",
      "beta/beta-1",
      "gamma/gamma-1",
      "gamma/gamma-2",
      "gamma/gamma-3",
    ]);
    assert.deepEqual(selectValues(findOption(session.configOptions, "model")).toSorted(), [
      "alpha/alpha-1",
      "alpha/alpha-2",
      "beta/beta-1",
      "gamma/gamma-1",
      "gamma/gamma-2",
      "gamma/gamma-3",
    ]);

    const modeOption = findOption(session.configOptions, "mode");
    assert.deepEqual(selectValues(modeOption).toSorted(), ["ask", "bypass", "code"]);
    assert.equal(modeOption?.currentValue, "code");
  });
});

test("gateway: selecting a prefixed model binds to that backend", async () => {
  await withGateway(async (harness, cwd) => {
    await initializeGateway(harness);
    const session = await harness.connection.newSession({ cwd, mcpServers: [] });

    await harness.connection.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: "model",
      value: "beta/beta-1",
    });
    await harness.connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hello" }],
    });

    const text = harness.client.updateTexts().join(" | ");
    assert.match(text, /beta:ok hello \[model=beta-1 mode=auto\]/);
  });
});

test("gateway: unbound prompt falls back to the default agent", async () => {
  await withGateway(async (harness, cwd) => {
    await initializeGateway(harness);
    const session = await harness.connection.newSession({ cwd, mcpServers: [] });
    await harness.connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hello" }],
    });
    const text = harness.client.updateTexts().join(" | ");
    assert.match(text, /alpha:ok hello/);
  });
});

test("gateway: pre-bind mode is buffered and replayed once bound", async () => {
  await withGateway(async (harness, cwd) => {
    await initializeGateway(harness);
    const session = await harness.connection.newSession({ cwd, mcpServers: [] });

    // Set the permission before choosing a model; it must be remembered.
    const modeResponse = await harness.connection.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: "mode",
      value: "bypass",
    });
    assert.equal(findOption(modeResponse.configOptions, "mode")?.currentValue, "bypass");

    await harness.connection.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: "model",
      value: "alpha/alpha-2",
    });
    await harness.connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hi" }],
    });

    const text = harness.client.updateTexts().join(" | ");
    assert.match(text, /alpha:ok hi \[model=alpha-2 mode=full-access\]/);
  });
});

test("gateway: buffered mode is replayed when a prompt triggers the bind", async () => {
  await withGateway(async (harness, cwd) => {
    await initializeGateway(harness);
    const session = await harness.connection.newSession({ cwd, mcpServers: [] });
    await harness.connection.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: "mode",
      value: "bypass",
    });
    // No model selection: the prompt binds to the default agent (alpha) and must
    // still replay the buffered permission.
    await harness.connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hi" }],
    });
    const text = harness.client.updateTexts().join(" | ");
    assert.match(text, /alpha:ok hi \[model=alpha-1 mode=full-access\]/);
  });
});

test("gateway: cross-backend model switch is rejected", async () => {
  await withGateway(async (harness, cwd) => {
    await initializeGateway(harness);
    const session = await harness.connection.newSession({ cwd, mcpServers: [] });

    await harness.connection.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: "model",
      value: "alpha/alpha-1",
    });

    await assert.rejects(
      harness.connection.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: "model",
        value: "beta/beta-1",
      }),
      (error: unknown) => {
        const message = (error as { message?: unknown }).message;
        return typeof message === "string" && message.includes("already bound");
      },
    );
  });
});

test("gateway: --handoff migrates structured context to the new backend", async () => {
  await withPromptLog(async (promptLog) => {
    await withGateway(
      async (harness, cwd) => {
        await initializeGateway(harness);
        const session = await harness.connection.newSession({ cwd, mcpServers: [] });
        await harness.connection.setSessionConfigOption({
          sessionId: session.sessionId,
          configId: "model",
          value: "alpha/alpha-1",
        });
        await harness.connection.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "PLAN TOOLCALL 分析 gateway 的绑定逻辑" }],
        });

        const switched = await harness.connection.setSessionConfigOption({
          sessionId: session.sessionId,
          configId: "model",
          value: "beta/beta-1",
        });
        const modelOption = findOption(switched.configOptions, "model");
        assert.equal(modelOption?.currentValue, "beta/beta-1");
        // The merged surface stays visible so the session can switch again.
        assert.ok(selectValues(modelOption).includes("alpha/alpha-2"));

        await harness.connection.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "继续" }],
        });
        const text = harness.client.updateTexts().join(" | ");
        assert.match(text, /beta:ok 继续 \[model=beta-1/);
        // The handoff turn is a control prompt; its output must not leak upstream.
        assert.doesNotMatch(text, /HANDOFF_OK|Session handoff/);

        const entries = await readPromptLog(promptLog);
        const betaPrompts = entries.filter((entry) => entry.label === AGENT_BETA);
        assert.equal(betaPrompts.length, 2);
        const handoff = betaPrompts[0].text;
        assert.match(handoff, /# Session handoff/);
        assert.match(handoff, /"alpha"/);
        assert.match(handoff, /## Plan/);
        assert.match(handoff, /wire structured handoff/);
        assert.match(handoff, /## Tools used/);
        assert.match(handoff, /src\/acp\/gateway\.ts/);
        assert.match(handoff, /## Recent conversation/);
        assert.match(handoff, /分析 gateway 的绑定逻辑/);
        assert.match(handoff, /HANDOFF_OK/);
        assert.equal(betaPrompts[1].text, "继续");
      },
      (scriptPath) => defaultGatewayAgents(scriptPath, promptLog),
      ["--handoff"],
    );
  });
});

test("gateway: --handoff switches an empty session without a handoff prompt", async () => {
  await withPromptLog(async (promptLog) => {
    await withGateway(
      async (harness, cwd) => {
        await initializeGateway(harness);
        const session = await harness.connection.newSession({ cwd, mcpServers: [] });
        await harness.connection.setSessionConfigOption({
          sessionId: session.sessionId,
          configId: "model",
          value: "alpha/alpha-1",
        });
        await harness.connection.setSessionConfigOption({
          sessionId: session.sessionId,
          configId: "model",
          value: "beta/beta-1",
        });
        await harness.connection.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "fresh" }],
        });
        assert.match(harness.client.updateTexts().join(" | "), /beta:ok fresh/);
        const entries = await readPromptLog(promptLog).catch(() => [] as PromptLogEntry[]);
        assert.deepEqual(
          entries.map((entry) => [entry.label, entry.text]),
          [[AGENT_BETA, "fresh"]],
        );
      },
      (scriptPath) => defaultGatewayAgents(scriptPath, promptLog),
      ["--handoff"],
    );
  });
});

test("gateway: --handoff keeps the old binding when the target cannot start", async () => {
  await withGateway(
    async (harness, cwd) => {
      await initializeGateway(harness);
      const session = await harness.connection.newSession({ cwd, mcpServers: [] });
      await harness.connection.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: "model",
        value: "alpha/alpha-1",
      });

      await assert.rejects(
        harness.connection.setSessionConfigOption({
          sessionId: session.sessionId,
          configId: "model",
          value: "delta/delta-1",
        }),
        (error: unknown) => {
          const message = (error as { message?: unknown }).message;
          return typeof message === "string" && message.includes("session handoff");
        },
      );

      await harness.connection.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "still alpha" }],
      });
      assert.match(harness.client.updateTexts().join(" | "), /alpha:ok still alpha/);
    },
    (scriptPath) => [
      ...defaultGatewayAgents(scriptPath),
      {
        name: "delta",
        argv: [
          ...agentArgv(scriptPath, "delta", "delta-1", "auto", "config"),
          "--fail-new-session",
        ],
      },
    ],
    ["--handoff"],
  );
});

test("gateway: --handoff rejects switching while a turn is running", async () => {
  await withGateway(
    async (harness, cwd) => {
      await initializeGateway(harness);
      const session = await harness.connection.newSession({ cwd, mcpServers: [] });
      await harness.connection.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: "model",
        value: "alpha/alpha-1",
      });

      const running = harness.connection.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "hang" }],
      });
      await assert.rejects(
        harness.connection.setSessionConfigOption({
          sessionId: session.sessionId,
          configId: "model",
          value: "beta/beta-1",
        }),
        (error: unknown) => {
          const message = (error as { message?: unknown }).message;
          return typeof message === "string" && message.includes("while a turn is running");
        },
      );
      await harness.connection.cancel({ sessionId: session.sessionId });
      await running;
    },
    defaultGatewayAgents,
    ["--handoff"],
  );
});

test("gateway: SDK-modes backend maps unified ask onto plan via session/set_mode", async () => {
  await withGateway(async (harness, cwd) => {
    await initializeGateway(harness);
    const session = await harness.connection.newSession({ cwd, mcpServers: [] });

    await harness.connection.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: "model",
      value: "gamma/gamma-2",
    });
    await harness.connection.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: "mode",
      value: "ask",
    });
    await harness.connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hi" }],
    });

    const text = harness.client.updateTexts().join(" | ");
    assert.match(text, /gamma:ok hi \[model=gamma-2 mode=plan\]/);
  });
});

test("gateway: unknown model reference is rejected", async () => {
  await withGateway(async (harness, cwd) => {
    await initializeGateway(harness);
    const session = await harness.connection.newSession({ cwd, mcpServers: [] });
    await assert.rejects(
      harness.connection.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: "model",
        value: "nope/x",
      }),
      (error: unknown) => {
        const message = (error as { message?: unknown }).message;
        return typeof message === "string" && message.includes("Unknown model reference");
      },
    );
  });
});

test("gateway: enabledModels filters backend models on the merged and bound surfaces", async () => {
  await withGateway(
    async (harness, cwd) => {
      await initializeGateway(harness);
      const session = await openSession(harness, { cwd, mcpServers: [] }, [
        "alpha/alpha-2",
        "beta/beta-1",
        "gamma/gamma-1",
        "gamma/gamma-2",
        "gamma/gamma-3",
      ]);

      // Merged surface: alpha is restricted to alpha-2, beta and gamma are untouched.
      assert.deepEqual(selectValues(findOption(session.configOptions, "model")).toSorted(), [
        "alpha/alpha-2",
        "beta/beta-1",
        "gamma/gamma-1",
        "gamma/gamma-2",
        "gamma/gamma-3",
      ]);

      // Bound surface: a session bound to alpha sees only the allowed model.
      const bound = await harness.connection.newSession({
        cwd,
        mcpServers: [],
        _meta: { acpx: { agent: AGENT_ALPHA } },
      });
      assert.deepEqual(selectValues(findOption(bound.configOptions, "model")), ["alpha/alpha-2"]);

      // Selecting a filtered-out model is rejected by the advertised-model check.
      await assert.rejects(
        harness.connection.setSessionConfigOption({
          sessionId: bound.sessionId,
          configId: "model",
          value: "alpha/alpha-1",
        }),
        (error: unknown) => {
          const message = (error as { message?: unknown }).message;
          return typeof message === "string" && message.includes("did not advertise");
        },
      );
    },
    (scriptPath) => [
      {
        name: AGENT_ALPHA,
        argv: agentArgv(
          scriptPath,
          AGENT_ALPHA,
          "alpha-1,alpha-2",
          "read-only,auto,full-access,plan,default",
          "config",
        ),
        enabledModels: ["alpha-2"],
        default: true,
      },
      {
        name: AGENT_BETA,
        argv: agentArgv(
          scriptPath,
          AGENT_BETA,
          "beta-1",
          "read-only,auto,full-access,plan,default",
          "config",
        ),
      },
      {
        name: AGENT_GAMMA,
        argv: agentArgv(scriptPath, AGENT_GAMMA, "gamma-1,gamma-2,gamma-3", "auto,plan", "sdk"),
      },
    ],
  );
});

test("gateway: a backend whose probe fails is degraded, not fatal", async () => {
  await withGateway(
    async (harness, cwd) => {
      await initializeGateway(harness);
      const session = await openSession(harness, { cwd, mcpServers: [] }, ["healthy/healthy-1"]);
      // The failing backend contributes no models; the healthy one still does.
      assert.deepEqual(selectValues(findOption(session.configOptions, "model")), [
        "healthy/healthy-1",
      ]);
      // It stays reachable via _meta and surfaces the underlying error at bind.
      await assert.rejects(
        harness.connection.newSession({
          cwd,
          mcpServers: [],
          _meta: { acpx: { agent: "broken" } },
        }),
        (error: unknown) => {
          const message = (error as { message?: unknown }).message;
          return typeof message === "string" && message.includes("Authentication required");
        },
      );
    },
    (scriptPath) => [
      {
        name: "healthy",
        argv: agentArgv(scriptPath, "healthy", "healthy-1", "auto", "config"),
        default: true,
      },
      {
        name: "broken",
        argv: [
          ...agentArgv(scriptPath, "broken", "broken-1", "auto", "config"),
          "--fail-new-session",
        ],
      },
    ],
  );
});

test("gateway: session/new answers before the backends finish probing", async () => {
  await withGateway(
    async (harness, cwd) => {
      await initializeGateway(harness);

      const startedAt = Date.now();
      const session = await harness.connection.newSession({ cwd, mcpServers: [] });
      const elapsed = Date.now() - startedAt;

      // The probe takes 2s per backend; answering must not wait for it.
      assert.ok(elapsed < 1_000, `session/new took ${elapsed}ms`);
      assert.equal(findOption(session.configOptions, "model"), undefined);

      // Discovery arrives later as a pushed config_option_update.
      const pushed = await harness.client.waitForModels(session.sessionId, [
        "alpha/alpha-1",
        "alpha/alpha-2",
        "beta/beta-1",
      ]);
      assert.deepEqual(selectValues(findOption(pushed, "model")).toSorted(), [
        "alpha/alpha-1",
        "alpha/alpha-2",
        "beta/beta-1",
      ]);
      assert.deepEqual(selectValues(findOption(pushed, "mode")).toSorted(), [
        "ask",
        "bypass",
        "code",
      ]);
    },
    (scriptPath) => [
      {
        name: AGENT_ALPHA,
        argv: [
          ...agentArgv(
            scriptPath,
            AGENT_ALPHA,
            "alpha-1,alpha-2",
            "auto,plan,full-access",
            "config",
          ),
          "--new-session-delay",
          "2000",
        ],
        default: true,
      },
      {
        name: AGENT_BETA,
        argv: [
          ...agentArgv(scriptPath, AGENT_BETA, "beta-1", "auto,plan,full-access", "config"),
          "--new-session-delay",
          "2000",
        ],
      },
    ],
  );
});

test("gateway: cancel issued while the first turn binds reaches the backend", async () => {
  await withGateway(
    async (harness, cwd) => {
      await initializeGateway(harness);
      const session = await harness.connection.newSession({ cwd, mcpServers: [] });
      const prompt = harness.connection.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "hang" }],
      });

      // The default backend is still initializing, so the cancel lands before
      // the turn is written downstream; the gateway has to replay it once bound.
      await new Promise((resolve) => setTimeout(resolve, 100));
      await harness.connection.cancel({ sessionId: session.sessionId });

      const result = await prompt;
      assert.equal(result.stopReason, "cancelled");
    },
    (scriptPath) => [
      {
        name: AGENT_ALPHA,
        argv: [
          ...agentArgv(scriptPath, AGENT_ALPHA, "alpha-1", "auto", "config"),
          "--init-delay",
          "1500",
        ],
        default: true,
      },
    ],
  );
});

test("gateway: backends start and probe in parallel", async () => {
  await withGateway(
    async (harness) => {
      await initializeGateway(harness);
      await pollUntil(
        () =>
          harness.stderrText.includes("probed agent fast") &&
          harness.stderrText.includes("probed agent slow"),
        15_000,
        "both backends to finish probing",
      );

      const log = harness.stderrText;
      const startedSlow = log.indexOf("started agent: slow");
      const startedFast = log.indexOf("started agent: fast");
      const probedSlow = log.indexOf("probed agent slow");
      const probedFast = log.indexOf("probed agent fast");
      assert.ok(startedSlow >= 0 && startedFast >= 0, log);
      assert.ok(probedSlow >= 0 && probedFast >= 0, log);
      // `slow` is listed first but takes 800ms longer to boot, so a serial
      // startup/probe loop would finish it long before `fast` appears.
      assert.ok(startedFast < startedSlow, log);
      assert.ok(probedFast < probedSlow, log);
    },
    (scriptPath) => [
      {
        name: "slow",
        argv: [
          ...agentArgv(scriptPath, "slow", "slow-1", "auto", "config"),
          "--init-delay",
          "800",
          "--new-session-delay",
          "300",
        ],
      },
      {
        name: "fast",
        argv: agentArgv(scriptPath, "fast", "fast-1", "auto", "config"),
        default: true,
      },
    ],
    ["--verbose"],
  );
});

function configOptionsFromUpdate(
  notification: SessionNotification,
): SessionConfigOption[] | undefined {
  const record = notification.update as {
    sessionUpdate?: string;
    configOptions?: SessionConfigOption[];
  };
  return record.sessionUpdate === "config_option_update" ? record.configOptions : undefined;
}

function failingAgent(
  scriptPath: string,
  name: string,
  models: string,
  failMode: string,
  failText?: string,
): GatewayAgentConfig {
  return {
    name,
    argv: [
      ...agentArgv(scriptPath, name, models, "read-only,auto,full-access,plan,default", "config"),
      "--fail-prompt",
      failMode,
      ...(failText ? ["--fail-prompt-text", failText] : []),
    ],
  };
}

test("gateway: a quota failure replays the turn on the next backend in the chain", async () => {
  await withPromptLog(async (promptLog) => {
    await withGateway(
      async (harness, cwd) => {
        await initializeGateway(harness);
        const session = await harness.connection.newSession({ cwd, mcpServers: [] });
        // The first turn succeeds, so the second one has a conversation to carry.
        await harness.connection.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "first" }],
        });
        await harness.connection.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "BOOM" }],
        });

        const text = harness.client.updateTexts().join(" | ");
        assert.match(text, /beta:ok BOOM/);
        assert.doesNotMatch(text, /alpha:ok BOOM/);

        // The client learns that the session now runs on the fallback backend.
        const configUpdates = harness.client.updates
          .map((update) => configOptionsFromUpdate(update))
          .filter((options): options is SessionConfigOption[] => options !== undefined);
        const modelOption = findOption(configUpdates.at(-1), "model");
        assert.equal(modelOption?.currentValue, "beta/beta-1");

        // The conversation travels to the fallback backend before the replay.
        const entries = await readPromptLog(promptLog);
        const betaPrompts = entries.filter((entry) => entry.label === AGENT_BETA);
        assert.equal(betaPrompts.length, 2);
        assert.match(betaPrompts[0].text, /# Session handoff/);
        assert.match(betaPrompts[0].text, /first/);
        assert.equal(betaPrompts[1].text, "BOOM");
      },
      (scriptPath) => [
        {
          ...failingAgent(scriptPath, AGENT_ALPHA, "alpha-1", "quota", "BOOM"),
          default: true,
        },
        {
          name: AGENT_BETA,
          argv: agentArgv(
            scriptPath,
            AGENT_BETA,
            "beta-1",
            "read-only,auto,full-access,plan,default",
            "config",
            ["--prompt-log", promptLog],
          ),
        },
      ],
      [],
      [
        { agent: AGENT_ALPHA, priority: 100 },
        { agent: AGENT_BETA, priority: 50 },
      ],
    );
  });
});

test("gateway: a failure after output is not replayed on another backend", async () => {
  await withPromptLog(async (promptLog) => {
    await withGateway(
      async (harness, cwd) => {
        await initializeGateway(harness);
        const session = await harness.connection.newSession({ cwd, mcpServers: [] });

        await assert.rejects(
          harness.connection.prompt({
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: "hello" }],
          }),
          (error: unknown) => {
            const message = (error as { message?: unknown }).message;
            return typeof message === "string" && message.includes("Quota exceeded");
          },
        );

        // The partial output reached the client, but the turn was not repeated.
        assert.match(harness.client.updateTexts().join(" | "), /alpha:partial hello/);
        const entries = await readPromptLog(promptLog).catch(() => [] as PromptLogEntry[]);
        assert.deepEqual(
          entries.filter((entry) => entry.label === AGENT_BETA).map((entry) => entry.text),
          [],
        );
      },
      (scriptPath) => [
        {
          ...failingAgent(scriptPath, AGENT_ALPHA, "alpha-1", "quota-after-output"),
          default: true,
        },
        {
          name: AGENT_BETA,
          argv: agentArgv(
            scriptPath,
            AGENT_BETA,
            "beta-1",
            "read-only,auto,full-access,plan,default",
            "config",
            ["--prompt-log", promptLog],
          ),
        },
      ],
      [],
      [
        { agent: AGENT_ALPHA, priority: 100 },
        { agent: AGENT_BETA, priority: 50 },
      ],
    );
  });
});

test("gateway: the original error surfaces when every backend in the chain fails", async () => {
  await withGateway(
    async (harness, cwd) => {
      await initializeGateway(harness);
      const session = await harness.connection.newSession({ cwd, mcpServers: [] });

      await assert.rejects(
        harness.connection.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "hello" }],
        }),
        (error: unknown) => {
          const message = (error as { message?: unknown }).message;
          return typeof message === "string" && message.includes("Quota exceeded");
        },
      );
    },
    (scriptPath) => [
      {
        ...failingAgent(scriptPath, AGENT_ALPHA, "alpha-1", "quota"),
        default: true,
      },
      failingAgent(scriptPath, AGENT_BETA, "beta-1", "quota"),
    ],
    [],
    [
      { agent: AGENT_ALPHA, priority: 100 },
      { agent: AGENT_BETA, priority: 50 },
    ],
  );
});

test("gateway: without a fallback chain a backend failure reaches the client unchanged", async () => {
  await withGateway(
    async (harness, cwd) => {
      await initializeGateway(harness);
      const session = await harness.connection.newSession({ cwd, mcpServers: [] });

      await assert.rejects(
        harness.connection.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "hello" }],
        }),
        (error: unknown) => {
          const message = (error as { message?: unknown }).message;
          return typeof message === "string" && message.includes("Quota exceeded");
        },
      );
      assert.doesNotMatch(harness.client.updateTexts().join(" | "), /beta:ok/);
    },
    (scriptPath) => [
      {
        ...failingAgent(scriptPath, AGENT_ALPHA, "alpha-1", "quota"),
        default: true,
      },
      {
        name: AGENT_BETA,
        argv: agentArgv(scriptPath, AGENT_BETA, "beta-1", "auto", "config"),
      },
    ],
  );
});

test("gateway: a chain entry that is not served is rejected at startup", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-gateway-unified-cwd-"));
    const scriptPath = await writeAgentScript(homeDir);
    const configPath = path.join(homeDir, "gateway.agents.json");
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          agents: [
            {
              name: AGENT_ALPHA,
              argv: agentArgv(scriptPath, AGENT_ALPHA, "alpha-1", "auto", "config"),
              default: true,
            },
          ],
          fallbacks: [
            { agent: AGENT_ALPHA, priority: 100 },
            { agent: AGENT_BETA, priority: 50 },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const harness = spawnGateway(homeDir, cwd, configPath);
    const exitCode = await new Promise<number | null>((resolve) => {
      harness.child.once("exit", (code) => resolve(code));
    });
    assert.notEqual(exitCode, 0);
    assert.match(harness.stderrText, /not served by this gateway/);
    await fs.rm(cwd, { recursive: true, force: true });
  });
});
