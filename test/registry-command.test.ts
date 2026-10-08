import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const execFileAsync = promisify(execFile);

type CliRunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-registry-cli-home-"));
  try {
    await run(homeDir);
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

async function runCli(
  args: string[],
  homeDir: string,
  env: NodeJS.ProcessEnv = {},
  cwd?: string,
  timeoutMs = 60_000,
): Promise<CliRunResult> {
  return await new Promise<CliRunResult>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: {
        ...process.env,
        HOME: homeDir,
        ...env,
      },
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out after ${timeoutMs}ms: acpx ${args.join(" ")}`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.end();
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function buildAgentArchive(envFile: string): Promise<Buffer> {
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-cli-archive-src-"));
  try {
    const script = [
      "#!/bin/sh",
      `printenv REGISTRY_AGENT_MARKER > ${JSON.stringify(envFile)} 2>/dev/null || true`,
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(MOCK_AGENT_PATH)} "$@"`,
      "",
    ].join("\n");
    await fs.writeFile(path.join(staging, "hello-agent"), script, { mode: 0o755 });
    const archivePath = path.join(staging, "archive.tar.gz");
    await execFileAsync("tar", ["czf", archivePath, "-C", staging, "hello-agent"]);
    return await fs.readFile(archivePath);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

async function startRegistryServer(): Promise<{
  registryUrl: () => string;
  serve: (payload: string, archive: Buffer) => void;
  close: () => Promise<void>;
}> {
  let payload = "";
  let archive: Uint8Array = new Uint8Array(0);
  const server = http.createServer((request, response) => {
    const url = request.url ?? "";
    if (url === "/registry.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(payload);
      return;
    }
    if (url === "/archive.tar.gz") {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(archive);
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    registryUrl: () => `http://127.0.0.1:${port}/registry.json`,
    serve: (nextPayload: string, nextArchive: Uint8Array) => {
      payload = nextPayload;
      archive = nextArchive;
    },
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
  };
}

type RegistryTestContext = {
  homeDir: string;
  cwd: string;
  envFile: string;
  registryUrl: string;
};

async function withRegistryFixture(
  run: (ctx: RegistryTestContext) => Promise<void>,
): Promise<void> {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const envFile = path.join(homeDir, "agent-env.txt");
    const server = await startRegistryServer();
    try {
      const archive = await buildAgentArchive(envFile);
      const registryPayload = JSON.stringify({
        version: "1.0.0",
        agents: [
          {
            id: "hello-agent",
            name: "Hello Agent",
            version: "1.2.3",
            description: "Says hello over ACP",
            distribution: {
              binary: Object.fromEntries(
                [
                  "darwin-aarch64",
                  "darwin-x86_64",
                  "linux-aarch64",
                  "linux-x86_64",
                  "windows-x86_64",
                ].map((platform) => [
                  platform,
                  {
                    archive: `${new URL(".", server.registryUrl()).origin}/archive.tar.gz`,
                    cmd: "./hello-agent",
                    env: { REGISTRY_AGENT_MARKER: "from-registry" },
                    sha256: createHash("sha256").update(archive).digest("hex"),
                  },
                ]),
              ),
              npx: { package: "@acp.test/hello" },
            },
          },
          {
            id: "uvx-only-agent",
            name: "Uvx Only Agent",
            version: "0.1.0",
            distribution: { uvx: { package: "uvx-only-acp==0.1.0" } },
          },
        ],
      });
      server.serve(registryPayload, archive);
      await run({ homeDir, cwd, envFile, registryUrl: server.registryUrl() });
    } finally {
      await server.close();
    }
  });
}

function registryEnv(ctx: RegistryTestContext): NodeJS.ProcessEnv {
  return { ACPX_REGISTRY_URL: ctx.registryUrl };
}

test("registry list renders ids, methods and installability", async () => {
  await withRegistryFixture(async (ctx) => {
    const result = await runCli(["registry", "list"], ctx.homeDir, registryEnv(ctx), ctx.cwd);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /hello-agent\s+1\.2\.3\s+binary\|npx/);
    assert.match(result.stdout, /uvx-only-agent\s+0\.1\.0\s+uvx/);
    assert.match(result.stdout, /Says hello over ACP/);
  });
});

