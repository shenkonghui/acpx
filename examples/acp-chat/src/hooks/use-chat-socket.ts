import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { createInitialChatState, reduceChatState } from "../lib/chat-reducer.js";
import { ChatSocketClient } from "../lib/chat-socket.js";
import type { ChatState } from "../types.js";

export type ChatSocketState = {
  state: ChatState;
  openChat: (agent: string, cwd?: string) => void;
  openCommand: (command: string, cwd?: string) => void;
  send: (text: string) => boolean;
  cancel: () => void;
  closeChat: (discard?: boolean) => void;
  dismissErrors: () => void;
};

type PendingOpen = {
  agent?: string;
  command?: string;
  cwd?: string;
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
  const chatId = useMemo(() => createClientId(), []);
  const [state, dispatch] = useReducer(reduceChatState, chatId, createInitialChatState);
  const socketRef = useRef<ChatSocketClient | null>(null);
  const pendingOpenRef = useRef<PendingOpen | null>(null);

  const flushOpen = useCallback(() => {
    const pending = pendingOpenRef.current;
    if (!pending) {
      return;
    }
    socketRef.current?.send({
      type: "open_session",
      chatId,
      ...(pending.agent !== undefined ? { agent: pending.agent } : {}),
      ...(pending.command !== undefined ? { command: pending.command } : {}),
      ...(pending.cwd ? { cwd: pending.cwd } : {}),
    });
  }, [chatId]);

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

  const openChat = useCallback(
    (agent: string, cwd?: string) => {
      pendingOpenRef.current = { agent, ...(cwd ? { cwd } : {}) };
      dispatch({ type: "opening", agent, ...(cwd ? { cwd } : {}) });
      flushOpen();
    },
    [flushOpen],
  );

  const openCommand = useCallback(
    (command: string, cwd?: string) => {
      pendingOpenRef.current = { command, ...(cwd ? { cwd } : {}) };
      dispatch({ type: "opening", command, ...(cwd ? { cwd } : {}) });
      flushOpen();
    },
    [flushOpen],
  );

  const send = useCallback(
    (text: string) => {
      const requestId = createClientId();
      const sent = socketRef.current?.send({ type: "send", chatId, text, requestId }) ?? false;
      if (sent) {
        dispatch({ type: "user_message", requestId, text });
      }
      return sent;
    },
    [chatId],
  );

  const cancel = useCallback(() => {
    socketRef.current?.send({ type: "cancel", chatId });
  }, [chatId]);

  const closeChat = useCallback(
    (discard = false) => {
      pendingOpenRef.current = null;
      socketRef.current?.send({ type: "close_session", chatId, discard });
    },
    [chatId],
  );

  const dismissErrors = useCallback(() => dispatch({ type: "clear_errors" }), []);

  return { state, openChat, openCommand, send, cancel, closeChat, dismissErrors };
}
