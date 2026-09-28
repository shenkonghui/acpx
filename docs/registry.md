---
title: Registry
description: Install ACP servers from the official ACP agent registry — discover agents, install them into the acpx config, and run them like any built-in.
---

# Registry

`acpx registry` installs ACP servers from the official ACP agent registry
(`https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`).
Installed agents are written into the global acpx config, so every existing
command — prompts, `exec`, `sessions`, `compare`, `gateway` — works with them
without a separate launch path.

## Usage

```bash
acpx registry list [--format text|json|quiet]
acpx registry show <agent-id> [--format text|json|quiet]
acpx registry install <agent-id> [--method binary|npx|uvx] [--as <name>] [--force] [--format text|json|quiet]
acpx registry uninstall <name> [--format text|json|quiet]
```

- `list` prints every registry agent with its id, version, and available
  distribution methods.
- `show` prints one agent's metadata plus the distributions available for the
  current platform.
- `install` downloads or records the agent and registers it in the global
  config (`~/.acpx/config.json`).
- `uninstall` removes the config entry and deletes the install directory.

Every subcommand accepts the standard global `--format` values (`text`, `json`,
`quiet`). `json` prints a single structured document on stdout and suppresses
progress chatter; `quiet` prints only the essential identifier.

`ACPX_REGISTRY_URL` overrides the registry URL, which is useful for mirrors and
tests.

## Distribution methods

A registry agent advertises one or more distributions. `install` picks the first
available method in this order, unless `--method` forces one:

1. `binary` — a per-platform archive pinned by `sha256`.
2. `npx` — an npm package launched with `npx`.
3. `uvx` — a Python package launched with `uvx`.

The platform is derived from the host OS and architecture (for example
`linux-x86_64` or `darwin-aarch64`). If an agent has no distribution for the
current platform, `install` fails and lists the platforms the agent supports.

### Binary installs

Binary installs download the archive, verify its `sha256`, extract it, and place
the resulting tree under `~/.acpx/agents/<agent-id>/<version>/`. The registry
`cmd` (for example `./agent-acp`) is resolved inside that directory and becomes
the executable in the config entry.

Extraction uses the system `tar` for `.tar`-family archives and `zip` archives;
plain single-file downloads are written as-is. When a `sha256` is published it
must match — a mismatch aborts the install rather than running unverified bytes.
Reinstalling an already-installed version reuses the existing directory; pass
`--force` to re-download.

### `npx` and `uvx` installs

These methods write no files to disk. `install` records a config entry that
launches the package on demand. `uvx` must already be on `PATH`; `install` fails
with guidance if it is missing.

## Registration and naming

The registered name defaults to the registry `agent-id`. If that name collides
with a built-in agent, `install` warns and the config entry replaces the
built-in for that name — use `--as <name>` to register under a different name.

After installation:

```bash
acpx <name> sessions new
acpx <name> 'do the work'
```

## Agent environment

Some registry agents require environment variables to speak ACP. When a
distribution declares `env`, `install` writes it into the config entry's `env`
map:

```json
{
  "agents": {
    "example-agent": {
      "argv": ["/home/me/.acpx/agents/example-agent/1.0.0/agent-acp"],
      "env": { "EXAMPLE_ACP_ENABLED": "1" }
    }
  }
}
```

acpx merges this `env` on top of the inherited environment when spawning the
agent. Changing an agent's `env` takes effect on new sessions; restart a warm
queue owner to pick it up.

## Uninstall

```bash
acpx registry uninstall <name>
```

`uninstall` removes the config entry and deletes `~/.acpx/agents/<agent-id>/`.
Reinstalling restores it.

## Limitations

- `install` is the only step that touches the network; after a binary install the
  agent launches offline.
- There is no `registry update` command — reinstall to pick up a new version.
- Installs always target the global config; there is no project-scoped registry
  install.
- Archives are extracted with the host `tar`/`unzip`; environments without either
  fail with a message suggesting `--method npx`.

## See also

- [Custom agents](custom-agents.md) — the config `agents` map and raw commands.
- [Config](config.md) — `agents.<name>.argv` and `agents.<name>.env`.
- [CLI reference](CLI.md#registry-subcommand) — full command grammar.
