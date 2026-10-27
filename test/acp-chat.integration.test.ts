import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket, type RawData } from "ws";
import { CHAT_HELP_TEXT, parseChatCliArgs } from "../examples/acp-chat/server.js";
import {
  collectAgentSources,
  LiveAgentCatalog,
  summarizeAgentSources,
  type AgentCatalog,
} from "../examples/acp-chat/server/agent-catalog.js";
import type {
  ChatClientMessage,
  ChatServerMessage,
} from "../examples/acp-chat/server/chat-protocol.js";
import {
  createChatServer,
  fetchChatServerHealth,
  requestChatServerShutdown,
} from "../examples/acp-chat/server/chat-server.js";
import type { DiagnosticsRun } from "../examples/acp-chat/server/diagnostics.js";
import { MutableAgentRegistry } from "../examples/acp-chat/server/live-registry.js";
import {
  createInitialChatState,
  createInitialSessionsState,
  reduceChatState,
  reduceSessionsState,
} from "../examples/acp-chat/src/lib/chat-reducer.js";
import { createAgentRegistry } from "../src/agent-registry.js";
import type { AcpRegistry } from "../src/registry/types.js";

const mockAgentPath = fileURLToPath(new URL("./mock-agent.js", import.meta.url));

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-chat-"));
  try {
    return await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function withTempHome<T>(run: (homeDir: string) => Promise<T>): Promise<T> {
  const previousHome = process.env.HOME;
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-chat-home-"));
  process.env.HOME = homeDir;
  try {
    return await run(homeDir);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

function rawDataToText(data: RawData): string {
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

/** Minimal buffering WebSocket client for the `/api/chat` protocol. */
class ChatClient {
  private readonly socket: WebSocket;
  private readonly buffer: ChatServerMessage[] = [];
  private readonly waiters: Array<() => void> = [];
  private closed = false;

  constructor(port: number) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/api/chat`);
    this.socket.on("message", (data) => {
      this.buffer.push(JSON.parse(rawDataToText(data)) as ChatServerMessage);
      for (const notify of this.waiters.splice(0)) {
        notify();
      }
    });
    this.socket.on("close", () => {
      this.closed = true;
      for (const notify of this.waiters.splice(0)) {
        notify();
      }
    });
  }

  async open(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.socket.once("open", () => resolve());
      this.socket.once("error", reject);
    });
  }

  send(message: ChatClientMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  async waitFor<T extends ChatServerMessage["type"]>(
    type: T,
    predicate?: (message: Extract<ChatServerMessage, { type: T }>) => boolean,
    timeoutMs = 20_000,
  ): Promise<Extract<ChatServerMessage, { type: T }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.buffer.findIndex((message) => {
        if (message.type !== type) {
          return false;
        }
        return predicate ? predicate(message as Extract<ChatServerMessage, { type: T }>) : true;
      });
      if (index >= 0) {
        const [matched] = this.buffer.splice(index, 1);
        return matched as Extract<ChatServerMessage, { type: T }>;
      }
      if (this.closed) {
        throw new Error(
          `Socket closed before receiving ${type}; buffered: ${JSON.stringify(this.buffer)}`,
        );
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for ${type}; buffered: ${JSON.stringify(this.buffer)}`);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 100);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  close(): void {
    this.socket.close();
  }
}

function buildMockCatalog(): AgentCatalog {
  return {
    agents: [
      {
        id: "mock",
        name: "mock",
        source: "config",
        availability: "installed",
        launch: { argv: [process.execPath, mockAgentPath] },
        isDefault: true,
      },
    ],
    overrides: { mock: [process.execPath, mockAgentPath] },
    defaultAgent: "mock",
  };
}

/** Catalog whose mock agent runs with extra flags (for example model advertisement). */
function buildMockCatalogWith(extraArgs: string[]): AgentCatalog {
  const argv = [process.execPath, mockAgentPath, ...extraArgs];
  return {
    agents: [
      {
        id: "mock",
        name: "mock",
        source: "config",
        availability: "installed",
        launch: { argv },
        isDefault: true,
      },
    ],
    overrides: { mock: argv },
    defaultAgent: "mock",
  };
}

test("parseChatCliArgs defaults and flag parsing", () => {
  const defaults = parseChatCliArgs([]);
  assert.equal(defaults.command, "start");
  assert.equal(defaults.host, "127.0.0.1");
  assert.equal(defaults.port, 4174);
  assert.equal(defaults.cwd, process.cwd());
  assert.equal(defaults.permissionMode, "approve-all");
  assert.equal(defaults.stateDir, path.join(os.homedir(), ".acpx", "acp-chat"));
  assert.equal(defaults.open, false);
  assert.equal(defaults.verbose, false);
  assert.equal(defaults.allowInstall, true);
  assert.equal(defaults.allowCommand, true);
  assert.equal(defaults.allowSettings, true);

  assert.equal(parseChatCliArgs(["status"]).command, "status");
  assert.equal(parseChatCliArgs(["stop", "--port=5000"]).port, 5000);
  assert.equal(parseChatCliArgs(["--port", "0"]).port, 0);
  assert.equal(parseChatCliArgs(["--permission-mode", "deny-all"]).permissionMode, "deny-all");
  assert.equal(parseChatCliArgs(["--verbose", "--open"]).verbose, true);
  assert.equal(parseChatCliArgs(["--verbose", "--open"]).open, true);
  assert.equal(parseChatCliArgs(["--no-install"]).allowInstall, false);
  assert.equal(parseChatCliArgs(["--no-command"]).allowCommand, false);
  assert.equal(parseChatCliArgs(["--no-settings"]).allowSettings, false);
  assert.equal(
    parseChatCliArgs(["--agents-config", "./agents.json"]).agentsConfig,
    path.resolve("./agents.json"),
  );

  assert.throws(() => parseChatCliArgs(["--port", "-1"]), /Invalid acpx chat port/u);
  assert.throws(
    () => parseChatCliArgs(["--permission-mode", "whatever"]),
    /Invalid permission mode/u,
  );
  assert.throws(() => parseChatCliArgs(["--nope"]), /Unknown acpx chat argument/u);
  assert.match(CHAT_HELP_TEXT, /Usage: pnpm chat/u);
  assert.match(CHAT_HELP_TEXT, /--no-settings/u);
});

test("collectAgentSources prefers config over gateway config over built-ins", () => {
  const collected = collectAgentSources({
    configAgents: {
      Codex: { command: "my-codex" },
      custom: { command: "node", argv: ["node", "server.js"] },
    },
    configDefaultAgent: "codex",
    gateway: {
      agents: [
        { name: "codex", agentCommand: "gateway-codex" },
        {
          name: "qoder",
          agentCommand: "qodercli",
          agentArgv: ["qodercli", "--acp"],
        },
      ],
      defaultAgent: "qoder",
    },
    builtInIds: ["codex", "claude", "qoder"],
  });

  assert.deepEqual(
    collected.sources.map((source) => source.id),
    ["Codex", "custom", "qoder", "claude"],
  );
  assert.deepEqual(collected.overrides, {
    codex: "my-codex",
    custom: ["node", "server.js"],
    qoder: ["qodercli", "--acp"],
  });
  assert.equal(collected.defaultAgent, "qoder");
  assert.deepEqual(
    collected.sources.map((source) => source.source),
    ["config", "config", "gateway-config", "built-in"],
  );
});

test("built-ins inspect their real launch argv instead of an id override", () => {
  const collected = collectAgentSources({
    configAgents: {},
    configDefaultAgent: "codex",
    builtInIds: ["qoder", "cursor"],
  });
  assert.deepEqual(collected.overrides, {});

  const registry = createAgentRegistry({
    overrides: collected.overrides,
    resolveExecutable: (command) =>
      command === "qodercli" ? "/usr/local/bin/qodercli" : undefined,
  });
  const agents = summarizeAgentSources(collected.sources, collected.defaultAgent, (id) =>
    registry.inspect(id),
  );

  assert.deepEqual(
    agents.map((agent) => [agent.id, agent.availability, agent.launch?.argv]),
    [
      ["cursor", "missing", undefined],
      ["qoder", "installed", ["/usr/local/bin/qodercli", "--acp"]],
    ],
  );
  assert.deepEqual(agents[0]?.requirements, [{ kind: "command", name: "cursor-agent" }]);
});

test("config entries win over a same-named built-in", () => {
  const collected = collectAgentSources({
    configAgents: {
      qoder: { command: "my-qoder", argv: ["my-qoder", "--acp"] },
    },
    configDefaultAgent: "qoder",
    builtInIds: ["qoder"],
  });
  assert.deepEqual(collected.overrides, { qoder: ["my-qoder", "--acp"] });
  assert.equal(collected.sources.length, 1);
  assert.equal(collected.sources[0]?.source, "config");
});

test("MutableAgentRegistry separates config and ad-hoc overrides", () => {
  const registry = new MutableAgentRegistry();
  registry.setConfigOverrides({ alpha: ["/bin/echo", "alpha"] });
  assert.equal(registry.has("alpha"), true);
  assert.deepEqual(registry.resolve("alpha"), ["/bin/echo", "alpha"]);

  registry.registerAdHoc("adhoc-1", [process.execPath, "x"]);
  assert.equal(registry.has("adhoc-1"), true);
  assert.deepEqual(registry.resolve("adhoc-1"), [process.execPath, "x"]);
  assert.deepEqual(registry.listAdHoc(), [{ name: "adhoc-1", argv: [process.execPath, "x"] }]);

  // A catalog refresh replaces config overrides without dropping ad-hoc entries.
  registry.setConfigOverrides({ beta: "beta-cmd" });
  assert.equal(registry.has("alpha"), false);
  assert.equal(registry.has("adhoc-1"), true);

  registry.removeAdHoc("adhoc-1");
  assert.equal(registry.has("adhoc-1"), false);
  assert.deepEqual(registry.listAdHoc(), []);
});

test("LiveAgentCatalog picks up a config install and ad-hoc entries without a restart", async () => {
  await withTempHome(async (homeDir) => {
    const workspace = path.join(homeDir, "workspace");
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.mkdir(workspace, { recursive: true });

    const registry = new MutableAgentRegistry();
    const catalog = new LiveAgentCatalog(registry, { cwd: workspace });

    const before = await catalog.build();
    assert.equal(
      before.agents.some((agent) => agent.id === "installed-one"),
      false,
    );

    // An install writes a config entry; no server restart should be required.
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify({ agents: { "installed-one": { argv: [process.execPath, mockAgentPath] } } })}\n`,
      "utf8",
    );

    const after = await catalog.build();
    const entry = after.agents.find((agent) => agent.id === "installed-one");
    assert.equal(entry?.source, "config");
    assert.equal(entry?.availability, "installed");
    assert.deepEqual(entry?.launch?.argv, [process.execPath, mockAgentPath]);
    assert.deepEqual(after.overrides["installed-one"], [process.execPath, mockAgentPath]);
    assert.equal(registry.has("installed-one"), true);

    registry.registerAdHoc("adhoc-test", [process.execPath, mockAgentPath]);
    const withAdHoc = await catalog.build();
    const adHoc = withAdHoc.agents.find((agent) => agent.id === "adhoc-test");
    assert.equal(adHoc?.source, "ad-hoc");
    assert.equal(adHoc?.availability, "installed");
    assert.deepEqual(adHoc?.launch?.argv, [process.execPath, mockAgentPath]);
  });
});

test("summarizeAgentSources maps availability, default, and ordering", () => {
  const collected = collectAgentSources({
    configAgents: { zeta: { command: "zeta" } },
    configDefaultAgent: "alpha",
    builtInIds: ["alpha", "beta", "gamma"],
  });
  const agents = summarizeAgentSources(collected.sources, collected.defaultAgent, (id) => {
    if (id === "beta") {
      return {
        id,
        name: "Beta",
        launch: {
          kind: "missing",
          requirements: [{ kind: "command", name: "beta" }],
        },
      };
    }
    if (id === "gamma") {
      return undefined;
    }
    return {
      id,
      name: id.toUpperCase(),
      launch: { kind: "installed", argv: [id, "--acp"] },
    };
  });

  assert.deepEqual(
    agents.map((agent) => [agent.id, agent.source, agent.availability, agent.isDefault]),
    [
      ["zeta", "config", "installed", false],
      ["alpha", "built-in", "installed", true],
      ["beta", "built-in", "missing", false],
      ["gamma", "built-in", "unknown", false],
    ],
  );
  assert.deepEqual(agents[1]?.launch, { argv: ["alpha", "--acp"] });
  assert.deepEqual(agents[2]?.requirements, [{ kind: "command", name: "beta" }]);
  assert.equal(agents[0]?.name, "ZETA");
});

test("reduceChatState streams, merges tool calls, and finalizes turns", () => {
  let state = createInitialChatState("chat-1");
  state = reduceChatState(state, { type: "ready", protocol: "acpx.chat.v1" });
  assert.equal(state.connected, true);

  state = reduceChatState(state, {
    type: "user_message",
    requestId: "r1",
    text: "hi",
  });
  state = reduceChatState(state, {
    type: "turn_started",
    chatId: "chat-1",
    requestId: "r1",
  });
  state = reduceChatState(state, {
    type: "text_delta",
    chatId: "chat-1",
    requestId: "r1",
    text: "he",
    stream: "output",
  });
  state = reduceChatState(state, {
    type: "text_delta",
    chatId: "chat-1",
    requestId: "r1",
    text: "llo",
    stream: "output",
  });
  assert.equal(state.transcript.length, 2);
  assert.deepEqual(state.transcript[1], {
    kind: "message",
    id: "r1:assistant:1",
    requestId: "r1",
    role: "assistant",
    text: "hello",
    streaming: true,
  });

  state = reduceChatState(state, {
    type: "tool_call",
    chatId: "chat-1",
    requestId: "r1",
    text: "reading",
    toolCallId: "t1",
    title: "Read",
    status: "in_progress",
  });
  state = reduceChatState(state, {
    type: "tool_call",
    chatId: "chat-1",
    requestId: "r1",
    text: "reading",
    toolCallId: "t1",
    status: "completed",
    rawOutput: { content: "x" },
  });
  assert.equal(state.transcript.length, 3);
  const tool = state.transcript[2];
  assert.equal(tool?.kind, "tool");
  assert.equal(tool?.kind === "tool" ? tool.status : undefined, "completed");
  assert.deepEqual(tool?.kind === "tool" ? tool.rawOutput : undefined, {
    content: "x",
  });

  state = reduceChatState(state, {
    type: "turn_done",
    chatId: "chat-1",
    requestId: "r1",
    status: "completed",
    stopReason: "end_turn",
  });
  assert.equal(state.activeRequestId, undefined);
  assert.equal(
    state.transcript[1]?.kind === "message" ? state.transcript[1].streaming : true,
    false,
  );
  assert.deepEqual(state.lastTurn, {
    requestId: "r1",
    status: "completed",
    stopReason: "end_turn",
  });

  state = reduceChatState(state, {
    type: "turn_done",
    chatId: "chat-1",
    requestId: "r2",
    status: "failed",
    error: { message: "boom" },
  });
  assert.deepEqual(state.errors, ["boom"]);

  state = reduceChatState(state, { type: "clear_errors" });
  assert.deepEqual(state.errors, []);

  state = reduceChatState(state, {
    type: "opening",
    agent: "codex",
    cwd: "/tmp",
  });
  assert.deepEqual(state.transcript, []);
  assert.equal(state.agent, "codex");
  assert.equal(state.cwd, "/tmp");
  assert.equal(state.opening, true);
});

test("createChatServer exposes health and the agent catalog", async () => {
  await withTempDir(async (dir) => {
    const server = await createChatServer({
      host: "127.0.0.1",
      port: 0,
      serveUi: false,
      cwd: dir,
      stateDir: path.join(dir, "state"),
      agentCatalog: buildMockCatalog(),
    });
    try {
      const health = await fetchChatServerHealth(server.baseUrl);
      assert.equal(health?.service, "acpx-acp-chat");
      assert.equal(health?.cwd, dir);
      assert.equal(health?.permissionMode, "approve-all");

      const response = await fetch(`${server.baseUrl}/api/agents`);
      const payload = (await response.json()) as {
        agents: Array<{ id: string; availability: string }>;
      };
      assert.deepEqual(
        payload.agents.map((agent) => agent.id),
        ["mock"],
      );
    } finally {
      await server.close();
    }
  });
});

test("chat WebSocket streams a turn, cancels a turn, and rejects unknown agents", async () => {
  await withTempDir(async (dir) => {
    const server = await createChatServer({
      host: "127.0.0.1",
      port: 0,
      serveUi: false,
      cwd: dir,
      stateDir: path.join(dir, "state"),
      agentCatalog: buildMockCatalog(),
    });
    const client = new ChatClient(server.port);
    try {
      await client.open();
      await client.waitFor("ready");
      client.send({ type: "hello", protocol: "acpx.chat.v1" });
      client.send({ type: "ping" });
      await client.waitFor("pong");

      client.send({ type: "open_session", chatId: "c1", agent: "mock" });
      const opened = await client.waitFor("session_opened");
      assert.equal(opened.agent, "mock");
      assert.equal(opened.cwd, dir);
      assert.match(opened.sessionKey, /^agent:mock:web:c1:(approve-all|approve-reads|deny-all)$/u);

      client.send({
        type: "send",
        chatId: "c1",
        text: "echo hi",
        requestId: "r1",
      });
      await client.waitFor("turn_started", (message) => message.requestId === "r1");
      const delta = await client.waitFor("text_delta", (message) => message.text.includes("hi"));
      assert.equal(delta.stream, "output");
      const done = await client.waitFor("turn_done", (message) => message.requestId === "r1");
      assert.equal(done.status, "completed");
      assert.equal(done.stopReason, "end_turn");

      client.send({
        type: "send",
        chatId: "c1",
        text: "sleep 5000",
        requestId: "r2",
      });
      await client.waitFor("turn_started", (message) => message.requestId === "r2");
      client.send({ type: "cancel", chatId: "c1" });
      const cancelled = await client.waitFor("turn_done", (message) => message.requestId === "r2");
      assert.equal(cancelled.status, "cancelled");

      client.send({ type: "open_session", chatId: "c2", agent: "nope" });
      const failure = await client.waitFor("error", (message) => message.chatId === "c2");
      assert.equal(failure.code, "agent_not_found");

      client.send({ type: "nonsense" } as unknown as ChatClientMessage);
      const protocolError = await client.waitFor(
        "error",
        (message) => message.code === "protocol_error",
      );
      assert.match(protocolError.message, /Invalid acpx chat message payload/u);
    } finally {
      client.close();
      await server.close();
    }
  });
});

test("chat WebSocket runs an ad-hoc command and rejects unknown commands", async () => {
  await withTempDir(async (dir) => {
    const server = await createChatServer({
      host: "127.0.0.1",
      port: 0,
      serveUi: false,
      cwd: dir,
      stateDir: path.join(dir, "state"),
      agentCatalog: buildMockCatalog(),
    });
    const client = new ChatClient(server.port);
    try {
      await client.open();
      await client.waitFor("ready");
      client.send({ type: "hello", protocol: "acpx.chat.v1" });

      client.send({
        type: "open_session",
        chatId: "cmd1",
        command: `${process.execPath} ${mockAgentPath}`,
      });
      const opened = await client.waitFor("session_opened");
      assert.match(opened.agent, /^adhoc-[0-9a-f]{8}$/u);
      assert.match(
        opened.sessionKey,
        /^agent:adhoc-[0-9a-f]{8}:web:cmd1:(approve-all|approve-reads|deny-all)$/u,
      );

      client.send({
        type: "send",
        chatId: "cmd1",
        text: "echo hi",
        requestId: "r1",
      });
      await client.waitFor("turn_started", (message) => message.requestId === "r1");
      const delta = await client.waitFor("text_delta", (message) => message.text.includes("hi"));
      assert.equal(delta.stream, "output");
      const done = await client.waitFor("turn_done", (message) => message.requestId === "r1");
      assert.equal(done.status, "completed");

      client.send({
        type: "open_session",
        chatId: "cmd2",
        command: "definitely-missing-xyz-123",
      });
      const failure = await client.waitFor("error", (message) => message.chatId === "cmd2");
      assert.equal(failure.code, "command_not_found");
    } finally {
      client.close();
      await server.close();
    }
  });
});

test("ad-hoc commands are rejected when disabled", async () => {
  await withTempDir(async (dir) => {
    const server = await createChatServer({
      host: "127.0.0.1",
      port: 0,
      serveUi: false,
      cwd: dir,
      stateDir: path.join(dir, "state"),
      agentCatalog: buildMockCatalog(),
      allowCommand: false,
    });
    const client = new ChatClient(server.port);
    try {
      await client.open();
      await client.waitFor("ready");
      client.send({
        type: "open_session",
        chatId: "cmd1",
        command: process.execPath,
      });
      const failure = await client.waitFor("error", (message) => message.chatId === "cmd1");
      assert.equal(failure.code, "command_disabled");
    } finally {
      client.close();
      await server.close();
    }
  });
});

const FAKE_REGISTRY: AcpRegistry = {
  version: "1.0.0",
  agents: [
    {
      id: "hello-agent",
      name: "Hello Agent",
      version: "1.2.3",
      description: "Says hello",
      distribution: { npx: { package: "@acp.test/hello" } },
    },
    {
      id: "binary-only",
      name: "Binary Only",
      version: "0.1.0",
      distribution: {},
    },
  ],
};

function fakeInstallResult(agentId: string) {
  return {
    agentId,
    registeredName: agentId,
    version: "1.2.3",
    method: "npx" as const,
    argv: ["npx", "-y", "@acp.test/hello"],
    reused: false,
    replacedConfigEntry: false,
    warnings: [],
  };
}

test("registry routes list agents and install through the injected installer", async () => {
  await withTempDir(async (dir) => {
    const calls: Array<{ id: string; options: Record<string, unknown> }> = [];
    const server = await createChatServer({
      host: "127.0.0.1",
      port: 0,
      serveUi: false,
      cwd: dir,
      stateDir: path.join(dir, "state"),
      agentCatalog: buildMockCatalog(),
      loadRegistry: async () => FAKE_REGISTRY,
      installAgent: async (agent, options) => {
        calls.push({ id: agent.id, options });
        return fakeInstallResult(agent.id);
      },
    });
    try {
      const listResponse = await fetch(`${server.baseUrl}/api/registry`);
      assert.equal(listResponse.status, 200);
      const list = (await listResponse.json()) as {
        agents: Array<{ id: string; methods: string[]; installable: boolean }>;
      };
      assert.deepEqual(
        list.agents.map((agent) => agent.id),
        ["hello-agent", "binary-only"],
      );
      assert.deepEqual(list.agents[0]?.methods, ["npx"]);
      assert.equal(list.agents[1]?.installable, false);

      const installResponse = await fetch(`${server.baseUrl}/api/registry/install`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "hello-agent",
          method: "npx",
          asName: "hello",
        }),
      });
      assert.equal(installResponse.status, 200);
      const installed = (await installResponse.json()) as {
        ok: boolean;
        result: { registeredName: string };
      };
      assert.equal(installed.ok, true);
      assert.equal(installed.result.registeredName, "hello-agent");
      assert.deepEqual(calls, [
        {
          id: "hello-agent",
          options: { asName: "hello", method: "npx", force: false },
        },
      ]);

      const missing = await fetch(`${server.baseUrl}/api/registry/install`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "nope" }),
      });
      assert.equal(missing.status, 404);

      const invalid = await fetch(`${server.baseUrl}/api/registry/install`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "hello-agent", method: "pip" }),
      });
      assert.equal(invalid.status, 400);
    } finally {
      await server.close();
    }
  });
});

test("registry install is disabled by --no-install", async () => {
  await withTempDir(async (dir) => {
    const server = await createChatServer({
      host: "127.0.0.1",
      port: 0,
      serveUi: false,
      cwd: dir,
      stateDir: path.join(dir, "state"),
      agentCatalog: buildMockCatalog(),
      allowInstall: false,
      loadRegistry: async () => FAKE_REGISTRY,
    });
    try {
      const healthResponse = await fetch(`${server.baseUrl}/api/health`);
      const health = (await healthResponse.json()) as {
        capabilities?: {
          install: boolean;
          command: boolean;
          settings: boolean;
        };
      };
      assert.deepEqual(health.capabilities, {
        install: false,
        command: true,
        settings: true,
      });

      const response = await fetch(`${server.baseUrl}/api/registry/install`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "hello-agent" }),
      });
      assert.equal(response.status, 403);
    } finally {
      await server.close();
    }
  });
});

test("control shutdown stops the chat server", async () => {
  await withTempDir(async (dir) => {
    const server = await createChatServer({
      host: "127.0.0.1",
      port: 0,
      serveUi: false,
      cwd: dir,
      stateDir: path.join(dir, "state"),
      agentCatalog: buildMockCatalog(),
    });
    assert.equal(await requestChatServerShutdown(server.baseUrl), true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await fetchChatServerHealth(server.baseUrl), null);
  });
});

test("collectAgentSources hides disabled agents and drops their override and env", () => {
  const collected = collectAgentSources({
    configAgents: {
      codex: { command: "my-codex", env: { TOKEN: "secret" } },
      qoder: {
        command: "qodercli",
        argv: ["qodercli", "--acp"],
        env: { Q: "1" },
      },
    },
    configDefaultAgent: "codex",
    disabledAgents: ["codex"],
    builtInIds: ["codex", "claude"],
  });

  assert.deepEqual(
    collected.sources.map((source) => source.id),
    ["qoder", "claude"],
  );
  assert.deepEqual(collected.overrides, { qoder: ["qodercli", "--acp"] });
  assert.deepEqual(collected.envs, { qoder: { Q: "1" } });
});

test("settings API toggles, edits, and removes agents while preserving unknown keys", async () => {
  await withTempHome(async (homeDir) => {
    const workspace = path.join(homeDir, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const configPath = path.join(homeDir, ".acpx", "config.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify({
        keepMe: { nested: true },
        agents: { codex: { argv: ["real-codex", "--acp"] } },
      })}\n`,
    );

    const server = await createChatServer({
      host: "127.0.0.1",
      port: 0,
      serveUi: false,
      cwd: workspace,
      stateDir: path.join(workspace, "state"),
    });
    const json = async (
      url: string,
      init?: RequestInit,
    ): Promise<{ status: number; body: any }> => {
      const response = await fetch(url, init);
      return { status: response.status, body: await response.json() };
    };
    const post = (pathname: string, body: unknown): Promise<{ status: number; body: any }> =>
      json(`${server.baseUrl}${pathname}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    try {
      const health = await json(`${server.baseUrl}/api/health`);
      assert.equal(health.body.capabilities.settings, true);

      const initial = await json(`${server.baseUrl}/api/settings`);
      assert.equal(initial.status, 200);
      assert.equal(initial.body.writable, true);
      const codexRow = initial.body.agents.find(
        (agent: { name: string }) => agent.name === "codex",
      );
      assert.equal(codexRow.enabled, true);
      assert.deepEqual(codexRow.argv, ["real-codex", "--acp"]);

      // Disabling hides the agent from the live catalog but keeps its settings row.
      assert.equal(
        (await post("/api/settings/agents", { name: "codex", enabled: false })).status,
        200,
      );
      const afterDisable = await json(`${server.baseUrl}/api/agents`);
      assert.equal(
        afterDisable.body.agents.some((agent: { id: string }) => agent.id === "codex"),
        false,
      );
      const settingsAfterDisable = await json(`${server.baseUrl}/api/settings`);
      assert.equal(
        settingsAfterDisable.body.agents.find((agent: { name: string }) => agent.name === "codex")
          .enabled,
        false,
      );

      // Editing argv + env re-enables it and preserves unrelated top-level keys.
      assert.equal(
        (
          await post("/api/settings/agents", {
            name: "codex",
            enabled: true,
            argv: ["my-codex", "--acp"],
            env: { TOKEN: "secret" },
          })
        ).status,
        200,
      );
      const edited = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
      assert.deepEqual(edited.keepMe, { nested: true });
      assert.deepEqual((edited.agents as Record<string, unknown>).codex, {
        argv: ["my-codex", "--acp"],
        env: { TOKEN: "secret" },
      });

      assert.equal((await post("/api/settings/agents/remove", { name: "codex" })).status, 200);
      const removed = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
      assert.equal((removed.agents as Record<string, unknown>).codex, undefined);
      assert.deepEqual(removed.keepMe, { nested: true });

      const unsafe = await post("/api/settings/agents", {
        name: "../evil",
        enabled: false,
      });
      assert.equal(unsafe.status, 400);
      assert.equal(unsafe.body.error.code, "unsafe_name");

      const empty = await post("/api/settings/agents", { name: "codex" });
      assert.equal(empty.status, 400);
      assert.equal(empty.body.error.code, "invalid_body");
    } finally {
      await server.close();
    }
  });
});

test("settings mutations are rejected with --no-settings", async () => {
  await withTempDir(async (dir) => {
    const server = await createChatServer({
      host: "127.0.0.1",
      port: 0,
      serveUi: false,
      cwd: dir,
      stateDir: path.join(dir, "state"),
      agentCatalog: buildMockCatalog(),
      allowSettings: false,
    });
    try {
      const health = (await (await fetch(`${server.baseUrl}/api/health`)).json()) as {
        capabilities: { settings: boolean };
      };
      assert.equal(health.capabilities.settings, false);

      const response = await fetch(`${server.baseUrl}/api/settings/agents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "mock", enabled: false }),
      });
      assert.equal(response.status, 403);
      const body = (await response.json()) as { error: { code: string } };
      assert.equal(body.error.code, "settings_disabled");
    } finally {
      await server.close();
    }
  });
});

