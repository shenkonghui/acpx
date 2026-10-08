# ACP Chat Viewer

This document specifies the local web chat page for testing ACP agents that
`acpx` already knows about.

It covers:

- agent discovery (which agents appear)
- the settings page that edits `~/.acpx/config.json`
- the HTTP and WebSocket protocol between the page and the server
- session identity and lifetime
- multiple concurrent sessions and per-session model selection
- permission behaviour
- local-only security posture

The page lives in `examples/acp-chat/` and is not part of the published npm
package. It reuses the in-process `AcpxRuntime` (`acpx/runtime`) instead of
re-implementing ACP.

## Purpose

`acpx` can already talk to agents from the terminal. This page answers a
different question: "is this configured ACP server actually reachable and
does it answer a prompt?" It renders the agent list, streams a turn
token-by-token, surfaces tool calls, and lets you cancel a turn.

It is a test harness, not an end-user chat product:

- loopback only, single user, no authentication
- state lives in a dedicated `~/.acpx/acp-chat` state directory
- sessions are not shared with CLI sessions

## Agent discovery

`GET /api/agents` returns every agent the server resolved, with three sources:

| Source           | Origin                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| `config`         | `agents` in `~/.acpx/config.json` and `<cwd>/.acpxrc.json`                                        |
| `gateway-config` | the optional `--agents-config <path>` file, parsed with the same rules as `acpx gateway --config` |
| `built-in`       | the built-in adapter registry in `src/agent-registry.ts`                                          |
| `ad-hoc`         | commands started from the page's custom-command box (in-memory, per chat)                         |

Precedence on a name collision (case-insensitive) is `config` >
`gateway-config` > `built-in`. The key is the `_meta.acpx.agent` value the
runtime uses for routing.

Built-ins are inspected through their real launch definition, not an id-named
command: if the adapter's binary (`qodercli`, `cursor-agent`, `gemini`, …) is on
`PATH`, the entry reports `installed` and launches with that argv.

Each entry reports availability:

- `installed` — the launch command or package resolves on this machine
- `missing` — nothing resolves; the entry lists the missing commands/packages
- `unknown` — the adapter needs a package runner (`npx`, `uvx`) so
  availability cannot be decided ahead of a run

`missing` agents are rendered but cannot be selected.

An agent can be switched off without deleting it by setting `enabled: false`
on its config entry (the settings page does this for you). Disabled agents are
omitted from `/api/agents` and cannot be selected or resolved by the CLI; the
settings page still lists them so they can be re-enabled. Precedence for the
flag follows the launch definition: a project entry's `enabled` overrides the
global entry's, and either overrides the default (`true`).

## Transport

The server is a single `node:http` listener that embeds Vite in middleware mode
for the page, handles `/api/*` itself, and upgrades `/api/chat` to a WebSocket.
Requests and upgrades must come from the server's own origin; anything else gets
`403` (see `server/request-origin.ts`).

### HTTP

| Method | Path                          | Purpose                                                                           |
| ------ | ----------------------------- | --------------------------------------------------------------------------------- |
| `GET`  | `/api/health`                 | service identity (`acpx-acp-chat`), `cwd`, permissions, state dir, `capabilities` |
| `GET`  | `/api/agents`                 | agent catalog (rebuilt per request, so installs appear live)                      |
| `GET`  | `/api/registry`               | agents available in the official ACP registry plus install status                 |
| `POST` | `/api/registry/install`       | install a registry agent (`{ id, method?, asName?, force? }`)                     |
| `GET`  | `/api/settings`               | settings rows for every known agent (including disabled ones)                     |
| `POST` | `/api/settings/agents`        | upsert one agent (`{ name, enabled?, argv?, env? }`)                              |
| `POST` | `/api/settings/agents/remove` | remove one agent entry (`{ name }`)                                               |
| `POST` | `/api/control/shutdown`       | stop the server                                                                   |

`/api/health` reports `capabilities: { install, command, settings }` so the page
knows whether the registry panel, custom-command box, and settings editor are
enabled.

`/api/settings` returns `{ agents, globalPath, projectPath, writable }`. Each row
carries the resolved `argv`, optional `env`, an `enabled` flag, its `source`
(`config` / `gateway-config` / `built-in`), whether it is `writable` (project
entries and gateway-only rows are read-only because the global file cannot
change them), availability, and — for built-ins — the built-in `defaultArgv` used
by the page's reset button.

