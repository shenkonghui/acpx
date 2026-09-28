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
import { MutableAgentRegistry } from "../examples/acp-chat/server/live-registry.js";
import {
  createInitialChatState,
  reduceChatState,
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

  assert.equal(parseChatCliArgs(["status"]).command, "status");
  assert.equal(parseChatCliArgs(["stop", "--port=5000"]).port, 5000);
  assert.equal(parseChatCliArgs(["--port", "0"]).port, 0);
  assert.equal(parseChatCliArgs(["--permission-mode", "deny-all"]).permissionMode, "deny-all");
  assert.equal(parseChatCliArgs(["--verbose", "--open"]).verbose, true);
  assert.equal(parseChatCliArgs(["--verbose", "--open"]).open, true);
  assert.equal(parseChatCliArgs(["--no-install"]).allowInstall, false);
  assert.equal(parseChatCliArgs(["--no-command"]).allowCommand, false);
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
        { name: "qoder", agentCommand: "qodercli", agentArgv: ["qodercli", "--acp"] },
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
    configAgents: { qoder: { command: "my-qoder", argv: ["my-qoder", "--acp"] } },
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
        launch: { kind: "missing", requirements: [{ kind: "command", name: "beta" }] },
      };
    }
    if (id === "gamma") {
      return undefined;
    }
    return { id, name: id.toUpperCase(), launch: { kind: "installed", argv: [id, "--acp"] } };
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

  state = reduceChatState(state, { type: "user_message", requestId: "r1", text: "hi" });
  state = reduceChatState(state, { type: "turn_started", chatId: "chat-1", requestId: "r1" });
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
  assert.deepEqual(tool?.kind === "tool" ? tool.rawOutput : undefined, { content: "x" });

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

  state = reduceChatState(state, { type: "opening", agent: "codex", cwd: "/tmp" });
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
      assert.match(opened.sessionKey, /^agent:mock:web:c1$/u);

      client.send({ type: "send", chatId: "c1", text: "echo hi", requestId: "r1" });
      await client.waitFor("turn_started", (message) => message.requestId === "r1");
      const delta = await client.waitFor("text_delta", (message) => message.text.includes("hi"));
      assert.equal(delta.stream, "output");
      const done = await client.waitFor("turn_done", (message) => message.requestId === "r1");
      assert.equal(done.status, "completed");
      assert.equal(done.stopReason, "end_turn");

      client.send({ type: "send", chatId: "c1", text: "sleep 5000", requestId: "r2" });
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
      assert.match(opened.sessionKey, /^agent:adhoc-[0-9a-f]{8}:web:cmd1$/u);

      client.send({ type: "send", chatId: "cmd1", text: "echo hi", requestId: "r1" });
      await client.waitFor("turn_started", (message) => message.requestId === "r1");
      const delta = await client.waitFor("text_delta", (message) => message.text.includes("hi"));
      assert.equal(delta.stream, "output");
      const done = await client.waitFor("turn_done", (message) => message.requestId === "r1");
      assert.equal(done.status, "completed");

      client.send({ type: "open_session", chatId: "cmd2", command: "definitely-missing-xyz-123" });
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
      client.send({ type: "open_session", chatId: "cmd1", command: process.execPath });
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
        body: JSON.stringify({ id: "hello-agent", method: "npx", asName: "hello" }),
      });
      assert.equal(installResponse.status, 200);
      const installed = (await installResponse.json()) as {
        ok: boolean;
        result: { registeredName: string };
      };
      assert.equal(installed.ok, true);
      assert.equal(installed.result.registeredName, "hello-agent");
      assert.deepEqual(calls, [
        { id: "hello-agent", options: { asName: "hello", method: "npx", force: false } },
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
        capabilities?: { install: boolean; command: boolean };
      };
      assert.deepEqual(health.capabilities, { install: false, command: true });

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