test("chat WebSocket advertises and changes the session model", async () => {
  await withTempDir(async (dir) => {
    const server = await createChatServer({
      host: "127.0.0.1",
      port: 0,
      serveUi: false,
      cwd: dir,
      stateDir: path.join(dir, "state"),
      agentCatalog: buildMockCatalogWith(["--advertise-models"]),
    });
    const client = new ChatClient(server.port);
    try {
      await client.open();
      await client.waitFor("ready");

      client.send({ type: "open_session", chatId: "m1", agent: "mock" });
      const opened = await client.waitFor("session_opened");
      assert.ok(opened.models);
      assert.equal(opened.models.currentModelId, "default-model");
      assert.deepEqual(opened.models.availableModelIds, [
        "default-model",
        "fast-model",
        "smart-model",
        "gpt-5.4",
        "gpt-5.2",
      ]);
      assert.equal(opened.model, "default-model");

      client.send({ type: "set_model", chatId: "m1", model: "fast-model" });
      const changed = await client.waitFor("session_models");
      assert.equal(changed.chatId, "m1");
      assert.equal(changed.models.currentModelId, "fast-model");
    } finally {
      client.close();
      await server.close();
    }
  });
});

test("a failing set_model surfaces model_unsupported", async () => {
  await withTempDir(async (dir) => {
    const server = await createChatServer({
      host: "127.0.0.1",
      port: 0,
      serveUi: false,
      cwd: dir,
      stateDir: path.join(dir, "state"),
      agentCatalog: buildMockCatalogWith(["--set-session-model-fails"]),
    });
    const client = new ChatClient(server.port);
    try {
      await client.open();
      await client.waitFor("ready");
      client.send({ type: "open_session", chatId: "m2", agent: "mock" });
      await client.waitFor("session_opened");

      client.send({ type: "set_model", chatId: "m2", model: "fast-model" });
      const failure = await client.waitFor("error", (message) => message.chatId === "m2");
      assert.equal(failure.code, "model_unsupported");
    } finally {
      client.close();
      await server.close();
    }
  });
});

