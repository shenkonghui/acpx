/**
 * Persists the open chat sessions (identity only — never transcripts) so a page
 * reload can reattach to the same runtime sessions instead of starting over.
 */

import type { PermissionMode } from "../types.js";

export type StoredSession = {
  chatId: string;
  agent?: string;
  command?: string;
  model?: string;
  cwd?: string;
  permissionMode?: PermissionMode;
  title?: string;
};

export type StoredSessions = {
  sessions: StoredSession[];
  activeChatId?: string;
};

const STORAGE_KEY = "acpx.chat.sessions.v1";

export function loadStoredSessions(): StoredSessions {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { sessions: [] };
    }
    const parsed = JSON.parse(raw) as unknown;
    return normalizeStoredSessions(parsed);
  } catch {
    return { sessions: [] };
  }
}

export function saveStoredSessions(state: StoredSessions): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage can be unavailable (private mode, quota); persistence is best-effort.
  }
}

function normalizeStoredSessions(value: unknown): StoredSessions {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { sessions: [] };
  }
  const record = value as { sessions?: unknown; activeChatId?: unknown };
  const sessions: StoredSession[] = [];
  if (Array.isArray(record.sessions)) {
    for (const item of record.sessions) {
      const session = normalizeStoredSession(item);
      if (session) {
        sessions.push(session);
      }
    }
  }
  const activeChatId =
    typeof record.activeChatId === "string" &&
    sessions.some((session) => session.chatId === record.activeChatId)
      ? record.activeChatId
      : undefined;
  return { sessions, ...(activeChatId !== undefined ? { activeChatId } : {}) };
}

function normalizeStoredSession(value: unknown): StoredSession | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.chatId !== "string" || record.chatId.length === 0) {
    return undefined;
  }
  const optional = (key: string): string | undefined => {
    const value = record[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  const agent = optional("agent");
  const command = optional("command");
  if (agent === undefined && command === undefined) {
    return undefined;
  }
  const model = optional("model");
  const cwd = optional("cwd");
  const title = optional("title");
  return {
    chatId: record.chatId,
    ...(agent !== undefined ? { agent } : {}),
    ...(command !== undefined ? { command } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(title !== undefined ? { title } : {}),
  };
}