`/api/settings/agents` writes `~/.acpx/config.json` with a read-modify-write that
preserves unknown top-level keys and unknown fields inside the entry. Setting
`argv` drops the legacy `command`/`args` fields (the parser rejects mixing them);
setting `env` to `null` or `{}` removes it; setting `enabled: true` deletes the
flag so the entry reverts to the default. Removing an agent deletes its entry.
Unsafe names (anything outside `^[a-zA-Z0-9][a-zA-Z0-9._+-]*$`) are rejected with
`400 unsafe_name`, malformed bodies with `400 invalid_body`, and any mutation with
`403 settings_disabled` when the server runs with `--no-settings`.

Permission modes are chosen per session: `open_session` accepts an optional
`permissionMode` (`approve-all`, `approve-reads`, `deny-all`; default: the server
mode), and the manager keeps one `AcpxRuntime` per mode. Switching the mode in
the UI re-sends `open_session` for the chat, which replaces the runtime session. The session key carries
the mode suffix, so switching modes on an open chat creates a fresh session
instead of reattaching to one created under the old mode. `session_opened`
echoes the mode that actually applies. `GET /api/fs/dirs` returns
`{ path, parent, entries }` (directories only, 400 `fs_error` for missing paths
or files) and backs the page's explorer-style directory picker.

`/api/registry` returns `{ registryVersion, platform, agents }`, where each agent
carries `methods`, `installable` (a distribution exists for this platform), and
`installed` (a config entry with that name already exists).

`/api/registry/install` loads the ACP registry, calls the same installer as
`acpx registry install` (writing `agents.<name>` into `~/.acpx/config.json`), and
refreshes the live catalog. Binary downloads can block for minutes, so the
server raises its request timeout accordingly; the browser shows a per-row
spinner. Errors are mapped to `400` (bad name/method/runner), `404` (unknown
registry id), `502` (retryable download/archive failure), `500` (other), or
`403` when installs are disabled with `--no-install`.

`pnpm chat:status` and `pnpm chat:stop` are thin clients over the last two.
`start` reuses an already-running server only when its `cwd` matches.

### WebSocket `/api/chat`, protocol `acpx.chat.v1`

Client to server:

```ts
| { type: "hello"; protocol: string }
| { type: "open_session"; chatId: string; agent?: string; command?: string; cwd?: string; model?: string; permissionMode?: "approve-all" \| "approve-reads" \| "deny-all" }
| { type: "send"; chatId: string; text: string; requestId: string }
| { type: "cancel"; chatId: string }
| { type: "set_model"; chatId: string; model: string }
| { type: "close_session"; chatId: string; discard?: boolean }
| { type: "ping" }
```

`open_session` requires exactly one of `agent` (a catalog name) or `command` (an
arbitrary command line). A `command` must resolve on `PATH`; otherwise the server
answers `error: command_not_found`. A resolving command is registered under a
synthetic, per-chat agent name (`adhoc-<8 hex>`) and removed when the chat
closes, so it never collides with catalog names. Disabling commands with
`--no-command` rejects them with `error: command_disabled`.

An optional `model` is applied to the new session before it opens. `set_model`
changes the model of an already-open session; it is rejected with
`error: turn_in_progress` while a turn is running, and with
`error: model_unsupported` when the runtime cannot change models or the agent
rejects the id. A successful change emits `session_models`.

Server to client:

```ts
| { type: "ready"; protocol: "acpx.chat.v1" }
| { type: "pong" }
| { type: "session_opened"; chatId; sessionKey; agent; cwd; model?; models? }
| { type: "session_closed"; chatId }
| { type: "session_models"; chatId; models }
| { type: "turn_started"; chatId; requestId }
| { type: "text_delta"; chatId; requestId; text; stream: "output" | "thought" }
| { type: "tool_call"; chatId; requestId; text; toolCallId?; status?; title?; kind?; rawInput?; rawOutput? }
| { type: "status"; chatId; requestId; text; tag?; used?; size?; cost?; entries?; availableCommands? }
| { type: "turn_done"; chatId; requestId; status: "completed" | "cancelled" | "failed"; stopReason?; error? }
| { type: "error"; chatId?; code; message }
```