test("registry list --format json emits structured agents", async () => {
  await withRegistryFixture(async (ctx) => {
    const result = await runCli(
      ["--format", "json", "registry", "list"],
      ctx.homeDir,
      registryEnv(ctx),
      ctx.cwd,
    );
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      registryVersion: string;
      agents: Array<{ id: string; methods: string[]; installable: boolean }>;
    };
    const hello = payload.agents.find((agent) => agent.id === "hello-agent");
    assert.deepEqual(hello?.methods, ["binary", "npx"]);
    assert.equal(hello?.installable, true);
    const uvxOnly = payload.agents.find((agent) => agent.id === "uvx-only-agent");
    assert.equal(uvxOnly?.installable, true);
  });
});

test("registry list --format quiet prints ids only", async () => {
  await withRegistryFixture(async (ctx) => {
    const result = await runCli(
      ["registry", "list", "--format", "quiet"],
      ctx.homeDir,
      registryEnv(ctx),
      ctx.cwd,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(
      result.stdout.split("\n").filter((line) => line.length > 0),
      ["hello-agent", "uvx-only-agent"],
    );
  });
});

test("registry show prints metadata and current platform distributions", async () => {
  await withRegistryFixture(async (ctx) => {
    const result = await runCli(
      ["registry", "show", "hello-agent"],
      ctx.homeDir,
      registryEnv(ctx),
      ctx.cwd,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /id:\s+hello-agent/);
    assert.match(result.stdout, /methods:\s+binary, npx/);
    assert.match(result.stdout, /binary command:\s+\.\/hello-agent/);
    assert.match(result.stdout, /binary env:\s+REGISTRY_AGENT_MARKER=from-registry/);
    assert.match(result.stdout, /installable:\s+yes/);
  });
});

test("registry show --format json exposes the distribution payload", async () => {
  await withRegistryFixture(async (ctx) => {
    const result = await runCli(
      ["registry", "show", "uvx-only-agent", "--format", "json"],
      ctx.homeDir,
      registryEnv(ctx),
      ctx.cwd,
    );
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      id: string;
      distributions: { uvx?: { package: string } };
    };
    assert.equal(payload.id, "uvx-only-agent");
    assert.equal(payload.distributions.uvx?.package, "uvx-only-acp==0.1.0");
  });
});

test("registry show rejects unknown agent ids", async () => {
  await withRegistryFixture(async (ctx) => {
    const result = await runCli(
      ["registry", "show", "missing-agent"],
      ctx.homeDir,
      registryEnv(ctx),
      ctx.cwd,
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Registry agent not found: missing-agent/);
  });
});

test(
  "registry install writes config and the agent runs end to end",
  { skip: process.platform === "win32" },
  async () => {
    await withRegistryFixture(async (ctx) => {
      const install = await runCli(
        ["registry", "install", "hello-agent"],
        ctx.homeDir,
        registryEnv(ctx),
        ctx.cwd,
      );
      assert.equal(install.code, 0, install.stderr);
      assert.match(install.stdout, /Installed hello-agent 1\.2\.3 \(binary\)/);
      assert.match(install.stdout, /Usage: acpx hello-agent sessions new/);

      const config = JSON.parse(
        await fs.readFile(path.join(ctx.homeDir, ".acpx", "config.json"), "utf8"),
      ) as { agents?: Record<string, { argv?: string[]; env?: Record<string, string> }> };
      const entry = config.agents?.["hello-agent"];
      assert.ok(entry?.argv?.[0]);
      assert.equal(path.basename(entry.argv[0]), "hello-agent");
      assert.deepEqual(entry.env, { REGISTRY_AGENT_MARKER: "from-registry" });

      const exec = await runCli(
        ["--approve-all", "--format", "quiet", "hello-agent", "exec", "echo registry hello"],
        ctx.homeDir,
        registryEnv(ctx),
        ctx.cwd,
      );
      assert.equal(exec.code, 0, exec.stderr);
      assert.equal(exec.stdout, "registry hello\n");

      assert.equal(await fs.readFile(ctx.envFile, "utf8"), "from-registry\n");
    });
  },
);

