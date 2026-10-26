import type { ClassifiedFailure, FailureClass } from "./failure-classification.js";

/** One candidate in the failover chain: an agent plus the model to use there. */
export type FallbackEntry = {
  agent: string;
  model?: string;
  priority: number;
};

export type BackendHealthStatus = "healthy" | "degraded" | "down";

export type BackendHealth = {
  status: BackendHealthStatus;
  failureClass?: FailureClass;
  reason?: string;
  /** ISO timestamp of the last status change. */
  since: string;
  consecutiveFailures: number;
  /** Set after a restore that no real request has confirmed yet. */
  probationUntil?: string;
  /** Restores are skipped until this time after a probation failure. */
  restoreBlockedUntil?: string;
  /** ISO timestamp of the next scheduled health check for this backend. */
  nextCheckAt?: string;
};

export type FailoverRestoreMode = "optimistic" | "canary";

export type FailoverPolicy = {
  entries: FallbackEntry[];
  healthCheckIntervalMs: number;
  restoreMode: FailoverRestoreMode;
};

/** Backend recovery hooks the controller calls during a health check. */
export type FailoverRecoveryHooks = {
  /** Respawns a dead backend and reports whether it serves again. */
  respawn: (agent: string) => Promise<boolean>;
  /** Sends a canary request to a degraded backend and reports success. */
  verify: (agent: string) => Promise<boolean>;
};

export const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const TICK_CEILING_MS = 30_000;

function isoNow(now: number): string {
  return new Date(now).toISOString();
}

/** Orders the chain by descending priority, keeping the configured order for ties. */
export function orderFallbackEntries(entries: readonly FallbackEntry[]): FallbackEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .toSorted((left, right) =>
      right.entry.priority === left.entry.priority
        ? left.index - right.index
        : right.entry.priority - left.entry.priority,
    )
    .map(({ entry }) => entry);
}

export class FailoverController {
  private readonly policy: FailoverPolicy;
  private readonly ordered: FallbackEntry[];
  private readonly agents: string[];
  private readonly health = new Map<string, BackendHealth>();
  private readonly hooks?: FailoverRecoveryHooks;
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  private readonly afterTick?: () => void | Promise<void>;
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(options: {
    policy: FailoverPolicy;
    agents: readonly string[];
    hooks?: FailoverRecoveryHooks;
    log?: (message: string) => void;
    now?: () => number;
    /** Runs after every health-check round, e.g. to move sessions back. */
    afterTick?: () => void | Promise<void>;
  }) {
    this.policy = options.policy;
    this.ordered = orderFallbackEntries(options.policy.entries);
    this.agents = [...options.agents];
    this.hooks = options.hooks;
    this.log = options.log ?? (() => {});
    this.now = options.now ?? Date.now;
    this.afterTick = options.afterTick;
    for (const agent of this.agents) {
      this.health.set(agent, this.healthyState());
    }
  }

  get entries(): readonly FallbackEntry[] {
    return this.ordered;
  }

  get restoreMode(): FailoverRestoreMode {
    return this.policy.restoreMode;
  }

  healthOf(agent: string): BackendHealth {
    return this.health.get(agent) ?? this.healthyState();
  }

  isHealthy(agent: string): boolean {
    return this.healthOf(agent).status === "healthy";
  }

  /** The chain entry describing an agent, including its model pin. */
  entryFor(agent: string): FallbackEntry | undefined {
    return this.ordered.find((entry) => entry.agent === agent);
  }

  /**
   * Highest-priority chain entry whose backend is healthy. `excludeAgent`
   * removes every entry of that agent, so a failure never lands on itself.
   */
  preferredEntry(excludeAgent?: string): FallbackEntry | undefined {
    for (const entry of this.ordered) {
      if (excludeAgent !== undefined && entry.agent === excludeAgent) {
        continue;
      }
      if (this.isHealthy(entry.agent)) {
        return entry;
      }
    }
    return undefined;
  }

  preferredAgent(excludeAgent?: string): string | undefined {
    return this.preferredEntry(excludeAgent)?.agent;
  }

  /**
   * Position of an agent in the chain; lower means higher priority. Agents
   * outside the chain rank behind every chain entry.
   */
  rankOf(agent: string): number {
    const index = this.ordered.findIndex((entry) => entry.agent === agent);
    return index === -1 ? Number.POSITIVE_INFINITY : index;
  }

