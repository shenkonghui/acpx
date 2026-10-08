import type { SessionConfigOption, SessionModeState } from "@agentclientprotocol/sdk";
import { asRecord } from "./jsonrpc.js";

/**
 * Unified permission vocabulary exposed by the gateway. Backends advertise modes
 * with arbitrary, opaque ids; the gateway normalizes them onto this fixed set and
 * translates back through a per-backend synonym table (see {@link toBackendModeId}).
 */
export const UNIFIED_PERMISSION_VALUES = ["ask", "code", "bypass"] as const;

export type UnifiedPermission = (typeof UNIFIED_PERMISSION_VALUES)[number];

/** Config-option id the gateway uses for the unified permission selector. */
export const UNIFIED_PERMISSION_CONFIG_ID = "mode";

const UNIFIED_PERMISSION_OPTION_NAME = "Permission Mode";

export const DEFAULT_UNIFIED_PERMISSION: UnifiedPermission = "code";

/**
 * Synonym preference per unified value; the first synonym present in a backend's
 * advertised mode ids wins. Order matters: `default` belongs to `ask` (agents that
 * prompt before acting), while `auto`/`acceptEdits` belong to `code`.
 */
const BACKEND_MODE_SYNONYMS: Record<UnifiedPermission, readonly string[]> = {
  ask: ["ask", "default", "read-only", "readonly", "plan"],
  code: ["code", "acceptEdits", "auto", "default", "build"],
  bypass: ["bypass", "bypassPermissions", "full-access", "fullAccess", "dangerous", "yolo"],
};

const UNIFIED_PERMISSION_LABELS: Record<UnifiedPermission, string> = {
  ask: "Ask",
  code: "Code",
  bypass: "Bypass",
};

/** How a backend advertises and accepts session modes. */
export type BackendModeSupport = {
  /** `config_option` = a `category:"mode"` select; `set_mode` = the SDK `modes` field. */
  setPath: "config_option" | "set_mode" | "none";
  /** Config-option id, present when {@link setPath} is `config_option`. */
  configId?: string;
  /** Backend mode ids, used to resolve synonym translations. */
  advertisedIds: string[];
  /** The backend's currently active mode id, when advertised. */
  currentBackendId?: string;
};

export function isUnifiedPermission(value: string): value is UnifiedPermission {
  return (UNIFIED_PERMISSION_VALUES as readonly string[]).includes(value);
}

export function isModeSelectOption(option: Record<string, unknown>): boolean {
  return option.type === "select" && (option.category === "mode" || option.id === "mode");
}

function parseSelectValues(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const direct = value.map((item) => asRecord(item)?.value);
  if (direct.every((entry): entry is string => typeof entry === "string")) {
    return direct;
  }
  const grouped = value.map((group) => {
    const record = asRecord(group);
    if (!record || !Array.isArray(record.options)) {
      return undefined;
    }
    const values = record.options.map((option) => asRecord(option)?.value);
    return values.every((entry): entry is string => typeof entry === "string") ? values : undefined;
  });
  return grouped.every((entry): entry is string[] => entry !== undefined)
    ? grouped.flat()
    : undefined;
}

/** Extracts a `category:"mode"` select from a session's config options. */
export function modeOptionFromConfigOptions(
  configOptions: unknown,
): { configId: string; values: string[]; currentValue: string } | undefined {
  if (!Array.isArray(configOptions)) {
    return undefined;
  }
  for (const value of configOptions) {
    const option = asRecord(value);
    if (!option || !isModeSelectOption(option)) {
      continue;
    }
    if (typeof option.id !== "string" || typeof option.currentValue !== "string") {
      continue;
    }
    const values = parseSelectValues(option.options);
    if (values) {
      return { configId: option.id, values, currentValue: option.currentValue };
    }
  }
  return undefined;
}

function modeIdsFromModes(
  modes: SessionModeState | undefined,
): { ids: string[]; currentId?: string } | undefined {
  if (!modes || !Array.isArray(modes.availableModes)) {
    return undefined;
  }
  const ids = modes.availableModes
    .map((mode) => asRecord(mode)?.id)
    .filter((id): id is string => typeof id === "string");
  return {
    ids,
    ...(typeof modes.currentModeId === "string" ? { currentId: modes.currentModeId } : {}),
  };
}

/**
 * Resolves how a backend exposes modes. A `category:"mode"` config option wins
 * over the SDK `modes` field (mirroring model handling), because it is settable
 * through the same `session/set_config_option` path the gateway already routes.
 */
export function resolveBackendModeSupport(params: {
  configOptions: unknown;
  modes: SessionModeState | undefined;
}): BackendModeSupport {
  const option = modeOptionFromConfigOptions(params.configOptions);
  if (option) {
    return {
      setPath: "config_option",
      configId: option.configId,
      advertisedIds: option.values,
      currentBackendId: option.currentValue,
    };
  }
  const fromModes = modeIdsFromModes(params.modes);
  if (fromModes) {
    return {
      setPath: "set_mode",
      advertisedIds: fromModes.ids,
      ...(fromModes.currentId ? { currentBackendId: fromModes.currentId } : {}),
    };
  }
  return { setPath: "none", advertisedIds: [] };
}

function matchesSynonym(synonym: string, advertisedId: string): boolean {
  return synonym === advertisedId || synonym.toLowerCase() === advertisedId.toLowerCase();
}

/** Maps a unified permission onto a backend mode id, or `undefined` if unmapped. */
export function toBackendModeId(
  unified: UnifiedPermission,
  advertisedIds: readonly string[],
): string | undefined {
  for (const synonym of BACKEND_MODE_SYNONYMS[unified]) {
    const hit = advertisedIds.find((id) => matchesSynonym(synonym, id));
    if (hit) {
      return hit;
    }
  }
  return undefined;
}

/** Maps a backend mode id back onto a unified permission, or `undefined` if unmapped. */
export function toUnifiedPermission(
  backendId: string,
  advertisedIds: readonly string[],
): UnifiedPermission | undefined {
  if (!advertisedIds.some((id) => matchesSynonym(backendId, id))) {
    return undefined;
  }
  for (const unified of UNIFIED_PERMISSION_VALUES) {
    if (BACKEND_MODE_SYNONYMS[unified].some((synonym) => matchesSynonym(synonym, backendId))) {
      return unified;
    }
  }
  return undefined;
}

/** Reflects a backend's active mode as a unified permission, defaulting to `code`. */
export function resolveUnifiedCurrentPermission(support: BackendModeSupport): UnifiedPermission {
  if (support.currentBackendId) {
    const unified = toUnifiedPermission(support.currentBackendId, support.advertisedIds);
    if (unified) {
      return unified;
    }
  }
  return DEFAULT_UNIFIED_PERMISSION;
}

/** Builds the unified permission selector exposed to clients. */
export function buildUnifiedModeOption(
  currentValue: UnifiedPermission = DEFAULT_UNIFIED_PERMISSION,
): SessionConfigOption {
  return {
    id: UNIFIED_PERMISSION_CONFIG_ID,
    name: UNIFIED_PERMISSION_OPTION_NAME,
    category: "mode",
    type: "select",
    currentValue,
    options: UNIFIED_PERMISSION_VALUES.map((value) => ({
      value,
      name: UNIFIED_PERMISSION_LABELS[value],
    })),
  };
}
