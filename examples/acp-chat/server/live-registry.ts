import {
  AGENT_REGISTRY,
  createAgentRegistry,
  normalizeAgentName,
  type AcpAgentInspection,
  type AcpAgentInspectionOptions,
  type AcpInspectableAgentRegistry,
} from "../../../src/agent-registry.js";

export type ConfigOverrides = Record<string, string | string[]>;

export type AdHocAgent = {
  name: string;
  argv: string[];
};

/**
 * An agent registry whose overrides can change while the server keeps running.
 * Built-ins resolve through their real definitions; config and ad-hoc entries are
 * injected as overrides.
 */
export interface LiveAgentRegistry extends AcpInspectableAgentRegistry {
  has(name: string): boolean;
  setConfigOverrides(overrides: ConfigOverrides): void;
  registerAdHoc(name: string, argv: string[]): void;
  removeAdHoc(name: string): void;
  listAdHoc(): AdHocAgent[];
}

export class MutableAgentRegistry implements LiveAgentRegistry {
  private configOverrides: ConfigOverrides = {};
  private readonly adHoc = new Map<string, string[]>();
  private delegate: AcpInspectableAgentRegistry;

  constructor(private readonly inspectionOptions: AcpAgentInspectionOptions = {}) {
    this.delegate = createAgentRegistry(this.inspectionOptions);
  }

  setConfigOverrides(overrides: ConfigOverrides): void {
    this.configOverrides = { ...overrides };
    this.rebuild();
  }

  registerAdHoc(name: string, argv: string[]): void {
    const key = normalizeAgentName(name);
    if (!key) {
      return;
    }
    this.adHoc.set(key, [...argv]);
    this.rebuild();
  }

  removeAdHoc(name: string): void {
    if (this.adHoc.delete(normalizeAgentName(name))) {
      this.rebuild();
    }
  }

  listAdHoc(): AdHocAgent[] {
    return [...this.adHoc.entries()].map(([name, argv]) => ({ name, argv: [...argv] }));
  }

  resolve(agentName: string): string | string[] {
    return this.delegate.resolve(agentName);
  }

  list(): string[] {
    return this.delegate.list();
  }

  inspect(agentId: string): AcpAgentInspection | undefined {
    return this.delegate.inspect(agentId);
  }

  has(name: string): boolean {
    const key = normalizeAgentName(name);
    if (!key) {
      return false;
    }
    return Object.hasOwn(this.merged(), key) || Object.hasOwn(AGENT_REGISTRY, key);
  }

  private merged(): ConfigOverrides {
    return { ...this.configOverrides, ...Object.fromEntries(this.adHoc) };
  }

  private rebuild(): void {
    this.delegate = createAgentRegistry({
      overrides: this.merged(),
      ...this.inspectionOptions,
    });
  }
}
