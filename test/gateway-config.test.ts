import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InvalidArgumentError } from "commander";
import { loadResolvedConfig } from "../src/cli/config.js";
import {
  isGatewayProcessLaunch,
  parseGatewayConfig,
  resolveGatewayAgentsFromConfig,
} from "../src/cli/gateway-command.js";

test("gateway config selection: config order preserved and first entry is default", async () => {
  await withTempEnv(async ({ homeDir }) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await writeGlobalConfig(homeDir, {
      agents: {
        alpha: { argv: ["node", "alpha.mjs"] },
        beta: { argv: ["node", "beta.mjs"] },
      },
    });
    const config = await loadResolvedConfig(cwd);
    const selection = resolveGatewayAgentsFromConfig(config);
    assert.deepEqual(
      selection.agents.map((spec) => spec.name),
      ["alpha", "beta"],
    );
    assert.equal(selection.defaultAgent, "alpha");
  });
});

test("gateway config selection: gateway launches are excluded in argv and command form", async () => {
  await withTempEnv(async ({ homeDir }) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await writeGlobalConfig(homeDir, {
      agents: {
        alpha: { argv: ["node", "alpha.mjs"] },
        "acpx-gateway": { argv: ["node", "cli.js", "--approve-all", "gateway"] },
        "legacy-gateway": { command: "node cli.js gateway" },
      },
    });
    const config = await loadResolvedConfig(cwd);
    const selection = resolveGatewayAgentsFromConfig(config);
    assert.deepEqual(
      selection.agents.map((spec) => spec.name),
      ["alpha"],
    );
  });
});

test("gateway config selection: argv and env are copied, not shared", async () => {
  await withTempEnv(async ({ homeDir }) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await writeGlobalConfig(homeDir, {
      agents: {
        alpha: { argv: ["node", "alpha.mjs"], env: { TOKEN: "secret" } },
      },
    });
    const config = await loadResolvedConfig(cwd);
    const selection = resolveGatewayAgentsFromConfig(config);
    const spec = selection.agents[0];
    assert.ok(spec.agentArgv);
    assert.ok(spec.env);
    spec.agentArgv.push("mutated");
    spec.env.TOKEN = "mutated";
    assert.deepEqual(config.agents.alpha.argv, ["node", "alpha.mjs"]);
    assert.deepEqual(config.agents.alpha.env, { TOKEN: "secret" });
  });
});

test("gateway config selection: no servable agents is an error", async () => {
  await withTempEnv(async ({ homeDir }) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await writeGlobalConfig(homeDir, {
      agents: {
        "acpx-gateway": { argv: ["node", "cli.js", "gateway"] },
      },
    });
    const config = await loadResolvedConfig(cwd);
    assert.throws(
      () => resolveGatewayAgentsFromConfig(config),
      (error: unknown) => {
        assert.ok(error instanceof InvalidArgumentError);
        assert.match(error.message, /No agents to serve/u);
        return true;
      },
    );
  });
});

test("gateway config selection: enabledModels are threaded and gateway entries filter the merged surface", async () => {
  await withTempEnv(async ({ homeDir }) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await writeGlobalConfig(homeDir, {
      agents: {
        alpha: { argv: ["node", "alpha.mjs"], enabledModels: ["m-1", "m-2"] },
        beta: { argv: ["node", "beta.mjs"] },
        "acpx-gateway": {
          argv: ["node", "cli.js", "gateway"],
          enabledModels: ["alpha/m-1", "beta/m-9"],
        },
      },
    });
    const config = await loadResolvedConfig(cwd);
    const selection = resolveGatewayAgentsFromConfig(config);
    assert.deepEqual(selection.agents[0].enabledModels, ["m-1", "m-2"]);
    assert.equal(selection.agents[1].enabledModels, undefined);
    assert.deepEqual(selection.gatewayEnabledModels, ["alpha/m-1", "beta/m-9"]);
  });
});

test("isGatewayProcessLaunch: detects gateway token across launch forms", () => {
  assert.equal(isGatewayProcessLaunch({ command: "x", argv: ["node", "cli.js", "gateway"] }), true);
  assert.equal(isGatewayProcessLaunch({ command: "node cli.js gateway" }), true);
  assert.equal(
    isGatewayProcessLaunch({ command: "node alpha.mjs", argv: ["node", "alpha.mjs"] }),
    false,
  );
  assert.equal(isGatewayProcessLaunch({ command: "my-tool --flag gateway-server" }), false);
});