test("set_model is rejected while a turn is running", async () => {
  await withTempDir(async (dir) => {
    const server = await createChatServer({
      host: "127.0.0.1",
      port: 0,
      serveUi: false,
      cwd: dir,
      stateDir: path.join(dir, "state"),
      agentCatalog: buildMockCatalogWith(["--advertise-models"]),
    });
    const client = new ChatClient(server.port);
    try {
      await client.open();
      await client.waitFor("ready");
      client.send({ type: "open_session", chatId: "m3", agent: "mock" });
      await client.waitFor("session_opened");

      client.send({
        type: "send",
        chatId: "m3",
        text: "sleep 5000",
        requestId: "r1",
      });
      await client.waitFor("turn_started", (message) => message.requestId === "r1");
      client.send({
        type: "set_model",
        chatId: "m3",
        model: "alternate-model",
      });
      const failure = await client.waitFor("error", (message) => message.chatId === "m3");
      assert.equal(failure.code, "turn_in_progress");

      client.send({ type: "cancel", chatId: "m3" });
      await client.waitFor("turn_done", (message) => message.requestId === "r1");
    } finally {
      client.close();
      await server.close();
    }
  });
});

test("one socket runs multiple sessions concurrently", async () => {
  await withTempDir(async (dir) => {
    const server = await createChatServer({
      host: "127.0.0.1",
      port: 0,
      serveUi: false,
      cwd: dir,
      stateDir: path.join(dir, "state"),
      agentCatalog: buildMockCatalog(),
    });
    const client = new ChatClient(server.port);
    try {
      await client.open();
      await client.waitFor("ready");

      client.send({ type: "open_session", chatId: "s1", agent: "mock" });
      client.send({ type: "open_session", chatId: "s2", agent: "mock" });
      await client.waitFor("session_opened", (message) => message.chatId === "s1");
      await client.waitFor("session_opened", (message) => message.chatId === "s2");

      client.send({
        type: "send",
        chatId: "s1",
        text: "echo one",
        requestId: "r1",
      });
      client.send({
        type: "send",
        chatId: "s2",
        text: "echo two",
        requestId: "r2",
      });
      const first = await client.waitFor(
        "turn_done",
        (message) => message.chatId === "s1" && message.requestId === "r1",
      );
      const second = await client.waitFor(
        "turn_done",
        (message) => message.chatId === "s2" && message.requestId === "r2",
      );
      assert.equal(first.status, "completed");
      assert.equal(second.status, "completed");

      client.send({ type: "close_session", chatId: "s2" });
      const closed = await client.waitFor("session_closed");
      assert.equal(closed.chatId, "s2");

      // Closing one session leaves the other usable.
      client.send({
        type: "send",
        chatId: "s1",
        text: "echo again",
        requestId: "r3",
      });
      const third = await client.waitFor(
        "turn_done",
        (message) => message.chatId === "s1" && message.requestId === "r3",
      );
      assert.equal(third.status, "completed");
    } finally {
      client.close();
      await server.close();
    }
  });
});

