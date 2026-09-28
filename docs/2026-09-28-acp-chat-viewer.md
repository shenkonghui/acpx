# ACP Chat Viewer

This document specifies the local web chat page for testing ACP agents that
`acpx` already knows about.

It covers:

- agent discovery (which agents appear)
- the HTTP and WebSocket protocol between the page and the server
- session identity and lifetime
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

## Transport

The server is a single `node:http` listener that embeds Vite in middleware mode
for the page, handles `/api/*` itself, and upgrades `/api/chat` to a WebSocket.
Requests and upgrades must come from the server's own origin; anything else gets
`403` (see `server/request-origin.ts`).

### HTTP

| Method | Path                    | Purpose                                                                           |
| ------ | ----------------------- | --------------------------------------------------------------------------------- |
| `GET`  | `/api/health`           | service identity (`acpx-acp-chat`), `cwd`, permissions, state dir, `capabilities` |
| `GET`  | `/api/agents`           | agent catalog (rebuilt per request, so installs appear live)                      |
| `GET`  | `/api/registry`         | agents available in the official ACP registry plus install status                 |
| `POST` | `/api/registry/install` | install a registry agent (`{ id, method?, asName?, force? }`)                     |
| `POST` | `/api/control/shutdown` | stop the server                                                                   |

`/api/health` reports `capabilities: { install, command }` so the page knows
whether the registry panel and custom-command box are enabled.

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
| { type: "open_session"; chatId: string; agent?: string; command?: string; cwd?: string }
| { type: "send"; chatId: string; text: string; requestId: string }
| { type: "cancel"; chatId: string }
| { type: "close_session"; chatId: string; discard?: boolean }
| { type: "ping" }
```

`open_session` requires exactly one of `agent` (a catalog name) or `command` (an
arbitrary command line). A `command` must resolve on `PATH`; otherwise the server
answers `error: command_not_found`. A resolving command is registered under a
synthetic, per-chat agent name (`adhoc-<8 hex>`) and removed when the chat
closes, so it never collides with catalog names. Disabling commands with
`--no-command` rejects them with `error: command_disabled`.

Server to client:

```ts
| { type: "ready"; protocol: "acpx.chat.v1" }
| { type: "pong" }
| { type: "session_opened"; chatId; sessionKey; agent; cwd }
| { type: "session_closed"; chatId }
| { type: "turn_started"; chatId; requestId }
| { type: "text_delta"; chatId; requestId; text; stream: "output" | "thought" }
| { type: "tool_call"; chatId; requestId; text; toolCallId?; status?; title?; kind?; rawInput?; rawOutput? }
| { type: "status"; chatId; requestId; text; tag?; used?; size?; cost?; entries?; availableCommands? }
| { type: "turn_done"; chatId; requestId; status: "completed" | "cancelled" | "failed"; stopReason?; error? }
| { type: "error"; chatId?; code; message }
```

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

The chat id is stable across page reloads, so `open_session` calls
`findSession` first and only falls back to `ensureSession`. Re-using the same
chat id reattaches to the stored session rather than starting a new one. Changing
the agent or the working directory within an open chat is rejected while a turn
is running.

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
`--agents-config`, `--no-install`, `--no-command`, `--verbose`, `--open`.
`--port 0` picks a free port.

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