  markFailure(agent: string, failure: ClassifiedFailure): BackendHealth {
    const next =
      failure.class === "crash"
        ? { status: "down" as const, delay: this.downRetryDelayMs() }
        : { status: "degraded" as const, delay: this.policy.healthCheckIntervalMs };
    const current = this.healthOf(agent);
    const restored =
      current.probationUntil !== undefined && this.now() < Date.parse(current.probationUntil);
    const next_health: BackendHealth = {
      status: next.status,
      failureClass: failure.class,
      reason: failure.reason,
      since: isoNow(this.now()),
      consecutiveFailures: current.consecutiveFailures + 1,
      nextCheckAt: isoNow(this.now() + next.delay),
      ...(restored
        ? { restoreBlockedUntil: isoNow(this.now() + this.policy.healthCheckIntervalMs) }
        : {}),
    };
    this.health.set(agent, next_health);
    this.log(`backend ${agent} ${next.status} (${failure.class}): ${failure.reason}`);
    return next_health;
  }

  markDown(agent: string, reason: string): BackendHealth {
    const current = this.healthOf(agent);
    const next: BackendHealth = {
      status: "down",
      failureClass: current.failureClass ?? "crash",
      reason,
      since: isoNow(this.now()),
      consecutiveFailures: current.consecutiveFailures + 1,
      nextCheckAt: isoNow(this.now() + this.downRetryDelayMs()),
    };
    this.health.set(agent, next);
    this.log(`backend ${agent} down: ${reason}`);
    return next;
  }

  markHealthy(agent: string): BackendHealth {
    const next: BackendHealth = {
      status: "healthy",
      since: isoNow(this.now()),
      consecutiveFailures: 0,
      probationUntil: isoNow(this.now() + this.policy.healthCheckIntervalMs),
    };
    this.health.set(agent, next);
    return next;
  }

  /** Starts the periodic health check. The timer never keeps the process alive. */
  start(): void {
    if (this.timer) {
      return;
    }
    const tickMs = Math.max(1, Math.min(this.policy.healthCheckIntervalMs, TICK_CEILING_MS));
    this.timer = setInterval(() => {
      void this.tick();
    }, tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Runs one health-check round. Overlapping rounds are skipped. */
  async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      for (const agent of this.agents) {
        await this.checkAgent(agent);
      }
      await this.afterTick?.();
    } finally {
      this.ticking = false;
    }
  }

  private async checkAgent(agent: string): Promise<void> {
    const health = this.healthOf(agent);
    if (health.status === "healthy" || !this.isDue(health)) {
      return;
    }
    if (health.status === "down") {
      await this.recoverDownBackend(agent);
      return;
    }
    await this.recoverDegradedBackend(agent);
  }

  /** True when the backend may be checked again. */
  private isDue(health: BackendHealth): boolean {
    const now = this.now();
    if (health.nextCheckAt !== undefined && now < Date.parse(health.nextCheckAt)) {
      return false;
    }
    if (health.restoreBlockedUntil !== undefined && now < Date.parse(health.restoreBlockedUntil)) {
      return false;
    }
    return true;
  }

  private async recoverDownBackend(agent: string): Promise<void> {
    const recovered = (await this.hooks?.respawn(agent)) ?? false;
    if (recovered) {
      this.markHealthy(agent);
      this.log(`backend ${agent} recovered after respawn`);
      return;
    }
    this.scheduleNextCheck(agent, this.downRetryDelayMs());
  }

  private async recoverDegradedBackend(agent: string): Promise<void> {
    if (this.policy.restoreMode === "canary") {
      const recovered = (await this.hooks?.verify(agent)) ?? false;
      if (recovered) {
        this.markHealthy(agent);
        this.log(`backend ${agent} restored after a successful canary probe`);
        return;
      }
      this.scheduleNextCheck(agent, this.policy.healthCheckIntervalMs);
      return;
    }
    this.markHealthy(agent);
    this.log(`backend ${agent} restored (probation)`);
  }

  private scheduleNextCheck(agent: string, delayMs: number): void {
    const health = this.healthOf(agent);
    this.health.set(agent, {
      ...health,
      nextCheckAt: isoNow(this.now() + delayMs),
    });
  }

  private healthyState(): BackendHealth {
    return {
      status: "healthy",
      since: isoNow(this.now()),
      consecutiveFailures: 0,
    };
  }

  private downRetryDelayMs(): number {
    return this.policy.healthCheckIntervalMs;
  }
}