test("reduceSessionsState routes frames to the named session", () => {
  let state = createInitialSessionsState({
    sessions: [
      { chatId: "a", agent: "mock" },
      { chatId: "b", agent: "mock" },
    ],
    activeChatId: "b",
  });
  assert.equal(state.activeChatId, "b");

  state = reduceSessionsState(state, {
    type: "ready",
    protocol: "acpx.chat.v1",
  });
  assert.equal(state.connected, true);

  state = reduceSessionsState(state, {
    type: "session_opened",
    chatId: "a",
    sessionKey: "agent:mock:web:a",
    agent: "mock",
    cwd: "/tmp",
  });
  assert.equal(state.sessions.a?.sessionKey, "agent:mock:web:a");
  assert.equal(state.sessions.b?.sessionKey, undefined);

  state = reduceSessionsState(state, {
    type: "user_message",
    chatId: "a",
    requestId: "r1",
    text: "hi",
  });
  assert.equal(state.sessions.a?.transcript.length, 1);
  assert.equal(state.sessions.b?.transcript.length, 0);

  state = reduceSessionsState(state, {
    type: "error",
    chatId: "a",
    code: "session_error",
    message: "boom",
  });
  assert.deepEqual(state.sessions.a?.errors, ["boom"]);
  assert.deepEqual(state.sessions.b?.errors, []);

  // A frame without a chat id lands on the active session.
  state = reduceSessionsState(state, {
    type: "error",
    code: "internal_error",
    message: "oops",
  });
  assert.deepEqual(state.sessions.b?.errors, ["oops"]);

  state = reduceSessionsState(state, { type: "select_session", chatId: "a" });
  assert.equal(state.activeChatId, "a");

  state = reduceSessionsState(state, { type: "session_removed", chatId: "a" });
  assert.equal(state.sessions.a, undefined);
  assert.equal(state.activeChatId, "b");
  assert.deepEqual(state.order, ["b"]);
});

