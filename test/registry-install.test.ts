import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { AcpxOperationalError } from "../src/errors.js";
import { installRegistryAgent, uninstallRegistryAgent } from "../src/registry/install.js";
import { loadAcpRegistry } from "../src/registry/registry-client.js";
import {
  findRegistryAgent,
  type RegistryAgent,
  type RegistryBinaryPlatform,
} from "../src/registry/types.js";

// The JSON fixture is not emitted into dist-test by tsc, so read it from the
// source tree; the test runner always runs with the repo root as cwd.
const FIXTURE_PATH = path.resolve("test", "fixtures", "registry", "registry.json");
const FIXTURE_URL = "https://registry.acp.test/registry.json";
const execFileAsync = promisify(execFile);

type ResponseShape = {
  status?: number;
  body?: string | Uint8Array;
};

function mockFetch(responses: Record<string, ResponseShape>, log?: (url: string) => void) {
  return async (url: string | URL | Request): Promise<Response> => {
    const target = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    log?.(target);
    const response = responses[target];
    if (!response) {
      return new Response("not found", { status: 404, statusText: "Not Found" });
    }
    const raw = response.body;
    const body = typeof raw === "string" || raw === undefined ? (raw ?? "") : new Uint8Array(raw);
    return new Response(body, { status: response.status ?? 200 });
  };
}

