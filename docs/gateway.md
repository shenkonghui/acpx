---
title: Gateway
description: Serve multiple agents through one ACP endpoint — acpx gateway spawns every configured agent, routes each session to its chosen agent, and relays updates back upstream.
---

# Gateway

`acpx gateway` turns acpx into a session-routing ACP server: one process speaks
ACP over stdio to an upstream ACP client, while every configured agent runs as
its own child process behind it.

```text
acp-client ──stdio/NDJSON──> acpx gateway
                                ├─ AcpClient ──> agent A process
                                ├─ AcpClient ──> agent B process
                                └─ AcpClient ──> agent C process
```

## Usage

```bash
acpx gateway <agent>... [--cwd <dir>] [--approve-all | --approve-reads | --deny-all] [--verbose]
acpx gateway --config <path> [--cwd <dir>] [--approve-all | --approve-reads | --deny-all] [--verbose]
```

- `<agent>...` accepts one or more agent names, config-defined agents, or raw
  commands, using the same resolution rules as [Custom agents](custom-agents.md).
  A raw command string (for example `"node ./scripts/dev-acp.mjs"`) is one
  positional argument.
- `--config <path>` loads the agent list from a JSON file instead of positional
  arguments. The two forms are mutually exclusive.

## Gateway config file

`--config` points at a JSON file listing every ACP server the gateway should
start. Each entry carries a friendly `name` (used for `_meta` agent selection)
plus its launch definition — either `command` with optional `args`, or a full
`argv` array:

```json
{
  "agents": [
    {
      "name": "cb",
      "command": "codebuddy",
      "args": ["--acp", "--permission-mode", "acceptEdits"],
      "default": true
    },
    {
      "name": "qoder",
      "argv": ["qodercli", "--acp"]
    }
  ]
}
```

Rules:

- `name` is required and unique; it is the value clients pass in
  `session/new` `_meta.acpx.agent`.
- Use either `command` (+ optional `args`) or `argv` alone — the same
  convention as the `agents` map in [Config](config.md). `command` must be an
  unquoted executable when `args` is present; `argv` includes the executable
  as its first element.
- At most one entry may set `"default": true`. Without it, the first entry is
  the default agent.
- Duplicate names, empty agent lists, and more than one default are config
  errors reported before any agent process starts.
- Every listed agent process is spawned at gateway startup. If any agent fails
  to start, the gateway exits with the failure instead of serving partial
  sessions.
- Duplicate agent commands are deduplicated: two names resolving to the same
  command share one process.
- Permission flags apply to every session through the gateway. Permissions,
  filesystem, and terminal callbacks are answered by the gateway itself; they
  are not forwarded upstream.

## Choosing the agent for a session

The upstream ACP client selects the agent when it creates a session, using the
ACP `_meta` extension field on `session/new`:

```json
{
  "jsonrpc": "2.0",
  "id": "req-1",
  "method": "session/new",
  "params": {
    "cwd": "/repo",
    "mcpServers": [],
    "_meta": {
      "acpx": {
        "agent": "codex"
      }
    }
  }
}
```

Rules:

- `_meta.acpx.agent` must match one of the gateway's positional agent tokens
  exactly. Raw-command agents are addressed by their full command string.
- Omitting `_meta` (or the field) binds the session to the default agent —
  the first positional token.
- Selecting an unknown agent is an invalid-params protocol error.
- The binding is permanent for the session's lifetime: `session/prompt`,
  `session/cancel`, `session/set_mode`, `session/set_config_option`, and
  `session/close` all route by session id, with no per-request agent field.

Gateway session ids are gateway-generated (`gw-` prefix) and differ from the
downstream agent session ids. `session/update` notifications are relayed
upstream with the gateway session id substituted.

## Lifecycle

- **Upstream stdin EOF:** the gateway retires every agent process (close stdin,
  then SIGTERM, then SIGKILL escalation) and exits `0`.
- **SIGINT/SIGTERM:** the same retirement sequence runs and the gateway exits
  `130`.
- **Agent crash:** prompts bound to that agent fail with the underlying error.
  The gateway does not restart agents; route new sessions to a healthy agent.
- **Session persistence:** sessions live in gateway memory only. `session/load`
  and `session/resume` work for sessions created on this gateway connection;
  there is no cross-restart recovery. The agent processes themselves keep the
  conversation state for as long as they live.

## Limitations

- One upstream connection per gateway process (stdio transport).
- One active prompt turn per agent process at a time; concurrent turns across
  different agents are fine.
- MCP servers advertised by the upstream client on `session/new` are not
  forwarded to downstream agents.
- `session/list`, `session/delete`, `session/fork`, elicitation, and NES
  methods are not routed; they return method-not-found.

## See also

- [`--acp` proxy mode](CLI.md#acp-proxy-mode) — transparent 1:1 relay where
  the upstream client owns sessions.
- [Custom agents](custom-agents.md) — agent resolution rules.
- [Permissions](permissions.md) — permission modes.