test("gateway config selection: the fallback chain is parsed with descending priority", async () => {
  await withTempEnv(async ({ homeDir }) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await writeGlobalConfig(homeDir, {
      agents: {
        alpha: { argv: ["node", "alpha.mjs"] },
        beta: { argv: ["node", "beta.mjs"] },
      },
      fallbacks: [{ agent: "alpha" }, { agent: "beta", model: "beta-2" }],
    });
    const config = await loadResolvedConfig(cwd);
    assert.deepEqual(config.fallbacks, [
      { agent: "alpha", priority: 2 },
      { agent: "beta", model: "beta-2", priority: 1 },
    ]);
    const selection = resolveGatewayAgentsFromConfig(config);
    assert.deepEqual(selection.fallbacks, config.fallbacks);
  });
});

test("gateway config selection: an explicit priority is kept", async () => {
  await withTempEnv(async ({ homeDir }) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await writeGlobalConfig(homeDir, {
      agents: { alpha: { argv: ["node", "alpha.mjs"] } },
      fallbacks: [
        { agent: "alpha", priority: 10 },
        { agent: "beta", priority: 90 },
      ],
    });
    const config = await loadResolvedConfig(cwd);
    assert.deepEqual(config.fallbacks, [
      { agent: "alpha", priority: 10 },
      { agent: "beta", priority: 90 },
    ]);
  });
});

test("gateway config selection: an entry without a priority slots below the previous one", async () => {
  await withTempEnv(async ({ homeDir }) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await writeGlobalConfig(homeDir, {
      agents: { alpha: { argv: ["node", "alpha.mjs"] } },
      fallbacks: [{ agent: "alpha", priority: 10 }, { agent: "beta" }],
    });
    const config = await loadResolvedConfig(cwd);
    assert.deepEqual(config.fallbacks, [
      { agent: "alpha", priority: 10 },
      { agent: "beta", priority: 9 },
    ]);
  });
});

test("gateway config selection: a chain without priorities keeps the configured order", async () => {
  await withTempEnv(async ({ homeDir }) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await writeGlobalConfig(homeDir, {
      agents: { alpha: { argv: ["node", "alpha.mjs"] } },
      fallbacks: [{ agent: "alpha" }, { agent: "beta" }],
    });
    const config = await loadResolvedConfig(cwd);
    assert.deepEqual(config.fallbacks, [
      { agent: "alpha", priority: 2 },
      { agent: "beta", priority: 1 },
    ]);
  });
});

test("gateway config selection: an invalid chain entry is rejected", async () => {
  await withTempEnv(async ({ homeDir }) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await writeGlobalConfig(homeDir, {
      agents: { alpha: { argv: ["node", "alpha.mjs"] } },
      fallbacks: [{ agent: "alpha", priority: 1.5 }],
    });
    await assert.rejects(loadResolvedConfig(cwd), (error: unknown) => {
      assert.match((error as Error).message, /expected integer/u);
      return true;
    });

    await writeGlobalConfig(homeDir, {
      agents: { alpha: { argv: ["node", "alpha.mjs"] } },
      fallbacks: [{ model: "alpha-1" }],
    });
    await assert.rejects(loadResolvedConfig(cwd), (error: unknown) => {
      assert.match((error as Error).message, /expected non-empty string/u);
      return true;
    });
  });
});

test("gateway config selection: a project chain replaces the global chain", async () => {
  await withTempEnv(async ({ homeDir }) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await writeGlobalConfig(homeDir, {
      agents: { alpha: { argv: ["node", "alpha.mjs"] } },
      fallbacks: [{ agent: "alpha" }],
    });
    await fs.writeFile(
      path.join(cwd, ".acpxrc.json"),
      `${JSON.stringify({ fallbacks: [{ agent: "beta" }] }, null, 2)}\n`,
      "utf8",
    );
    const config = await loadResolvedConfig(cwd);
    assert.deepEqual(config.fallbacks, [{ agent: "beta", priority: 1 }]);
  });
});

test("gateway config file: the legacy gateway config parses a fallback chain", () => {
  const parsed = parseGatewayConfig(
    {
      agents: [{ name: "alpha", command: "node alpha.mjs" }],
      fallbacks: [{ agent: "alpha", priority: 100 }, { agent: "beta" }],
    },
    "/tmp/gateway.json",
  );
  assert.deepEqual(parsed.fallbacks, [
    { agent: "alpha", priority: 100 },
    { agent: "beta", priority: 99 },
  ]);
});

async function writeGlobalConfig(homeDir: string, config: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
  await fs.writeFile(
    path.join(homeDir, ".acpx", "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
}

async function withTempEnv(run: (ctx: { homeDir: string }) => Promise<void>): Promise<void> {
  const originalHome = process.env.HOME;
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-gateway-config-home-"));
  process.env.HOME = homeDir;
  try {
    await run({ homeDir });
  } finally {
    if (originalHome == null) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}