async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-registry-home-"));
  try {
    await run(homeDir);
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

async function buildTarGz(files: Record<string, string>): Promise<Buffer> {
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-archive-src-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const target = path.join(staging, name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, { mode: 0o644 });
    }
    const archivePath = path.join(staging, "archive.tar.gz");
    await execFileAsync("tar", ["czf", archivePath, "-C", staging, ...Object.keys(files)]);
    return await fs.readFile(archivePath);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

const HELLO_SCRIPT = "#!/bin/sh\necho hello-agent\n";

function registryAgentFixture(overrides?: {
  distribution?: RegistryAgent["distribution"];
  version?: string;
  id?: string;
}): RegistryAgent {
  return {
    id: overrides?.id ?? "hello-agent",
    name: "Hello Agent",
    version: overrides?.version ?? "1.2.3",
    description: "A fixture agent",
    distribution: overrides?.distribution ?? {
      binary: {
        "linux-x86_64": {
          archive: "https://archives.acp.test/hello-agent-1.2.3-linux-x86_64.tar.gz",
          cmd: "./hello-agent",
          sha256: "placeholder",
        },
      },
      npx: { package: "@acp.test/hello-agent", args: ["--stdio"] },
      uvx: { package: "hello-agent-acp==1.2.3", env: { HELLO_AGENT_MODE: "acp" } },
    },
  };
}

function sha256(data: Uint8Array | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function linuxBinary(agent: RegistryAgent): RegistryBinaryPlatform {
  const entry = agent.distribution.binary?.["linux-x86_64"];
  assert.ok(entry, "fixture must declare a linux-x86_64 binary");
  return entry;
}

type ConfigFileShape = { agents?: Record<string, { argv?: string[] }> };

function readConfigArgv(config: ConfigFileShape, name: string): string[] {
  const argv = config.agents?.[name]?.argv;
  assert.ok(argv, `expected config agents.${name}.argv`);
  return argv;
}

async function withBinaryFixture(
  run: (params: { agent: RegistryAgent; archive: Buffer; archiveUrl: string }) => Promise<void>,
): Promise<void> {
  const archive = await buildTarGz({ "hello-agent": HELLO_SCRIPT, "docs/README.md": "docs" });
  const agent = registryAgentFixture();
  linuxBinary(agent).sha256 = sha256(archive);
  await run({
    agent,
    archive,
    archiveUrl: linuxBinary(agent).archive,
  });
}

test("registry-client rejects invalid JSON payloads", async () => {
  await assert.rejects(
    loadAcpRegistry({
      url: FIXTURE_URL,
      fetchImpl: mockFetch({ [FIXTURE_URL]: { body: "{oops" } }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof AcpxOperationalError);
      assert.equal(error.detailCode, "REGISTRY_INVALID_JSON");
      return true;
    },
  );
});

test("registry-client reports HTTP failures as retryable fetch errors", async () => {
  await assert.rejects(
    loadAcpRegistry({
      url: FIXTURE_URL,
      fetchImpl: mockFetch({ [FIXTURE_URL]: { status: 503, body: "unavailable" } }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof AcpxOperationalError);
      assert.equal(error.detailCode, "REGISTRY_FETCH_FAILED");
      assert.equal(error.retryable, true);
      return true;
    },
  );
});

test("registry-client rejects payloads that do not match the registry shape", async () => {
  await assert.rejects(
    loadAcpRegistry({
      url: FIXTURE_URL,
      fetchImpl: mockFetch({ [FIXTURE_URL]: { body: JSON.stringify({ agents: 42 }) } }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof AcpxOperationalError);
      assert.equal(error.detailCode, "REGISTRY_INVALID_SHAPE");
      return true;
    },
  );
});

test("registry-client parses payloads with unknown fields", async () => {
  const registry = await loadAcpRegistry({
    url: FIXTURE_URL,
    fetchImpl: mockFetch({
      [FIXTURE_URL]: {
        body: JSON.stringify({
          version: "1.0.0",
          extensions: [{ future: true }],
          agents: [
            {
              id: "hello-agent",
              name: "Hello",
              version: "0.0.1",
              unknownTopLevel: "ignored",
              distribution: { npx: { package: "@scope/pkg", extra: "ignored" } },
            },
          ],
        }),
      },
    }),
  });
  assert.equal(registry.agents.length, 1);
  assert.equal(registry.agents[0]?.distribution.npx?.package, "@scope/pkg");
});

test("registry-client honors ACPX_REGISTRY_URL override", async () => {
  const previous = process.env.ACPX_REGISTRY_URL;
  process.env.ACPX_REGISTRY_URL = FIXTURE_URL;
  try {
    const registry = await loadAcpRegistry({
      fetchImpl: mockFetch({ [FIXTURE_URL]: { body: JSON.stringify({ agents: [] }) } }),
    });
    assert.deepEqual(registry.agents, []);
  } finally {
    if (previous === undefined) {
      delete process.env.ACPX_REGISTRY_URL;
    } else {
      process.env.ACPX_REGISTRY_URL = previous;
    }
  }
});

test("install binary downloads, verifies, extracts and writes config argv", async () => {
  await withTempHome(async (homeDir) => {
    await withBinaryFixture(async ({ agent, archive, archiveUrl }) => {
      const result = await installRegistryAgent(agent, {
        homeDir,
        platform: "linux",
        arch: "x64",
        fetchImpl: mockFetch({ [archiveUrl]: { body: archive } }),
      });

      assert.equal(result.method, "binary");
      assert.equal(result.reused, false);
      assert.equal(result.registeredName, "hello-agent");

      const config = JSON.parse(
        await fs.readFile(path.join(homeDir, ".acpx", "config.json"), "utf8"),
      ) as { agents?: Record<string, { argv?: string[] }> };
      const entry = config.agents?.["hello-agent"];
      const binaryPath = entry?.argv?.[0];
      assert.ok(binaryPath);
      assert.equal(path.basename(binaryPath), "hello-agent");
      assert.ok(
        binaryPath.startsWith(path.join(homeDir, ".acpx", "agents", "hello-agent", "1.2.3")),
        binaryPath,
      );
      assert.equal(await fs.readFile(binaryPath, "utf8"), HELLO_SCRIPT);

      const stat = await fs.stat(binaryPath);
      assert.ok(stat.mode & 0o111, "installed binary should be executable");
    });
  });
});

test("install binary rejects checksum mismatch and leaves no residue", async () => {
  await withTempHome(async (homeDir) => {
    await withBinaryFixture(async ({ agent, archive, archiveUrl }) => {
      linuxBinary(agent).sha256 = "deadbeef".repeat(8);
      await assert.rejects(
        installRegistryAgent(agent, {
          homeDir,
          platform: "linux",
          arch: "x64",
          fetchImpl: mockFetch({ [archiveUrl]: { body: archive } }),
        }),
        (error: unknown) => {
          assert.ok(error instanceof AcpxOperationalError);
          assert.equal(error.detailCode, "REGISTRY_CHECKSUM_MISMATCH");
          return true;
        },
      );
      await assert.rejects(fs.access(path.join(homeDir, ".acpx", "config.json")), {
        code: "ENOENT",
      });
      const agentsRoot = path.join(homeDir, ".acpx", "agents");
      assert.deepEqual(await fs.readdir(agentsRoot).catch(() => []), []);
    });
  });
});

test("install binary rejects cmd escaping the extract directory", async () => {
  await withTempHome(async (homeDir) => {
    await withBinaryFixture(async ({ agent, archive, archiveUrl }) => {
      linuxBinary(agent).cmd = "../../outside";
      await assert.rejects(
        installRegistryAgent(agent, {
          homeDir,
          platform: "linux",
          arch: "x64",
          fetchImpl: mockFetch({ [archiveUrl]: { body: archive } }),
        }),
        (error: unknown) => {
          assert.ok(error instanceof AcpxOperationalError);
          assert.equal(error.detailCode, "REGISTRY_CMD_UNSAFE");
          return true;
        },
      );
    });
  });
});

test("install binary rejects absolute cmd paths", async () => {
  await withTempHome(async (homeDir) => {
    await withBinaryFixture(async ({ agent }) => {
      linuxBinary(agent).cmd = "/bin/sh";
      await assert.rejects(
        installRegistryAgent(agent, {
          homeDir,
          platform: "linux",
          arch: "x64",
          fetchImpl: mockFetch({}),
        }),
        (error: unknown) => {
          assert.ok(error instanceof AcpxOperationalError);
          assert.equal(error.detailCode, "REGISTRY_CMD_UNSAFE");
          return true;
        },
      );
    });
  });
});

test("install binary reports a missing archive command", async () => {
  await withTempHome(async (homeDir) => {
    const archive = await buildTarGz({ "other-file": HELLO_SCRIPT });
    const agent = registryAgentFixture();
    linuxBinary(agent).sha256 = sha256(archive);
    await assert.rejects(
      installRegistryAgent(agent, {
        homeDir,
        platform: "linux",
        arch: "x64",
        fetchImpl: mockFetch({
          [linuxBinary(agent).archive]: { body: archive },
        }),
      }),
      (error: unknown) => {
        assert.ok(error instanceof AcpxOperationalError);
        assert.equal(error.detailCode, "REGISTRY_ARCHIVE_LAYOUT_UNEXPECTED");
        return true;
      },
    );
  });
});

test("install reuses an existing version and --force re-downloads", async () => {
  await withTempHome(async (homeDir) => {
    await withBinaryFixture(async ({ agent, archive, archiveUrl }) => {
      const fetchCalls: string[] = [];
      const fetchImpl = mockFetch({ [archiveUrl]: { body: archive } }, (url) => {
        fetchCalls.push(url);
      });
      const options = {
        homeDir,
        platform: "linux" as const,
        arch: "x64",
        fetchImpl,
      };
      await installRegistryAgent(agent, options);
      assert.equal(fetchCalls.length, 1);

      const second = await installRegistryAgent(agent, options);
      assert.equal(second.reused, true);
      assert.equal(fetchCalls.length, 1);

      const forced = await installRegistryAgent(agent, { ...options, force: true });
      assert.equal(forced.reused, false);
      assert.equal(fetchCalls.length, 2);
    });
  });
});

test("install method selection defaults to binary then npx then uvx", async () => {
  await withTempHome(async (homeDir) => {
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-runner-bin-"));
    await fs.writeFile(path.join(binDir, "uvx"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    try {
      await withBinaryFixture(async ({ agent, archive, archiveUrl }) => {
        await withPrependedPath(binDir, async () => {
          const cases: Array<{ agent: RegistryAgent; expected: string }> = [
            { agent, expected: "binary" },
            {
              agent: registryAgentFixture({
                distribution: {
                  npx: { package: "@acp.test/hello" },
                  uvx: { package: "hello-acp" },
                },
              }),
              expected: "npx",
            },
            {
              agent: registryAgentFixture({ distribution: { uvx: { package: "hello-acp" } } }),
              expected: "uvx",
            },
          ];
          for (const { agent: candidate, expected } of cases) {
            const result = await installRegistryAgent(candidate, {
              homeDir,
              platform: "linux",
              arch: "x64",
              fetchImpl: mockFetch({ [archiveUrl]: { body: archive } }),
            });
            assert.equal(result.method, expected);
          }
        });
      });
    } finally {
      await fs.rm(binDir, { recursive: true, force: true });
    }
  });
});

test("install --method npx writes npx argv without env when absent", async () => {
  await withTempHome(async (homeDir) => {
    const agent = registryAgentFixture();
    const result = await installRegistryAgent(agent, {
      homeDir,
      method: "npx",
      platform: "linux",
      arch: "x64",
      fetchImpl: mockFetch({}),
    });
    assert.deepEqual(result.argv, ["npx", "-y", "@acp.test/hello-agent", "--stdio"]);
    assert.equal(result.env, undefined);
    assert.equal(result.installDir, undefined);

    const config = JSON.parse(
      await fs.readFile(path.join(homeDir, ".acpx", "config.json"), "utf8"),
    ) as { agents?: Record<string, unknown> };
    assert.deepEqual(config.agents?.["hello-agent"], {
      argv: ["npx", "-y", "@acp.test/hello-agent", "--stdio"],
    });
  });
});

test("install --method requires npx on PATH", async () => {
  await withTempHome(async (homeDir) => {
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-empty-bin-"));
    await withIsolatedPath(emptyDir, async () => {
      await assert.rejects(
        installRegistryAgent(registryAgentFixture(), {
          homeDir,
          method: "npx",
          platform: "linux",
          arch: "x64",
          fetchImpl: mockFetch({}),
        }),
        (error: unknown) => {
          assert.ok(error instanceof AcpxOperationalError);
          assert.equal(error.detailCode, "REGISTRY_RUNNER_MISSING");
          assert.match(error.message, /npx/);
          return true;
        },
      );
    });
    await fs.rm(emptyDir, { recursive: true, force: true });
  });
});

test("install --method uvx writes argv and env when uvx is on PATH", async () => {
  await withTempHome(async (homeDir) => {
    const uvxDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-uvx-bin-"));
    await fs.writeFile(path.join(uvxDir, "uvx"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await withIsolatedPath(uvxDir, async () => {
      const result = await installRegistryAgent(registryAgentFixture(), {
        homeDir,
        method: "uvx",
        platform: "linux",
        arch: "x64",
        fetchImpl: mockFetch({}),
      });
      assert.deepEqual(result.argv, ["uvx", "hello-agent-acp==1.2.3"]);
      assert.deepEqual(result.env, { HELLO_AGENT_MODE: "acp" });

      const config = JSON.parse(
        await fs.readFile(path.join(homeDir, ".acpx", "config.json"), "utf8"),
      ) as { agents?: Record<string, { argv?: string[]; env?: Record<string, string> }> };
      assert.deepEqual(config.agents?.["hello-agent"], {
        argv: ["uvx", "hello-agent-acp==1.2.3"],
        env: { HELLO_AGENT_MODE: "acp" },
      });
    });
    await fs.rm(uvxDir, { recursive: true, force: true });
  });
});

test("install --method uvx fails with an actionable error when uvx is missing", async () => {
  await withTempHome(async (homeDir) => {
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-empty-bin-"));
    await withIsolatedPath(emptyDir, async () => {
      await assert.rejects(
        installRegistryAgent(registryAgentFixture(), {
          homeDir,
          method: "uvx",
          platform: "linux",
          arch: "x64",
          fetchImpl: mockFetch({}),
        }),
        (error: unknown) => {
          assert.ok(error instanceof AcpxOperationalError);
          assert.equal(error.detailCode, "REGISTRY_RUNNER_MISSING");
          assert.match(error.message, /install uv|fix PATH/);
          return true;
        },
      );
    });
    await fs.rm(emptyDir, { recursive: true, force: true });
  });
});

test("install rejects unavailable distributions with the supported platform list", async () => {
  await withTempHome(async (homeDir) => {
    const agent = registryAgentFixture({
      distribution: {
        binary: { "darwin-aarch64": { archive: "https://archives.acp.test/a", cmd: "./a" } },
      },
    });
    await assert.rejects(
      installRegistryAgent(agent, {
        homeDir,
        platform: "linux",
        arch: "x64",
        fetchImpl: mockFetch({}),
      }),
      (error: unknown) => {
        assert.ok(error instanceof AcpxOperationalError);
        assert.equal(error.detailCode, "REGISTRY_DISTRIBUTION_UNAVAILABLE");
        assert.match(error.message, /darwin-aarch64/);
        return true;
      },
    );
  });
});

test("install rejects unsupported platforms", async () => {
  await withTempHome(async (homeDir) => {
    await assert.rejects(
      installRegistryAgent(registryAgentFixture(), {
        homeDir,
        platform: "freebsd",
        arch: "x64",
        fetchImpl: mockFetch({}),
      }),
      (error: unknown) => {
        assert.ok(error instanceof AcpxOperationalError);
        assert.equal(error.detailCode, "REGISTRY_PLATFORM_UNSUPPORTED");
        return true;
      },
    );
  });
});

test("install rejects unsafe agent names and versions", async () => {
  await withTempHome(async (homeDir) => {
    await assert.rejects(
      installRegistryAgent(registryAgentFixture({ id: "../escape" }), {
        homeDir,
        method: "npx",
        platform: "linux",
        arch: "x64",
        fetchImpl: mockFetch({}),
      }),
      (error: unknown) => {
        assert.ok(error instanceof AcpxOperationalError);
        assert.equal(error.detailCode, "REGISTRY_INVALID_NAME");
        return true;
      },
    );
    await assert.rejects(
      installRegistryAgent(registryAgentFixture({ version: "1/../../2" }), {
        homeDir,
        platform: "linux",
        arch: "x64",
        fetchImpl: mockFetch({}),
      }),
      (error: unknown) => {
        assert.ok(error instanceof AcpxOperationalError);
        assert.equal(error.detailCode, "REGISTRY_UNSAFE_IDENTITY");
        return true;
      },
    );
  });
});

test("install --as renames the registration and warns about built-in conflicts", async () => {
  await withTempHome(async (homeDir) => {
    const agent = registryAgentFixture({ id: "opencode" });
    const options = {
      homeDir,
      method: "npx" as const,
      platform: "linux" as const,
      arch: "x64",
      fetchImpl: mockFetch({}),
    };
    const renamed = await installRegistryAgent(agent, { ...options, asName: "my-opencode" });
    assert.equal(renamed.registeredName, "my-opencode");
    assert.equal(
      renamed.warnings.some((warning) => warning.includes("built-in opencode")),
      false,
    );

    const builtin = await installRegistryAgent(agent, options);
    assert.equal(builtin.registeredName, "opencode");
    assert.ok(
      builtin.warnings.some((warning) => warning.includes("built-in opencode")),
      `expected built-in warning, got: ${builtin.warnings.join("; ")}`,
    );

    const config = JSON.parse(
      await fs.readFile(path.join(homeDir, ".acpx", "config.json"), "utf8"),
    ) as { agents?: Record<string, unknown> };
    assert.ok(config.agents?.["my-opencode"]);
    assert.ok(config.agents?.opencode);
  });
});

test("install warns when replacing an existing config entry", async () => {
  await withTempHome(async (homeDir) => {
    const agent = registryAgentFixture();
    const options = {
      homeDir,
      method: "npx" as const,
      platform: "linux" as const,
      arch: "x64",
      fetchImpl: mockFetch({}),
    };
    await installRegistryAgent(agent, options);
    const second = await installRegistryAgent(agent, options);
    assert.equal(second.replacedConfigEntry, true);
    assert.ok(second.warnings.some((warning) => warning.includes("replacing existing")));
  });
});

test("install warns when the registry entry has no sha256", async () => {
  await withTempHome(async (homeDir) => {
    await withBinaryFixture(async ({ agent, archive, archiveUrl }) => {
      delete linuxBinary(agent).sha256;
      const result = await installRegistryAgent(agent, {
        homeDir,
        platform: "linux",
        arch: "x64",
        fetchImpl: mockFetch({ [archiveUrl]: { body: archive } }),
      });
      assert.ok(result.warnings.some((warning) => warning.includes("no sha256")));
    });
  });
});

test("install of a new version lands in a fresh directory and updates config", async () => {
  await withTempHome(async (homeDir) => {
    await withBinaryFixture(async ({ agent, archive, archiveUrl }) => {
      const fetchImpl = mockFetch({ [archiveUrl]: { body: archive } });
      const options = {
        homeDir,
        platform: "linux" as const,
        arch: "x64",
        fetchImpl,
      };
      await installRegistryAgent(agent, options);

      const upgraded = registryAgentFixture({ version: "2.0.0" });
      linuxBinary(upgraded).archive =
        "https://archives.acp.test/hello-agent-2.0.0-linux-x86_64.tar.gz";
      linuxBinary(upgraded).sha256 = sha256(archive);
      const result = await installRegistryAgent(upgraded, {
        ...options,
        fetchImpl: mockFetch({
          [archiveUrl]: { body: archive },
          [linuxBinary(upgraded).archive]: { body: archive },
        }),
      });

      assert.ok(result.installDir?.endsWith(path.join("hello-agent", "2.0.0")));
      assert.equal(
        await fs.readFile(path.join(result.installDir!, "hello-agent"), "utf8"),
        HELLO_SCRIPT,
      );
      const config = JSON.parse(
        await fs.readFile(path.join(homeDir, ".acpx", "config.json"), "utf8"),
      ) as { agents?: Record<string, { argv?: string[] }> };
      assert.ok(readConfigArgv(config, "hello-agent")[0].includes("2.0.0"));
      assert.ok(
        await fs
          .access(path.join(homeDir, ".acpx", "agents", "hello-agent", "1.2.3", "hello-agent"))
          .then(() => true)
          .catch(() => false),
        "previous version directory should remain",
      );
    });
  });
});

test("install binary handles raw single-file archives", async () => {
  await withTempHome(async (homeDir) => {
    const rawArchive = Buffer.from(HELLO_SCRIPT, "utf8");
    const agent = registryAgentFixture();
    const entry = linuxBinary(agent);
    entry.archive = "https://archives.acp.test/hello-agent-1.2.3-x86_64";
    entry.cmd = "./hello-agent-1.2.3-x86_64";
    entry.sha256 = sha256(rawArchive);

    const result = await installRegistryAgent(agent, {
      homeDir,
      platform: "linux",
      arch: "x64",
      fetchImpl: mockFetch({ [entry.archive]: { body: rawArchive } }),
    });
    assert.equal(result.method, "binary");

    const config = JSON.parse(
      await fs.readFile(path.join(homeDir, ".acpx", "config.json"), "utf8"),
    ) as { agents?: Record<string, { argv?: string[] }> };
    const binaryPath = readConfigArgv(config, "hello-agent")[0];
    assert.equal(path.basename(binaryPath), "hello-agent-1.2.3-x86_64");
    assert.equal(await fs.readFile(binaryPath, "utf8"), HELLO_SCRIPT);
    const stat = await fs.stat(binaryPath);
    assert.ok(stat.mode & 0o111);
  });
});

test(
  "install binary handles zip archives via tar",
  { skip: process.platform === "win32" },
  async () => {
    await withTempHome(async (homeDir) => {
      const staging = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-zip-src-"));
      try {
        await fs.writeFile(path.join(staging, "hello-agent"), HELLO_SCRIPT, { mode: 0o644 });
        const zipPath = path.join(staging, "archive.zip");
        if (process.platform === "darwin") {
          await execFileAsync("zip", ["-q", "-r", zipPath, "hello-agent"], { cwd: staging });
        } else {
          await execFileAsync("tar", ["acf", zipPath, "-C", staging, "hello-agent"]);
        }
        const archive = await fs.readFile(zipPath);
        const agent = registryAgentFixture();
        const entry = linuxBinary(agent);
        entry.archive = "https://archives.acp.test/hello-agent-1.2.3.zip";
        entry.sha256 = sha256(archive);

        const result = await installRegistryAgent(agent, {
          homeDir,
          platform: "linux",
          arch: "x64",
          fetchImpl: mockFetch({ [entry.archive]: { body: archive } }),
        });
        assert.equal(result.method, "binary");
        const config = JSON.parse(
          await fs.readFile(path.join(homeDir, ".acpx", "config.json"), "utf8"),
        ) as { agents?: Record<string, { argv?: string[] }> };
        assert.equal(path.basename(readConfigArgv(config, "hello-agent")[0]), "hello-agent");
      } finally {
        await fs.rm(staging, { recursive: true, force: true });
      }
    });
  },
);

test("uninstall removes the config entry and install tree", async () => {
  await withTempHome(async (homeDir) => {
    await withBinaryFixture(async ({ agent, archive, archiveUrl }) => {
      await installRegistryAgent(agent, {
        homeDir,
        platform: "linux",
        arch: "x64",
        fetchImpl: mockFetch({ [archiveUrl]: { body: archive } }),
      });
      const agentDir = path.join(homeDir, ".acpx", "agents", "hello-agent");
      const versions = await fs.readdir(agentDir);
      assert.ok(versions.includes("1.2.3"));

      const result = await uninstallRegistryAgent("hello-agent", { homeDir });
      assert.equal(result.registeredName, "hello-agent");
      assert.equal(result.removedConfigEntry, true);
      assert.equal(result.removedInstallDir, agentDir);
      await assert.rejects(fs.access(agentDir), { code: "ENOENT" });

      const config = JSON.parse(
        await fs.readFile(path.join(homeDir, ".acpx", "config.json"), "utf8"),
      ) as { agents?: Record<string, unknown> };
      assert.equal(config.agents && Object.hasOwn(config.agents, "hello-agent"), false);
    });
  });
});

test("uninstall removes npx installs without an install directory", async () => {
  await withTempHome(async (homeDir) => {
    const agent = registryAgentFixture();
    await installRegistryAgent(agent, {
      homeDir,
      method: "npx",
      platform: "linux",
      arch: "x64",
      fetchImpl: mockFetch({}),
    });
    const result = await uninstallRegistryAgent("hello-agent", { homeDir });
    assert.equal(result.removedConfigEntry, true);
    assert.equal(result.removedInstallDir, undefined);
    await assert.rejects(fs.access(path.join(homeDir, ".acpx", "agents", "hello-agent")), {
      code: "ENOENT",
    });
  });
});

test("uninstall fails for unknown agents", async () => {
  await withTempHome(async (homeDir) => {
    await assert.rejects(uninstallRegistryAgent("nope", { homeDir }), (error: unknown) => {
      assert.ok(error instanceof AcpxOperationalError);
      assert.equal(error.detailCode, "REGISTRY_NOT_INSTALLED");
      return true;
    });
  });
});

test("install preserves unrelated config keys and formatting", async () => {
  await withTempHome(async (homeDir) => {
    const configPath = path.join(homeDir, ".acpx", "config.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        { defaultAgent: "codex", agents: { custom: { command: "custom-cmd" } } },
        null,
        2,
      )}\n`,
    );
    await installRegistryAgent(registryAgentFixture(), {
      homeDir,
      method: "npx",
      platform: "linux",
      arch: "x64",
      fetchImpl: mockFetch({}),
    });
    const raw = await fs.readFile(configPath, "utf8");
    assert.ok(raw.endsWith("}\n"));
    assert.ok(raw.includes('  "agents"'));
    const parsed = JSON.parse(raw) as { defaultAgent?: string; agents?: Record<string, unknown> };
    assert.equal(parsed.defaultAgent, "codex");
    assert.ok(parsed.agents?.custom);
    assert.ok(parsed.agents?.["hello-agent"]);
  });
});

test("fixture registry contains expected agents and distributions", async () => {
  const payload = await fs.readFile(FIXTURE_PATH, "utf8");
  const registry = await loadAcpRegistry({
    url: FIXTURE_URL,
    fetchImpl: mockFetch({ [FIXTURE_URL]: { body: payload } }),
  });
  const ids = new Set(registry.agents.map((agent) => agent.id));
  for (const expected of ["amp-acp", "goose", "sigit", "opencode", "vtcode", "fast-agent"]) {
    assert.ok(ids.has(expected), `fixture missing ${expected}`);
  }
  const sigit = findRegistryAgent(registry, "SIGIT");
  assert.equal(sigit?.distribution.npx?.package, "@smbcloud/sigit@1.5.10");
  const fastAgent = findRegistryAgent(registry, "fast-agent");
  assert.deepEqual(fastAgent?.distribution.uvx?.env, { FAST_AGENT_MODEL: "codexplan" });
  const amp = findRegistryAgent(registry, "amp-acp");
  assert.ok(amp?.distribution.binary?.["linux-x86_64"]?.sha256);
  const vtcode = findRegistryAgent(registry, "vtcode");
  assert.equal(vtcode?.distribution.binary?.["linux-x86_64"]?.sha256, undefined);
});

async function withIsolatedPath(binDir: string, run: () => Promise<void>): Promise<void> {
  const previousPath = process.env.PATH;
  process.env.PATH = binDir;
  try {
    await run();
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
  }
}

async function withPrependedPath(binDir: string, run: () => Promise<void>): Promise<void> {
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
  try {
    await run();
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
  }
}