test("reduceSessionsState tracks the opening flag until a session resolves", () => {
  let state = createInitialSessionsState({
    sessions: [],
    activeChatId: undefined,
  });

  state = reduceSessionsState(state, {
    type: "opening",
    chatId: "a",
    agent: "mock",
  });
  assert.equal(state.sessions.a?.opening, true);
  assert.equal(state.sessions.a?.agent, "mock");

  state = reduceSessionsState(state, {
    type: "session_opened",
    chatId: "a",
    sessionKey: "agent:mock:web:a",
    agent: "mock",
    cwd: "/tmp",
  });
  assert.equal(state.sessions.a?.opening, false);

  // Switching the agent on an open chat re-locks the composer while the server
  // replaces the runtime session.
  state = reduceSessionsState(state, {
    type: "opening",
    chatId: "a",
    agent: "other",
  });
  assert.equal(state.sessions.a?.opening, true);
  assert.equal(state.sessions.a?.agent, "other");

  // A failed open never emits `session_opened`; the error must release the lock
  // or the chat would stay unusable behind a dead session.
  state = reduceSessionsState(state, {
    type: "error",
    chatId: "a",
    code: "agent_not_found",
    message: "no such agent",
  });
  assert.equal(state.sessions.a?.opening, false);
  assert.deepEqual(state.sessions.a?.errors, ["no such agent"]);
});

