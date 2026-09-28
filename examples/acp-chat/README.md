# acpx ACP Chat

A local web page for testing the ACP agents `acpx` already knows about: pick an
agent, send a prompt, watch the turn stream, and cancel it. It talks to the
in-process `AcpxRuntime` through a small HTTP + WebSocket server, so it exercises
the same session, event, and permission code paths as the CLI.

For the behaviour contract and protocol details, see
[docs/2026-09-28-acp-chat-viewer.md](../../docs/2026-09-28-acp-chat-viewer.md).

It is separate from the `acpx` CLI surface on purpose:

- `acpx` resolves and runs agents from the terminal
- this page lists the agents `acpx` is configured for and chats with them
- it stores its sessions under `~/.acpx/acp-chat/`, so it never mixes with
  `acpx sessions`

## Run it

From the repo root:

```bash
pnpm chat
```

Then open [http://127.0.0.1:4174](http://127.0.0.1:4174).

Useful helper commands:

```bash
pnpm chat:open
pnpm chat:status
pnpm chat:stop
```

## Agents it lists

- agents from `~/.acpx/config.json` and `<cwd>/.acpxrc.json` (source `config`)
- agents from an optional `--agents-config <path>` file, using the same JSON
  format as `acpx gateway --config` (source `gateway-config`)
- the built-in adapters from `src/agent-registry.ts` (source `built-in`)
- ad-hoc commands started from the page (source `ad-hoc`)

Each entry is tagged `ready`, `missing` (with the missing command or package),
or `unknown` when an adapter needs a package runner such as `npx` and
availability cannot be decided up front. `missing` agents cannot be selected.

Built-ins are judged by their **real launch command**: if the adapter's binary
(for example `qodercli`, `cursor-agent`, or `gemini`) is on `PATH`, the entry is
`ready` and starts with that argv. Config entries with the same name still win.

## Install from the registry

The **ACP registry** panel lists every agent in the official ACP registry. Pick a
distribution method (`auto`, `binary`, `npx`, or `uvx`), optionally an alias, and
click **Install**. The install writes an `agents.<name>` entry to
`~/.acpx/config.json`, so the agent becomes selectable immediately — no server
restart. Pass `--no-install` to hide the panel and reject installs.

## Custom command

The **Custom command** box runs any command that resolves on `PATH` as a
temporary agent, mirroring the CLI `acpx --agent '<command>'` escape hatch:

```text
codebuddy --acp
node ./scripts/dev-acp.mjs --mode ci
```

The command is registered under a synthetic per-chat agent name and removed when
the chat closes. Ad-hoc sessions are process-local and do not survive a server
restart. Pass `--no-command` to disable it.

## Options

```text
--host <host>                 default 127.0.0.1
--port <port>                 default 4174 (0 picks a free port)
--cwd <dir>                   default working directory for agent sessions
--permission-mode <mode>      approve-all (default) | approve-reads | deny-all
--state-dir <path>            default ~/.acpx/acp-chat
--agents-config <path>        extra agents from an acpx gateway --config JSON file
--no-install                  disable registry installs from the page
--no-command                  disable ad-hoc commands from the page
--verbose                     log chat lifecycle events to stderr
--open                        open the page in a browser after start
```

## Permissions and safety

The page defaults to `--permission-mode approve-all` because it is a loopback
test harness; pass `--approve-reads` or `--deny-all` to tighten it.

Browser HTTP and WebSocket requests must use the server's own origin. The server
accepts its configured host, the local address of the connection, and
`localhost` for loopback connections. Native status, stop, and WebSocket clients
may omit `Origin`. There is no authentication and no interactive permission
prompt in the browser, so keep the default loopback bind.

Registry installs download files and write `~/.acpx/config.json`; ad-hoc commands
execute arbitrary local programs. Both are enabled by default for this local
harness; disable them with `--no-install` / `--no-command`, especially when the
server is bound to a non-loopback host.
