import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  createInitialSessionsState,
  reduceSessionsState,
  type SessionsState,
} from "../lib/chat-reducer.js";
import { ChatSocketClient } from "../lib/chat-socket.js";
import {
  loadStoredSessions,
  saveStoredSessions,
  type StoredSession,
} from "../lib/session-store.js";
import type { ChatState, PermissionMode } from "../types.js";

export type OpenChatOptions = {
  cwd?: string;
  model?: string;
  permissionMode?: PermissionMode;
  /** Reuse an existing chat id instead of creating a new one (reattach). */
  chatId?: string;
};

export type ChatSocketState = {
  state: SessionsState;
  openChat: (agent: string, options?: OpenChatOptions) => string;
  openCommand: (command: string, options?: OpenChatOptions) => string;
  send: (chatId: string, text: string) => boolean;
  cancel: (chatId: string) => void;
  closeChat: (chatId: string, discard?: boolean) => void;
  setModel: (chatId: string, model: string) => void;
  selectSession: (chatId: string) => void;
  dismissErrors: (chatId?: string) => void;
};

type PendingOpen = {
  agent?: string;
  command?: string;
  cwd?: string;
  model?: string;
  permissionMode?: PermissionMode;
};

// `crypto.randomUUID` is only available in secure contexts, so the page throws
// when it is served over plain HTTP from a non-localhost origin. `getRandomValues`
// is available everywhere, so build a v4-shaped id from it instead.
function createClientId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function useChatSocket(): ChatSocketState {
  const [state, dispatch] = useReducer(reduceSessionsState, undefined, () =>
    createInitialSessionsState(loadStoredSessions()),
  );
  const socketRef = useRef<ChatSocketClient | null>(null);
  const desiredRef = useRef<Map<string, PendingOpen> | null>(null);
  const persistedRef = useRef<string>("");

  // Seed the "wanted" sessions from any restored ones so a reload reattaches.
  if (desiredRef.current === null) {
    const desired = new Map<string, PendingOpen>();
    for (const chatId of state.order) {
      const spec = toPendingOpen(state.sessions[chatId]);
      if (spec) {
        desired.set(chatId, spec);
      }
    }
    desiredRef.current = desired;
  }

  const flushOpen = useCallback(() => {
    const client = socketRef.current;
    const desired = desiredRef.current;
    if (!client || !desired) {
      return;
    }
    for (const [chatId, spec] of desired) {
      client.send({ type: "open_session", chatId, ...spec });
    }
  }, []);

  useEffect(() => {
    const client = new ChatSocketClient({
      onMessage: (message) => dispatch(message),
      onOpen: () => flushOpen(),
      onDisconnected: () => dispatch({ type: "disconnected" }),
    });
    socketRef.current = client;
    client.connect();
    return () => {
      client.dispose();
      socketRef.current = null;
    };
  }, [flushOpen]);

  // Persist identity only (never transcripts); skip writes when nothing changed.
  const stored = buildStoredSessions(state);
  const serialized = JSON.stringify(stored);
  useEffect(() => {
    if (persistedRef.current === serialized) {
      return;
    }
    persistedRef.current = serialized;
    saveStoredSessions(stored);
  }, [serialized, stored]);

  const openChat = useCallback((agent: string, options: OpenChatOptions = {}) => {
    const chatId = options.chatId ?? createClientId();
    const spec: PendingOpen = {
      agent,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
    };
    desiredRef.current?.set(chatId, spec);
    dispatch({
      type: "opening",
      chatId,
      agent,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
    });
    dispatch({ type: "select_session", chatId });
    socketRef.current?.send({ type: "open_session", chatId, ...spec });
    return chatId;
  }, []);

  const openCommand = useCallback((command: string, options: OpenChatOptions = {}) => {
    const chatId = options.chatId ?? createClientId();
    const spec: PendingOpen = {
      command,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
    };
    desiredRef.current?.set(chatId, spec);
    dispatch({
      type: "opening",
      chatId,
      command,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
    });
    dispatch({ type: "select_session", chatId });
    socketRef.current?.send({ type: "open_session", chatId, ...spec });
    return chatId;
  }, []);

  const send = useCallback((chatId: string, text: string) => {
    const requestId = createClientId();
    const sent = socketRef.current?.send({ type: "send", chatId, text, requestId }) ?? false;
    if (sent) {
      dispatch({ type: "user_message", chatId, requestId, text });
    }
    return sent;
  }, []);

  const cancel = useCallback((chatId: string) => {
    socketRef.current?.send({ type: "cancel", chatId });
  }, []);

  const closeChat = useCallback((chatId: string, discard = false) => {
    desiredRef.current?.delete(chatId);
    socketRef.current?.send({ type: "close_session", chatId, discard });
    dispatch({ type: "session_removed", chatId });
  }, []);

  const setModel = useCallback((chatId: string, model: string) => {
    socketRef.current?.send({ type: "set_model", chatId, model });
  }, []);

  const selectSession = useCallback((chatId: string) => {
    dispatch({ type: "select_session", chatId });
  }, []);

  const dismissErrors = useCallback((chatId?: string) => {
    dispatch({ type: "clear_errors", ...(chatId !== undefined ? { chatId } : {}) });
  }, []);

  return {
    state,
    openChat,
    openCommand,
    send,
    cancel,
    closeChat,
    setModel,
    selectSession,
    dismissErrors,
  };
}

function toPendingOpen(session: ChatState | undefined): PendingOpen | undefined {
  if (!session) {
    return undefined;
  }
  if (session.agent) {
    return {
      agent: session.agent,
      ...(session.cwd ? { cwd: session.cwd } : {}),
      ...(session.model ? { model: session.model } : {}),
      ...(session.permissionMode ? { permissionMode: session.permissionMode } : {}),
    };
  }
  if (session.command) {
    return {
      command: session.command,
      ...(session.cwd ? { cwd: session.cwd } : {}),
      ...(session.permissionMode ? { permissionMode: session.permissionMode } : {}),
    };
  }
  return undefined;
}

function toStoredSession(
  chatId: string,
  session: ChatState | undefined,
): StoredSession | undefined {
  if (!session || (!session.agent && !session.command)) {
    return undefined;
  }
  return {
    chatId,
    ...(session.agent ? { agent: session.agent } : {}),
    ...(session.command ? { command: session.command } : {}),
    ...(session.model ? { model: session.model } : {}),
    ...(session.cwd ? { cwd: session.cwd } : {}),
    ...(session.permissionMode ? { permissionMode: session.permissionMode } : {}),
  };
}

function buildStoredSessions(state: SessionsState): {
  sessions: StoredSession[];
  activeChatId?: string;
} {
  const sessions: StoredSession[] = [];
  for (const chatId of state.order) {
    const entry = toStoredSession(chatId, state.sessions[chatId]);
    if (entry) {
      sessions.push(entry);
    }
  }
  return {
    sessions,
    ...(state.activeChatId !== undefined ? { activeChatId: state.activeChatId } : {}),
  };
}