test("open_session applies a per-session permission mode and echoes it back", async () => {
  await withTempDir(async (dir) => {
    const server = await createChatServer({
      host: "127.0.0.1",
      port: 0,
      serveUi: false,
      cwd: dir,
      stateDir: path.join(dir, "state"),
      agentCatalog: buildMockCatalog(),
    });
    const client = new ChatClient(server.port);
    try {
      await client.open();
      await client.waitFor("ready");
      client.send({ type: "hello", protocol: "acpx.chat.v1" });

      client.send({
        type: "open_session",
        chatId: "p1",
        agent: "mock",
        permissionMode: "deny-all",
      });
      const opened = await client.waitFor("session_opened", (message) => message.chatId === "p1");
      assert.equal(opened.permissionMode, "deny-all");
      assert.match(opened.sessionKey, /:deny-all$/u);

      // The server-default session keeps the default mode and a distinct key.
      client.send({ type: "open_session", chatId: "p2", agent: "mock" });
      const defaulted = await client.waitFor(
        "session_opened",
        (message) => message.chatId === "p2",
      );
      assert.equal(defaulted.permissionMode, "approve-all");
      assert.match(defaulted.sessionKey, /:approve-all$/u);

      // Switching the mode on the same chat reopens it under the new mode.
      client.send({
        type: "open_session",
        chatId: "p2",
        agent: "mock",
        permissionMode: "approve-reads",
      });
      const switched = await client.waitFor("session_opened", (message) => message.chatId === "p2");
      assert.equal(switched.permissionMode, "approve-reads");
      assert.match(switched.sessionKey, /:approve-reads$/u);
    } finally {
      client.close();
      await server.close();
    }
  });
});

