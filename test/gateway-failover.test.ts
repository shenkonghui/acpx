import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyAgentFailure,
  isFailoverEligible,
  matchesRateLimitMessage,
} from "../src/acp/failure-classification.js";
import {
  DEFAULT_HEALTH_CHECK_INTERVAL_MS,
  FailoverController,
  orderFallbackEntries,
} from "../src/acp/gateway-failover.js";
import { AgentDisconnectedError } from "../src/errors.js";

type AcpLikeError = { code: number; message: string; data?: unknown };

function acpError(code: number, message: string, data?: unknown): AcpLikeError {
  return { code, message, ...(data !== undefined ? { data } : {}) };
}

test("failure classification: an ACP auth refusal is an auth failure", () => {
  const failure = classifyAgentFailure(acpError(-32000, "Authentication required: token expired"));
  assert.equal(failure.class, "auth");
  assert.equal(failure.detailCode, "AUTH_REQUIRED");
  assert.equal(isFailoverEligible(failure), true);
});

test("failure classification: quota wording is a quota failure", () => {
  for (const message of [
    "Quota exceeded for this account",
    "HTTP 429 Too Many Requests",
    "Your credit balance is too low",
    "insufficient balance on account",
  ]) {
    const failure = classifyAgentFailure(acpError(-32000, message));
    assert.equal(failure.class, "quota", message);
    assert.equal(failure.detailCode, "QUOTA_EXHAUSTED");
    assert.equal(isFailoverEligible(failure), true);
  }
});

test("failure classification: quota wording in the error data is a quota failure", () => {
  const failure = classifyAgentFailure(
    acpError(-32000, "request rejected", { reason: "rate limit reached" }),
  );
  assert.equal(failure.class, "quota");
});

test("failure classification: a disconnected agent is a crash", () => {
  const failure = classifyAgentFailure(new AgentDisconnectedError("pipe_close", 1, null));
  assert.equal(failure.class, "crash");
  assert.equal(failure.detailCode, "AGENT_DISCONNECTED");
});

test("failure classification: permission and usage errors stay on the backend", () => {
  const denied = classifyAgentFailure(acpError(-32603, "Permission denied by the user"));
  assert.equal(denied.class, "unknown");
  assert.equal(isFailoverEligible(denied), false);

  const usage = classifyAgentFailure(acpError(-32602, "Unsupported prompt content"));
  assert.equal(usage.class, "unknown");
  assert.equal(isFailoverEligible(usage), false);
});

test("failure classification: rate limit matching is case insensitive", () => {
  assert.equal(matchesRateLimitMessage("Rate Limit Exceeded"), true);
  assert.equal(matchesRateLimitMessage("http 429"), true);
  assert.equal(matchesRateLimitMessage("something else"), false);
});

test("failover chain: entries are ordered by priority and keep the configured order for ties", () => {
  const ordered = orderFallbackEntries([
    { agent: "low", priority: 10 },
    { agent: "high", priority: 100 },
    { agent: "mid-a", priority: 50 },
    { agent: "mid-b", priority: 50 },
  ]);
  assert.deepEqual(
    ordered.map((entry) => entry.agent),
    ["high", "mid-a", "mid-b", "low"],
  );
});

test("failover chain: the preferred entry is the healthiest highest-priority one", () => {
  const controller = new FailoverController({
    policy: {
      entries: [
        { agent: "alpha", priority: 100 },
        { agent: "beta", priority: 50 },
        { agent: "gamma", priority: 10 },
      ],
      healthCheckIntervalMs: DEFAULT_HEALTH_CHECK_INTERVAL_MS,
      restoreMode: "optimistic",
    },
    agents: ["alpha", "beta", "gamma"],
  });

  assert.equal(controller.preferredAgent(), "alpha");
  controller.markFailure("alpha", { class: "quota", reason: "quota exceeded" });
  assert.equal(controller.preferredAgent(), "beta");
  controller.markFailure("beta", { class: "auth", reason: "token expired" });
  assert.equal(controller.preferredAgent(), "gamma");
  // A failed agent never receives its own traffic again.
  assert.equal(controller.preferredAgent("gamma"), undefined);
});

test("failover health: a crash takes the backend down, other failures degrade it", () => {
  const controller = new FailoverController({
    policy: {
      entries: [{ agent: "alpha", priority: 100 }],
      healthCheckIntervalMs: DEFAULT_HEALTH_CHECK_INTERVAL_MS,
      restoreMode: "optimistic",
    },
    agents: ["alpha"],
  });

  assert.equal(controller.healthOf("alpha").status, "healthy");
  controller.markFailure("alpha", { class: "quota", reason: "quota exceeded" });
  assert.equal(controller.healthOf("alpha").status, "degraded");
  assert.equal(controller.healthOf("alpha").consecutiveFailures, 1);

  controller.markDown("alpha", "process exited");
  assert.equal(controller.healthOf("alpha").status, "down");
});

test("failover health: a restored backend enters probation and a probation failure blocks restores", async () => {
  let clock = Date.parse("2026-01-01T00:00:00.000Z");
  const respawns: string[] = [];
  const controller = new FailoverController({
    policy: {
      entries: [{ agent: "alpha", priority: 100 }],
      healthCheckIntervalMs: 60_000,
      restoreMode: "optimistic",
    },
    agents: ["alpha"],
    now: () => clock,
    hooks: {
      respawn: async (agent) => {
        respawns.push(agent);
        return true;
      },
      verify: async () => true,
    },
  });

  controller.markDown("alpha", "process exited");
  // The backend is checked again on the next health-check interval.
  clock += 60_000;
  await controller.tick();
  assert.deepEqual(respawns, ["alpha"]);
  assert.equal(controller.healthOf("alpha").status, "healthy");
  assert.ok(controller.healthOf("alpha").probationUntil);

  // A failure inside the probation window degrades the backend again and
  // blocks the next restore for one interval.
  clock += 1_000;
  controller.markFailure("alpha", { class: "quota", reason: "quota exceeded" });
  assert.equal(controller.healthOf("alpha").status, "degraded");
  assert.ok(controller.healthOf("alpha").restoreBlockedUntil);

  await controller.tick();
  assert.equal(controller.healthOf("alpha").status, "degraded");
  assert.deepEqual(respawns, ["alpha"]);
});

test("failover health: a degraded backend is only restored after a successful canary", async () => {
  let clock = Date.parse("2026-01-01T00:00:00.000Z");
  let canaryResult = false;
  const controller = new FailoverController({
    policy: {
      entries: [{ agent: "alpha", priority: 100 }],
      healthCheckIntervalMs: 60_000,
      restoreMode: "canary",
    },
    agents: ["alpha"],
    now: () => clock,
    hooks: {
      respawn: async () => true,
      verify: async () => canaryResult,
    },
  });

  controller.markFailure("alpha", { class: "quota", reason: "quota exceeded" });
  await controller.tick();
  assert.equal(controller.healthOf("alpha").status, "degraded");

  clock += 60_000;
  canaryResult = true;
  await controller.tick();
  assert.equal(controller.healthOf("alpha").status, "healthy");
});
