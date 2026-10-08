import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InvalidArgumentError } from "commander";
import { loadResolvedConfig } from "../src/cli/config.js";
import {
  isGatewayProcessLaunch,
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

test("isGatewayProcessLaunch: detects gateway token across launch forms", () => {
  assert.equal(isGatewayProcessLaunch({ command: "x", argv: ["node", "cli.js", "gateway"] }), true);
  assert.equal(isGatewayProcessLaunch({ command: "node cli.js gateway" }), true);
  assert.equal(
    isGatewayProcessLaunch({ command: "node alpha.mjs", argv: ["node", "alpha.mjs"] }),
    false,
  );
  assert.equal(isGatewayProcessLaunch({ command: "my-tool --flag gateway-server" }), false);
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