test("GET /api/fs/dirs lists subdirectories and rejects files", async () => {
  await withTempDir(async (dir) => {
    await fs.mkdir(path.join(dir, "alpha"));
    await fs.mkdir(path.join(dir, "beta"));
    await fs.writeFile(path.join(dir, "plain.txt"), "x");
    const server = await createChatServer({
      host: "127.0.0.1",
      port: 0,
      serveUi: false,
      cwd: dir,
      stateDir: path.join(dir, "state"),
      agentCatalog: buildMockCatalog(),
    });
    try {
      const response = await fetch(`${server.baseUrl}/api/fs/dirs?path=${encodeURIComponent(dir)}`);
      assert.equal(response.status, 200);
      const payload = (await response.json()) as {
        path: string;
        parent: string | null;
        entries: Array<{ name: string; path: string }>;
      };
      assert.deepEqual(
        payload.entries.map((entry) => entry.name),
        ["alpha", "beta"],
      );
      assert.equal(payload.parent, path.dirname(dir));

      const fileResponse = await fetch(
        `${server.baseUrl}/api/fs/dirs?path=${encodeURIComponent(path.join(dir, "plain.txt"))}`,
      );
      assert.equal(fileResponse.status, 400);
      const filePayload = (await fileResponse.json()) as { code?: string };
      assert.equal(filePayload.code, "fs_error");
    } finally {
      await server.close();
    }
  });
});

