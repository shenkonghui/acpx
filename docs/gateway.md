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
acpx gateway [agents...] [--cwd <dir>] [--handoff] [--handoff-turns <count>] [--handoff-max-chars <count>] [--health-check-interval <minutes>] [--health-check-probe <optimistic|canary>] [--approve-all | --approve-reads | --deny-all] [--verbose]
acpx gateway --config <path> [--cwd <dir>] [--handoff] [--health-check-interval <minutes>] [--health-check-probe <optimistic|canary>] [--approve-all | --approve-reads | --deny-all] [--verbose]
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
- `--health-check-interval <minutes>` (default `60`) and
  `--health-check-probe <optimistic|canary>` control the health check that
  backs the [fallback chain](#fallback-chain). Without a chain they have no
  effect.

## Config-driven backends

When `acpx gateway` runs with no agents and no `--config`:

- Every enabled agent in the main config is served, in the order the entries
  appear in the config file (global config first, then project-only entries).
- Config agents whose launch runs an `acpx gateway` process (any `gateway`
  token in the launch argv) are excluded, so a config-driven gateway does not
  spawn itself. To serve such an agent anyway, name it explicitly as a
  positional agent.
- The first served agent is the default for sessions created without
  `_meta.acpx.agent`. A [fallback chain](#fallback-chain) overrides this: its
  highest-priority healthy entry becomes the default.
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
  (the first configured agent, or the highest-priority healthy entry of the
  [fallback chain](#fallback-chain) when one is configured) before prompting.

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
- The binding is fixed by default: a later `model` selection for a different
  agent is rejected (cross-backend switching is not supported). Pass
  [`--handoff`](#session-handoff) to migrate the conversation instead.
  `session/prompt`, `session/cancel`, `session/set_mode`,
  `session/set_config_option`, and `session/close` all route by session id, with
  no per-request agent field.
- `session/load` and `session/resume` require an already-bound session.

Gateway session ids are gateway-generated (`gw-` prefix) and differ from the
downstream agent session ids. `session/update` notifications are relayed
upstream with the gateway session id substituted.

## Session handoff

ACP has no cross-agent history transfer, so `--handoff` emulates it: the gateway
buffers the session's conversation and, when a bound session selects a model
that belongs to another agent, creates a session on that agent and feeds it a
structured handoff prompt before switching the route.

- With `--handoff`, the merged model selector stays visible after binding with
  the current value set to the bound `<agent>/<modelId>`. That is the only
  client-visible trigger for a switch, so clients keep offering all backends.
- The handoff prompt contains the latest plan entries, the most recent tool
  calls (with file paths), and the last N user turns verbatim. It is framed as
  reference data, and the target agent is asked to reply `HANDOFF_OK` without
  calling tools; that turn's output is dropped upstream.
- `--handoff-turns <count>` controls the recent-turn window (default `8`).
  `--handoff-max-chars <count>` caps the rendered prompt (default `8000`).
- Migration is refused while a turn is running. The old binding stays active
  until the target accepted the model and the handoff prompt, so a failure
  (target cannot start, model unsupported, handoff prompt errors) leaves the
  session usable on the old agent.
- After a successful switch the previous downstream session is closed best
  effort and the gateway session id is unchanged, so the upstream client sees a
  continuous session. `session/load` and `session/resume` follow the new
  downstream session.

Fidelity limits:

- Only text is migrated. Tool side effects, terminal state, and process-local
  caches of the old agent are not replayed; the handoff lists what tools ran.
- The handoff costs one extra turn on the target backend and consumes context
  window. Very long sessions are truncated to `--handoff-max-chars`.
- Buffered history lives in gateway memory only and disappears with the
  process; `session/load` cannot recover it across restarts.

## Fallback chain

A fallback chain declares an ordered list of backends the gateway may move a
session to when the current backend stops serving. It is opt-in: without a
`fallbacks` key the gateway behaves exactly as before — a failing prompt
returns the underlying error and nothing else changes.

```json
{
  "agents": {
    "codex": { "argv": ["codex-acp"], "enabledModels": ["gpt-5.4"] },
    "claude": { "argv": ["claude-code-acp"], "enabledModels": ["claude-sonnet-4-5"] },
    "qoder": { "argv": ["qodercli", "--acp"], "enabledModels": ["qfmodel"] }
  },
  "fallbacks": [
    { "agent": "codex", "model": "gpt-5.4", "priority": 100 },
    { "agent": "claude", "model": "claude-sonnet-4-5" },
    { "agent": "qoder", "priority": 10 }
  ]
}
```

Rules:

- The chain is a **priority preference list**. On a failure the gateway picks
  the highest-priority entry whose backend is healthy, skipping every entry of
  the agent that just failed.
- `priority` is optional. An entry without one slots in just below the previous
  entry, so a chain with no priorities keeps the configured order and a chain
  that pins some entries keeps those pins. In the example above the effective
  order is `codex` (100), `claude` (99), `qoder` (10).
- `model` is optional. Without it the target keeps the model the backend
  currently serves; with it the migrated session is pinned to that model when
  the backend advertises it.
- Every `agent` in the chain must be served by this gateway. A chain naming an
  agent that is not served is a startup configuration error.
- With a chain configured, the highest-priority healthy entry is the default
  target for new sessions. When the whole chain is unhealthy the gateway falls
  back to the ordinary default agent.
- A project `fallbacks` array replaces the global one; it is not merged
  entry by entry.

### What triggers a failover

Only failures that mean "this backend cannot serve the request" move a session:

| Class         | Signal                                                                     |
| ------------- | -------------------------------------------------------------------------- |
| `crash`       | the agent process exited or could not start                                |
| `quota`       | the adapter reported a rate limit, exhausted quota, or insufficient credit |
| `auth`        | the adapter refused the request because it is not authenticated (`-32000`) |
| `unavailable` | the backend no longer knows the session (`NO_SESSION`)                     |

Anything else — a timeout, a denied permission, a usage error — stays on the
current backend, because failing over would hide the real cause.

Quota detection is the one place where free-text provider wording is read,
since ACP standardizes no quota code. The patterns live in one auditable
table (`src/acp/failure-classification.ts`); a structured `detailCode` always
wins over the text.

### How a session moves

A failing prompt is not simply retried somewhere else:

- The session is migrated with the same handoff mechanism `--handoff` uses — a
  session is created on the target agent and the conversation is carried over as
  a structured handoff prompt. Unlike a client-initiated switch, this migration
  does not need `--handoff`: it is the gateway repairing its own routing.
- After the migration the failed turn is replayed **once** on the new backend
  and the client receives the new `config_option_update`, so its model selector
  matches the backend that actually served the turn.
- The turn is **not** replayed when the failing backend had already streamed
  output for it. Replaying could duplicate side effects, so the original error
  reaches the client and only the backend's health is updated.
- If the migration itself fails, the session keeps its old binding and the
  original error reaches the client.
- A backend the client selected explicitly is never swapped out from under it
  before the turn runs. If that backend is down, the turn fails there and the
  failover rules above move it to a healthy chain entry — the client sees the
  updated model through the `config_option_update`.

Sessions the client deliberately bound to a lower-priority agent are never
moved automatically; only a failover leaves a trail the gateway follows back.

### Health checks and recovery

`--health-check-interval <minutes>` (default `60`) sets how often the gateway
looks at backends that are not healthy:

- A **crashed** backend is respawned and probed again. A successful probe marks
  it healthy again.
- A **degraded** backend (quota or auth failure, process still alive) is marked
  healthy again by default without contacting it — quota recovery can usually
  only be proven by a real request. Pass `--health-check-probe canary` to send
  one short probe prompt instead, which does consume a little quota but proves
  the backend works.
- A recovered backend enters a **probation** period of one interval. A failure
  during probation marks it unhealthy again immediately and suppresses the next
  restore attempt for one interval.

When a higher-priority backend recovers, the gateway moves back to it:

- New sessions go to the recovered backend, because the default target is
  resolved from the chain on every request.
- Sessions that previously failed over are migrated back to the recovered
  backend with the same handoff mechanism. A session stays where it is if the
  migration fails or a turn is running.

With `--verbose` the gateway logs each transition to stderr, for example
`backend codex degraded (quota): …`, `session gw-1 failed over from codex to
claude`, `respawned agent codex`, `backend codex recovered after respawn`, and
`session gw-1 restored to codex`.

### Limits

- Recovery of a quota-exhausted account is optimistic by default: the first
  real request after a restore may still fail. Probation handles that by
  degrading the backend again on the first failure.
- The chain lives in one gateway process. There is no cross-process election.
- Health state is in memory; a gateway restart forgets which backends were
  degraded.

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
  Without a [fallback chain](#fallback-chain) the gateway does not restart
  agents; route new sessions to a healthy agent. With a chain, a failing
  backend is degraded, healthy sessions move to the next chain entry, and the
  health check respawns the crashed backend and moves sessions back once it
  recovers.
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