`models` is `{ currentModelId?, availableModelIds, availableModels? }`, read from
the runtime's session status. `availableModelIds` is always present;
`availableModels` (id + display name) is included when the agent advertises
names. `session_opened.model` mirrors the current id for convenience.

Inbound frames are validated; an unrecognised payload produces
`error: protocol_error` and is dropped.

`turn_done` is always derived from `AcpRuntimeTurn.result`. The runtime's event
stream carries only live `text_delta` / `tool_call` / `status` events and never a
terminal one, so a client that waits for a terminal event on the stream will
hang.

## Session identity

One chat id (a browser-generated UUID) maps to one runtime session:

```text
sessionKey = agent:<agent>:web:<chatId>
```

For ad-hoc command chats `<agent>` is the synthetic `adhoc-<8 hex>` name derived
from the chat id.

The page runs many chats over a single WebSocket. The sidebar keeps a session
list; each session carries its own agent, working directory, and model. Closing a
session (`close_session`) cancels any running turn and closes the runtime session;
`discard: true` also drops its persisted state. Session identity (chat id, agent
or command, model, cwd) is stored in `localStorage` under
`acpx.chat.sessions.v1` so a page reload can reattach instead of starting over.

The chat id is stable across page reloads, so `open_session` calls
`findSession` first and only falls back to `ensureSession`. Re-using the same
chat id reattaches to the stored session rather than starting a new one. Changing
the agent or the working directory within an open chat is rejected while a turn
is running.

While an `open_session` is in flight — the first open, an agent switch, or a
permission-mode change — the page disables the composer, the agent picker, the
model picker, and the permission chip until `session_opened` arrives. Sending or
switching again in that window would race the server's session replacement. A
failed open (`error` without a `session_opened`) releases the lock so the chat
stays usable.

Turns are serialized per session by the runtime, so the page refuses to send a
second prompt while one is in flight (`error: turn_in_progress`) instead of
silently queueing.

Closing the socket does not cancel a running turn; events for a chat are simply
dropped until the page reattaches. Events emitted while no socket is attached are
not buffered.

## Permissions

The page defaults to `approve-all` because it is a loopback test harness. Pass
`--permission-mode approve-reads|deny-all` to tighten it. `nonInteractivePermissions`
is fixed at `deny`, so anything the policy does not explicitly answer fails
closed.

There is no interactive permission prompt in the browser. A prompt-approval
round-trip over the WebSocket is a deliberate non-goal for now.

## Running it

```bash
pnpm chat          # start on 127.0.0.1:4174
pnpm chat:open     # start and open a browser
pnpm chat:status
pnpm chat:stop
```

Flags: `--host`, `--port`, `--cwd`, `--permission-mode`, `--state-dir`,
`--agents-config`, `--no-install`, `--no-command`, `--no-settings`, `--verbose`,
`--open`. `--port 0` picks a free port.

The default port is 4174 so it does not collide with the flow replay viewer on 4173.

## Installing and running commands

Registry installs and ad-hoc commands are **local-trust** features, enabled by
default:

- `POST /api/registry/install` downloads an agent (verifying `sha256` for binary
  distributions) and writes `~/.acpx/config.json`.
- The custom-command box executes any program that resolves on `PATH`.

Both extend what a client of the page can do on the host, so use `--no-install`
and `--no-command` when the server is reachable by anything other than the local
user. The origin guard is not authentication: bind to `127.0.0.1` unless you
accept that anyone who can reach the port can drive agents with `approve-all`.

## Settings

The settings page is a third local-trust surface alongside installs and
commands: it writes `~/.acpx/config.json`, so use `--no-settings` to disable it
when the server is reachable by anything other than the local user. With it
disabled, `GET /api/settings` still reports the rows (with `writable: false`) but
every mutation returns `403 settings_disabled`.

Each row lets you:

- toggle `enabled` (disabled agents disappear from the chat catalog)
- edit the launch command, parsed into an `argv` array (quote-aware) and written
  back as `argv`
- edit `env` as `KEY=VALUE` lines
- reset a built-in to its `defaultArgv`
- remove the entry entirely

Writes are read-modify-write and atomic (temp file + rename), and preserve any
keys the page does not own.