test("POST /api/diagnostics runs init, models, and ping for installed agents", async () => {
  await withTempDir(async (dir) => {
    const server = await createChatServer({
      host: "127.0.0.1",
      port: 0,
      serveUi: false,
      cwd: dir,
      stateDir: path.join(dir, "state"),
      agentCatalog: buildMockCatalogWith(["--advertise-models"]),
    });
    try {
      const startResponse = await fetch(`${server.baseUrl}/api/diagnostics`, {
        method: "POST",
      });
      assert.equal(startResponse.status, 200);
      const startPayload = (await startResponse.json()) as {
        ok: boolean;
        run: DiagnosticsRun;
      };
      assert.equal(startPayload.ok, true);
      assert.deepEqual(
        startPayload.run.agents.map((agent) => agent.name),
        ["mock"],
      );

      // Poll until the run finishes.
      const deadline = Date.now() + 30_000;
      let run = startPayload.run;
      while (run.finishedAt === undefined) {
        if (Date.now() > deadline) {
          throw new Error("diagnostics run did not finish in time");
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
        const statusResponse = await fetch(`${server.baseUrl}/api/diagnostics`);
        const statusPayload = (await statusResponse.json()) as {
          running: boolean;
          run: typeof run | null;
        };
        if (statusPayload.run?.finishedAt === undefined) {
          assert.equal(statusPayload.running, true);
        }
        run = statusPayload.run as typeof run;
      }

      assert.equal(run.agents.length, 1);
      const agent = run.agents[0];
      assert.equal(agent.name, "mock");
      assert.equal(agent.init.status, "ok");
      assert.equal(typeof agent.init.ms, "number");
      assert.equal(agent.models.status, "ok");
      assert.deepEqual(agent.models.names, [
        "default-model",
        "fast-model",
        "smart-model",
        "gpt-5.4",
        "gpt-5.2",
      ]);
      assert.equal(agent.ping.status, "ok");
      assert.match(agent.ping.reply ?? "", /unrecognized prompt: ping/u);
    } finally {
      await server.close();
    }
  });
});

test("diagnostics report failures for agents whose command does not exist", async () => {
  await withTempDir(async (dir) => {
    const broken = {
      agents: [
        {
          id: "broken",
          name: "broken",
          source: "config" as const,
          availability: "installed" as const,
          launch: { argv: [path.join(dir, "does-not-exist")] },
          isDefault: true,
        },
      ],
      overrides: { broken: [path.join(dir, "does-not-exist")] },
      defaultAgent: "broken",
    };
    const server = await createChatServer({
      host: "127.0.0.1",
      port: 0,
      serveUi: false,
      cwd: dir,
      stateDir: path.join(dir, "state"),
      agentCatalog: broken,
    });
    try {
      const startResponse = await fetch(`${server.baseUrl}/api/diagnostics`, {
        method: "POST",
      });
      assert.equal(startResponse.status, 200);
      const deadline = Date.now() + 30_000;
      let run: DiagnosticsRun | undefined;
      for (;;) {
        const statusResponse = await fetch(`${server.baseUrl}/api/diagnostics`);
        const statusPayload = (await statusResponse.json()) as {
          run: typeof run;
        };
        run = statusPayload.run ?? undefined;
        if (run?.finishedAt !== undefined) {
          break;
        }
        if (Date.now() > deadline) {
          throw new Error("diagnostics run did not finish in time");
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      const agent = run.agents[0];
      assert.equal(agent.name, "broken");
      assert.equal(agent.init.status, "failed");
      assert.ok(agent.init.error);
      assert.equal(agent.models.status, "skipped");
      assert.equal(agent.ping.status, "skipped");
    } finally {
      await server.close();
    }
  });
});

test("diagnostics enumerates gateway backend agents and their models", async () => {
  await withTempDir(async (dir) => {
    const gatewayConfigPath = path.join(dir, "gateway.agents.json");
    await fs.writeFile(
      gatewayConfigPath,
      JSON.stringify({
        agents: [
          {
            name: "backend-with-models",
            argv: [process.execPath, mockAgentPath, "--advertise-models"],
            default: true,
          },
          { name: "backend-plain", argv: [process.execPath, mockAgentPath] },
        ],
      }),
    );
    // The compiled test lives in <repo>/dist-test/test, so two levels up is
    // the repo root in both source and compiled layouts.
    const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
    const cliPath = path.join(repoRoot, "dist", "cli.js");
    const gatewayArgv = [process.execPath, cliPath, "gateway", "--config", gatewayConfigPath];
    const server = await createChatServer({
      host: "127.0.0.1",
      port: 0,
      serveUi: false,
      cwd: dir,
      stateDir: path.join(dir, "state"),
      agentCatalog: {
        agents: [
          {
            id: "gw",
            name: "gw",
            source: "config",
            availability: "installed",
            launch: { argv: gatewayArgv },
            isDefault: true,
          },
        ],
        overrides: { gw: gatewayArgv },
        defaultAgent: "gw",
      },
    });
    try {
      await fetch(`${server.baseUrl}/api/diagnostics`, { method: "POST" });
      const deadline = Date.now() + 60_000;
      let run: DiagnosticsRun | undefined;
      for (;;) {
        const statusResponse = await fetch(`${server.baseUrl}/api/diagnostics`);
        const statusPayload = (await statusResponse.json()) as {
          run: typeof run;
        };
        run = statusPayload.run ?? undefined;
        if (run?.finishedAt !== undefined) {
          break;
        }
        if (Date.now() > deadline) {
          throw new Error("diagnostics run did not finish in time");
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      const agent = run.agents[0];
      assert.equal(agent.name, "gw");
      assert.equal(agent.isGateway, true);
      assert.equal(agent.models.status, "ok");
      // The gateway merges every backend's models and prefixes each label with
      // its agent so a client can route a selection back to one backend.
      assert.deepEqual(agent.models.names, [
        "backend-with-models: default-model",
        "backend-with-models: fast-model",
        "backend-with-models: smart-model",
        "backend-with-models: gpt-5.4",
        "backend-with-models: gpt-5.2",
      ]);
      assert.equal(agent.ping.status, "ok");
      assert.deepEqual(
        agent.backends?.map((backend) => backend.name),
        ["backend-with-models", "backend-plain"],
      );
      const withModels = agent.backends?.[0];
      assert.equal(withModels?.status, "ok");
      assert.equal(withModels?.names.length, 5);
      const plain = agent.backends?.[1];
      assert.equal(plain?.status, "ok");
      assert.deepEqual(plain?.names, []);
    } finally {
      await server.close();
    }
  });
});

/**
 * Config-backed gateway: the gateway launch carries no `--config`, so backend
 * enumeration comes from the main config (HOME global config in the test).
 * Nothing passes `gatewayConfigPath`; settings and the catalog must agree.
 */
test("diagnostics and settings agree on a config-backed gateway without --config", async () => {
  await withTempHome(async (homeDir) => {
    await withTempDir(async (dir) => {
      await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
      const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
      const gatewayArgv = [process.execPath, path.join(repoRoot, "dist", "cli.js"), "gateway"];
      await fs.writeFile(
        path.join(homeDir, ".acpx", "config.json"),
        JSON.stringify({
          agents: {
            "backend-a": {
              argv: [process.execPath, mockAgentPath, "--advertise-models"],
            },
            "backend-b": { argv: [process.execPath, mockAgentPath] },
            gw: { argv: gatewayArgv },
          },
        }),
      );
      const server = await createChatServer({
        host: "127.0.0.1",
        port: 0,
        serveUi: false,
        cwd: dir,
        stateDir: path.join(dir, "state"),
      });
      try {
        const settingsResponse = await fetch(`${server.baseUrl}/api/settings`);
        assert.equal(settingsResponse.status, 200);
        const view = (await settingsResponse.json()) as {
          agents: Array<{ name: string; source: string; isGateway: boolean }>;
        };
        const settingsByName = new Map(view.agents.map((agent) => [agent.name, agent]));
        assert.equal(settingsByName.get("gw")?.isGateway, true);
        assert.equal(settingsByName.get("gw")?.source, "config");
        assert.equal(settingsByName.get("backend-a")?.source, "config");
        assert.equal(settingsByName.get("backend-b")?.source, "config");

        const agentsResponse = await fetch(`${server.baseUrl}/api/agents`);
        const catalog = (await agentsResponse.json()) as {
          agents: Array<{ name: string; source: string }>;
        };
        const configured = catalog.agents
          .filter((agent) => agent.source === "config")
          .map((agent) => agent.name);
        assert.deepEqual([...configured].toSorted(), ["backend-a", "backend-b", "gw"]);
        for (const name of configured) {
          assert.ok(settingsByName.has(name), `settings must list configured agent ${name}`);
        }

        const startResponse = await fetch(`${server.baseUrl}/api/diagnostics`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agents: [{ name: "gw", argv: gatewayArgv }],
          }),
        });
        assert.equal(startResponse.status, 200);
        const deadline = Date.now() + 60_000;
        let run: DiagnosticsRun | undefined;
        for (;;) {
          const statusResponse = await fetch(`${server.baseUrl}/api/diagnostics`);
          const statusPayload = (await statusResponse.json()) as {
            run: typeof run;
          };
          run = statusPayload.run ?? undefined;
          if (run?.finishedAt !== undefined) {
            break;
          }
          if (Date.now() > deadline) {
            throw new Error("diagnostics run did not finish in time");
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }

        const agent = run.agents[0];
        assert.equal(agent.name, "gw");
        assert.equal(agent.isGateway, true);
        assert.deepEqual(
          agent.backends?.map((backend) => backend.name),
          ["backend-a", "backend-b"],
        );
      } finally {
        await server.close();
      }
    });
  });
});

/**
 * Full real-gateway chain: a WebSocket client drives the chat server, which
 * spawns a real `acpx gateway --config <file>` process, which in turn fronts
 * the mock agent backends. Nothing on the path is stubbed.
 */
test("chat WebSocket streams a turn through a real acpx gateway backend", async () => {
  await withTempDir(async (dir) => {
    const gatewayConfigPath = path.join(dir, "gateway.agents.json");
    await fs.writeFile(
      gatewayConfigPath,
      JSON.stringify({
        agents: [
          {
            name: "alpha",
            argv: [process.execPath, mockAgentPath],
            default: true,
          },
          {
            name: "beta",
            argv: [process.execPath, mockAgentPath, "--advertise-models"],
          },
        ],
      }),
    );
    const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
    const gatewayArgv = [
      process.execPath,
      path.join(repoRoot, "dist", "cli.js"),
      "gateway",
      "--config",
      gatewayConfigPath,
    ];
    const server = await createChatServer({
      host: "127.0.0.1",
      port: 0,
      serveUi: false,
      cwd: dir,
      stateDir: path.join(dir, "state"),
      agentCatalog: {
        agents: [
          {
            id: "gw",
            name: "gw",
            source: "config",
            availability: "installed",
            launch: { argv: gatewayArgv },
            isDefault: true,
          },
        ],
        overrides: { gw: gatewayArgv },
        defaultAgent: "gw",
      },
    });
    const client = new ChatClient(server.port);
    try {
      await client.open();
      await client.waitFor("ready");
      client.send({ type: "hello", protocol: "acpx.chat.v1" });

      client.send({ type: "open_session", chatId: "gw1", agent: "gw" });
      const opened = await client.waitFor("session_opened", (message) => message.chatId === "gw1");
      assert.equal(opened.agent, "gw");
      assert.equal(opened.cwd, dir);

      // Backends probe in the background, so the merged models arrive either
      // with the session or as a pushed update once discovery lands.
      const models =
        (opened.models?.availableModelIds.length ?? 0) > 0
          ? opened.models
          : (await client.waitFor("session_models", (message) => message.chatId === "gw1")).models;
      assert.deepEqual(models?.availableModelIds.toSorted(), [
        "beta/default-model",
        "beta/fast-model",
        "beta/gpt-5.2",
        "beta/gpt-5.4",
        "beta/smart-model",
      ]);

      client.send({
        type: "send",
        chatId: "gw1",
        text: "echo via-gateway",
        requestId: "gw-r1",
      });
      await client.waitFor("turn_started", (message) => message.requestId === "gw-r1");
      const delta = await client.waitFor(
        "text_delta",
        (message) => message.requestId === "gw-r1" && message.text.includes("via-gateway"),
      );
      assert.equal(delta.stream, "output");
      const done = await client.waitFor("turn_done", (message) => message.requestId === "gw-r1");
      assert.equal(done.status, "completed");
      assert.equal(done.stopReason, "end_turn");
    } finally {
      client.close();
      await server.close();
    }
  });
});