test("registry install --format json emits the install result", async () => {
  await withRegistryFixture(async (ctx) => {
    const result = await runCli(
      ["registry", "install", "hello-agent", "--format", "json"],
      ctx.homeDir,
      registryEnv(ctx),
      ctx.cwd,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    const payload = JSON.parse(result.stdout) as {
      agentId: string;
      registeredName: string;
      version: string;
      method: string;
      argv: string[];
      env?: Record<string, string>;
      installDir?: string;
      reused: boolean;
    };
    assert.equal(payload.agentId, "hello-agent");
    assert.equal(payload.method, "binary");
    assert.equal(payload.version, "1.2.3");
    assert.equal(path.basename(payload.argv[0] ?? ""), "hello-agent");
    assert.deepEqual(payload.env, { REGISTRY_AGENT_MARKER: "from-registry" });
    assert.ok(payload.installDir);
    assert.ok(await fs.stat(payload.installDir));
  });
});

test(
  "registry install --as registers an alias that runs",
  { skip: process.platform === "win32" },
  async () => {
    await withRegistryFixture(async (ctx) => {
      const install = await runCli(
        ["registry", "install", "hello-agent", "--as", "my-hello"],
        ctx.homeDir,
        registryEnv(ctx),
        ctx.cwd,
      );
      assert.equal(install.code, 0, install.stderr);
      assert.match(install.stdout, /Installed hello-agent 1\.2\.3 \(binary\) as "my-hello"/);

      const exec = await runCli(
        ["--approve-all", "--format", "quiet", "my-hello", "exec", "echo alias hello"],
        ctx.homeDir,
        registryEnv(ctx),
        ctx.cwd,
      );
      assert.equal(exec.code, 0, exec.stderr);
      assert.equal(exec.stdout, "alias hello\n");
    });
  },
);

test("registry uninstall removes the config entry and install tree", async () => {
  await withRegistryFixture(async (ctx) => {
    const install = await runCli(
      ["registry", "install", "hello-agent"],
      ctx.homeDir,
      registryEnv(ctx),
      ctx.cwd,
    );
    assert.equal(install.code, 0, install.stderr);

    const uninstall = await runCli(
      ["registry", "uninstall", "hello-agent"],
      ctx.homeDir,
      registryEnv(ctx),
      ctx.cwd,
    );
    assert.equal(uninstall.code, 0, uninstall.stderr);
    assert.match(uninstall.stdout, /Removed registry agent "hello-agent"/);
    assert.match(uninstall.stdout, /removed config entry/);
    assert.match(uninstall.stdout, /removed install dir:/);

    const config = JSON.parse(
      await fs.readFile(path.join(ctx.homeDir, ".acpx", "config.json"), "utf8"),
    ) as { agents?: Record<string, unknown> };
    assert.equal(config.agents && Object.hasOwn(config.agents, "hello-agent"), false);
    await assert.rejects(fs.access(path.join(ctx.homeDir, ".acpx", "agents", "hello-agent")), {
      code: "ENOENT",
    });

    const missing = await runCli(
      ["registry", "uninstall", "hello-agent"],
      ctx.homeDir,
      registryEnv(ctx),
      ctx.cwd,
    );
    assert.notEqual(missing.code, 0);
    assert.match(missing.stderr, /No registry install found/);
  });
});

test("registry without a subcommand fails with guidance", async () => {
  await withRegistryFixture(async (ctx) => {
    const result = await runCli(["registry"], ctx.homeDir, registryEnv(ctx), ctx.cwd);
    assert.notEqual(result.code, 0);
    assert.match(`${result.stdout}${result.stderr}`, /A registry subcommand is required/);
  });
});

test("registry install rejects invalid method values", async () => {
  await withRegistryFixture(async (ctx) => {
    const result = await runCli(
      ["registry", "install", "hello-agent", "--method", "pip"],
      ctx.homeDir,
      registryEnv(ctx),
      ctx.cwd,
    );
    assert.notEqual(result.code, 0);
    assert.match(`${result.stdout}${result.stderr}`, /Invalid method "pip"/);
  });
});
