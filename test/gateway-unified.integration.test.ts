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
const AGENT_GAMMA = "gamma";

/**
 * Configurable ACP backend. Advertises a per-instance model list and either a
 * `category:"mode"` config option (`--mode-path config`) or the SDK `modes`
 * field (`--mode-path sdk`). Prompts echo the session's current model/mode so
 * tests can assert what the gateway actually forwarded.
 */
const UNIFIED_AGENT_SCRIPT = `
import readline from 'node:readline';

const args = process.argv.slice(2);
function argValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
const label = argValue('--label') ?? 'agent';
const models = (argValue('--models') ?? 'default-model').split(',').filter(Boolean);
const modes = (argValue('--modes') ?? 'read-only,auto,full-access,plan,default').split(',').filter(Boolean);
const modePath = argValue('--mode-path') ?? 'config';
const failNewSession = args.includes('--fail-new-session');

const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const sessions = new Map();
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

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  const method = message.method;
  const params = message.params ?? {};

  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    return;
  }
  if (method === 'session/new') {
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
  ];
}

function spawnGateway(homeDir: string, cwd: string, configPath: string): GatewayHarness {
  const child = spawn(
    process.execPath,
    [CLI_PATH, "gateway", "--config", configPath, "--cwd", cwd, "--approve-all"],
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

type GatewayAgentConfig = {
  name: string;
  argv: string[];
  default?: boolean;
  enabledModels?: string[];
};

function defaultGatewayAgents(scriptPath: string): GatewayAgentConfig[] {
  return [
    {
      name: AGENT_ALPHA,
      argv: agentArgv(
        scriptPath,
        AGENT_ALPHA,
        "alpha-1,alpha-2",
        "read-only,auto,full-access,plan,default",
        "config",
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
      ),
    },
    {
      name: AGENT_GAMMA,
      argv: agentArgv(scriptPath, AGENT_GAMMA, "gamma-1,gamma-2,gamma-3", "auto,plan", "sdk"),
    },
  ];
}

async function withGateway(
  run: (harness: GatewayHarness, cwd: string) => Promise<void>,
  buildAgents: (scriptPath: string) => GatewayAgentConfig[] = defaultGatewayAgents,
): Promise<void> {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-gateway-unified-cwd-"));
    const scriptPath = await writeAgentScript(homeDir);
    const config = { agents: buildAgents(scriptPath) };
    const configPath = path.join(homeDir, "gateway.agents.json");
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    const harness = spawnGateway(homeDir, cwd, configPath);
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
    const session = await harness.connection.newSession({ cwd, mcpServers: [] });

    const modelValues = selectValues(findOption(session.configOptions, "model")).toSorted();
    assert.deepEqual(modelValues, [
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
      const session = await harness.connection.newSession({ cwd, mcpServers: [] });

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
      const session = await harness.connection.newSession({ cwd, mcpServers: [] });
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
