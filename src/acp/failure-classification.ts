import { AgentDisconnectedError, AgentStartupError } from "../errors.js";
import { isAcpAuthRequiredPayload, isAuthRequiredMessage } from "./error-normalization.js";
import { extractAcpError, formatUnknownErrorMessage } from "./error-shapes.js";

/**
 * Why a backend stopped serving. `quota`, `auth`, `crash` and `unavailable`
 * mean the backend cannot serve the request and another backend can take over;
 * `unknown` stays on the current backend.
 */
export type FailureClass = "quota" | "auth" | "crash" | "unavailable" | "unknown";

export type ClassifiedFailure = {
  class: FailureClass;
  detailCode?: string;
  reason: string;
};

export const QUOTA_EXHAUSTED_DETAIL_CODE = "QUOTA_EXHAUSTED";
export const AUTH_REQUIRED_DETAIL_CODE = "AUTH_REQUIRED";

const CRASH_DETAIL_CODES = new Set(["AGENT_DISCONNECTED", "AGENT_STARTUP_FAILED"]);

/**
 * Provider wording for "this account cannot run more requests right now".
 * Free text is a last resort: structured codes and detail codes win first, so
 * this table only classifies errors that nothing else could explain.
 */
const QUOTA_MESSAGE_PATTERNS: readonly string[] = [
  "rate limit",
  "rate-limit",
  "ratelimit",
  "quota exceeded",
  "exceeded your current quota",
  "insufficient balance",
  "insufficient credit",
  "insufficient quota",
  "credit balance",
  "out of credits",
  "no credits",
  "billing hard limit",
];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readDetailCode(error: unknown): string | undefined {
  const detailCode = asRecord(error)?.detailCode;
  return typeof detailCode === "string" && detailCode.trim().length > 0
    ? detailCode.trim()
    : undefined;
}

/** True when the message reads like a provider quota or rate-limit refusal. */
export function matchesRateLimitMessage(message: string): boolean {
  if (message.length === 0) {
    return false;
  }
  const normalized = message.toLowerCase();
  if (/\b429\b/u.test(normalized)) {
    return true;
  }
  return QUOTA_MESSAGE_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function dataMentionsQuota(data: unknown, depth = 0): boolean {
  if (depth > 2) {
    return false;
  }
  if (typeof data === "string") {
    return matchesRateLimitMessage(data);
  }
  if (Array.isArray(data)) {
    return data.some((item) => dataMentionsQuota(item, depth + 1));
  }
  const record = asRecord(data);
  if (!record) {
    return false;
  }
  return Object.values(record).some((value) => dataMentionsQuota(value, depth + 1));
}

function isCrashFailure(error: unknown, detailCode: string | undefined): boolean {
  return (
    error instanceof AgentDisconnectedError ||
    error instanceof AgentStartupError ||
    (detailCode !== undefined && CRASH_DETAIL_CODES.has(detailCode))
  );
}

function isQuotaFailure(message: string, reason: string, data: unknown): boolean {
  return (
    matchesRateLimitMessage(message) || matchesRateLimitMessage(reason) || dataMentionsQuota(data)
  );
}

function isAuthFailure(
  detailCode: string | undefined,
  acp: ReturnType<typeof extractAcpError>,
  message: string,
): boolean {
  return (
    detailCode === AUTH_REQUIRED_DETAIL_CODE ||
    isAcpAuthRequiredPayload(acp) ||
    isAuthRequiredMessage(message)
  );
}

function acpMessage(acp: ReturnType<typeof extractAcpError>, fallback: string): string {
  return acp?.message ?? fallback;
}

function classifyCrash(
  error: unknown,
  detailCode: string | undefined,
  reason: string,
): ClassifiedFailure | undefined {
  if (!isCrashFailure(error, detailCode)) {
    return undefined;
  }
  return { class: "crash", detailCode: detailCode ?? "AGENT_DISCONNECTED", reason };
}

function classifyQuota(
  message: string,
  reason: string,
  data: unknown,
): ClassifiedFailure | undefined {
  if (!isQuotaFailure(message, reason, data)) {
    return undefined;
  }
  return { class: "quota", detailCode: QUOTA_EXHAUSTED_DETAIL_CODE, reason };
}

function classifyAuth(
  detailCode: string | undefined,
  acp: ReturnType<typeof extractAcpError>,
  message: string,
  reason: string,
): ClassifiedFailure | undefined {
  if (!isAuthFailure(detailCode, acp, message)) {
    return undefined;
  }
  return { class: "auth", detailCode: AUTH_REQUIRED_DETAIL_CODE, reason };
}

function classifyUnavailable(
  detailCode: string | undefined,
  reason: string,
): ClassifiedFailure | undefined {
  if (detailCode !== "NO_SESSION") {
    return undefined;
  }
  return { class: "unavailable", detailCode: "NO_SESSION", reason };
}

/**
 * Classifies an agent failure for failover decisions.
 *
 * Structured signals come first: process exits, ACP error codes and detail
 * codes. Provider wording is only consulted for the quota class, which ACP
 * does not standardize.
 */
export function classifyAgentFailure(error: unknown): ClassifiedFailure {
  const reason = formatUnknownErrorMessage(error);
  const detailCode = readDetailCode(error);
  const acp = extractAcpError(error);
  const message = acpMessage(acp, reason);
  return (
    classifyCrash(error, detailCode, reason) ??
    classifyQuota(message, reason, acp?.data) ??
    classifyAuth(detailCode, acp, message, reason) ??
    classifyUnavailable(detailCode, reason) ?? { class: "unknown", reason }
  );
}

/** True when the failure means the backend cannot serve and another can take over. */
export function isFailoverEligible(failure: ClassifiedFailure): boolean {
  return failure.class !== "unknown";
}
