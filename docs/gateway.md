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
acpx gateway [agents...] [--cwd <dir>] [--approve-all | --approve-reads | --deny-all] [--verbose]
acpx gateway --config <path> [--cwd <dir>] [--approve-all | --approve-reads | --deny-all] [--verbose]
```

- With no agents and no `--config`, the gateway serves every enabled agent
  defined in the main config, so the `agents` map is the single source of truth
  for both direct launches and gateway backends.
- `<agent>...` accepts one or more agent names, config-defined agents, or raw
  commands, using the same resolution rules as [Custom agents](custom-agents.md).
  A raw command string (for example `"node ./scripts/dev-acp.mjs"`) is one
  positional argument.
- `--config <path>` loads the agent list from a JSON file instead of positional
  arguments. The two forms are mutually exclusive.

## Config-driven backends

When `acpx gateway` runs with no agents and no `--config`:

- Every enabled agent in the main config is served, in the order the entries
  appear in the config file (global config first, then project-only entries).
- Config agents whose launch runs an `acpx gateway` process (any `gateway`
  token in the launch argv) are excluded, so a config-driven gateway does not
  spawn itself. To serve such an agent anyway, name it explicitly as a
  positional agent.
- The first served agent is the default for sessions created without
  `_meta.acpx.agent`.
- Only explicitly configured agents are served — built-in agents are not
  added automatically (positional mode still resolves built-ins by name).
- The backend set follows the gateway process's own config view: global config
  plus the project config for its `--cwd`.

## Gateway config file (legacy)

`--config` points at a JSON file listing every ACP server the gateway should
start. Prefer defining backends in the main config instead; the file format is
kept for existing setups. Each entry carries a friendly `name` (used for
`_meta` agent selection) plus its launch definition — either `command` with
optional `args`, or a full `argv` array:

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
- Every listed agent process is spawned at gateway startup, then probed once
  with `session/new` to learn its models and session modes. An agent that fails
  to _start_ aborts the gateway; an agent that fails to _probe_ (for example one
  that needs auth before `session/new`) is kept reachable through
  `_meta.acpx.agent` but contributes no models or modes to the merged surface.
- Duplicate agent commands are deduplicated: two names resolving to the same
  command share one process.
- An entry may carry an `enabledModels` array of bare model ids to whitelist
  what that backend advertises (see [Model allowlists](#model-allowlists)
  below). The legacy `--config` file does not support the special
  `acpx-gateway` merged-surface allowlist — define the gateway agent in the
  main config for that.
- Permission flags apply to every session through the gateway. Permissions,
  filesystem, and terminal callbacks are answered by the gateway itself; they
  are not forwarded upstream.

## Choosing the agent for a session

The gateway advertises every backend's models as one merged selector on
`session/new`. Each model value is prefixed with its agent name
(`<agent>/<modelId>`), so a client picks a model and its backend in one step:

- `session/new` returns an **unbound** session (`gw-` id) whose `configOptions`
  carry the merged model selector plus a unified permission selector. No
  downstream session is created yet.
- The first `session/set_config_option` for `model` binds the session: the
  gateway parses the prefix, creates the downstream session on that agent, and
  applies the model. A `mode` (or other option) chosen before binding is
  buffered and replayed once bound.
- `session/prompt` on a still-unbound session binds it to the default agent
  (the first configured agent) before prompting.

`_meta.acpx.agent` still works as an explicit, immediate binding for clients
that route by agent name:

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

- Model references are matched against the longest configured agent name
  followed by `/`; model ids keep their own `/` (e.g. `alpha/provider/model-1`).
- An unknown model reference or an unknown `_meta` agent is an invalid-params
  protocol error.
- The binding is permanent: a later `model` selection for a different agent is
  rejected (cross-backend switching is not supported). `session/prompt`,
  `session/cancel`, `session/set_mode`, `session/set_config_option`, and
  `session/close` all route by session id, with no per-request agent field.
- `session/load` and `session/resume` require an already-bound session.

Gateway session ids are gateway-generated (`gw-` prefix) and differ from the
downstream agent session ids. `session/update` notifications are relayed
upstream with the gateway session id substituted.

## Models and permissions

- **Models.** The merged selector's values are `<agent>/<modelId>` and its
  labels are `<agent>: <model name>`. Selecting one binds the session to that
  agent and applies the model downstream.
- **Permissions.** Backends advertise session modes inconsistently, so the
  gateway exposes one unified selector with three values — `ask`, `code`,
  `bypass` — and translates each onto the bound backend's own mode ids through a
  per-agent synonym table (`default`→`ask`, `auto`/`acceptEdits`→`code`,
  `bypassPermissions`/`full-access`→`bypass`). A backend that advertises no
  matching mode accepts the value without forwarding it.

## Model allowlists

Each agent entry accepts an optional `enabledModels` array of bare model ids
(no `<agent>/` prefix). The gateway applies it at three points:

- During backend probing, so the merged selector on `session/new` only lists
  allowed models for that agent.
- On a bound session, so `session/set_config_option` for `model` only offers
  the allowed subset and selecting a filtered-out model is rejected with an
  invalid-params error.
- On downstream `session/update` notifications, so models added later by an
  adapter still respect the allowlist.

An `enabledModels` entry on the gateway's own `acpx-gateway` config agent is
special: because that agent is excluded from the backend list (it would
recurse), its bare ids are interpreted as prefixed `<agent>/<model>` refs and
filter the **merged** surface across every backend. Use this to publish only a
curated subset of the full backend catalog to upstream clients.

```json
{
  "agents": {
    "cb": {
      "argv": ["codebuddy", "--acp"],
      "enabledModels": ["deepseek-v4.1-flash"]
    },
    "acpx-gateway": {
      "argv": ["acpx", "gateway"],
      "enabledModels": ["cb/deepseek-v4.1-flash", "qoder-cn/qfmodel"]
    }
  }
}
```

Direct `acpx <agent>` calls still see every advertised model; `enabledModels`
is honored by `acpx gateway` only.

## Lifecycle

- **Upstream stdin EOF:** the gateway retires every agent process (close stdin,
  then SIGTERM, then SIGKILL escalation) and exits `0`.
- **SIGINT/SIGTERM:** the same retirement sequence runs and the gateway exits
  `130`.
- **Agent crash:** prompts bound to that agent fail with the underlying error.
  The gateway does not restart agents; route new sessions to a healthy agent.
- **Session persistence:** sessions live in gateway memory only. `session/load`
  and `session/resume` work for bound sessions created on this gateway
  connection; there is no cross-restart recovery. The agent processes themselves
  keep the conversation state for as long as they live.

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
