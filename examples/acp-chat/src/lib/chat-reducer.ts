import type {
  ChatAction,
  ChatMessageRole,
  ChatServerMessage,
  ChatState,
  ChatStatusView,
  TranscriptItem,
} from "../types.js";
import type { StoredSessions } from "./session-store.js";

export function createInitialChatState(chatId: string): ChatState {
  return {
    connected: false,
    chatId,
    transcript: [],
    status: { entries: [], availableCommands: [] },
    errors: [],
    opening: false,
  };
}

export function reduceChatState(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "disconnected":
      return { ...state, connected: false };
    case "ready":
      return { ...state, connected: true };
    case "pong":
      return state;
    case "opening":
      return {
        ...state,
        opening: true,
        agent: action.agent,
        command: action.command,
        cwd: action.cwd ?? state.cwd,
        model: action.model,
        permissionMode: action.permissionMode,
        models: undefined,
        transcript: [],
        status: { entries: [], availableCommands: [] },
        errors: [],
        activeRequestId: undefined,
        lastTurn: undefined,
      };
    case "session_opened":
      return {
        ...state,
        opening: false,
        agent: action.agent,
        sessionKey: action.sessionKey,
        cwd: action.cwd,
        ...(action.model !== undefined ? { model: action.model } : {}),
        ...(action.models !== undefined ? { models: action.models } : {}),
        ...(action.permissionMode !== undefined ? { permissionMode: action.permissionMode } : {}),
      };
    case "session_models": {
      const next = { ...state, models: action.models };
      if (action.models.currentModelId !== undefined) {
        next.model = action.models.currentModelId;
      } else if (
        state.model !== undefined &&
        !action.models.availableModelIds.includes(state.model)
      ) {
        // The enabled-models filter removed the selected model; fall back to
        // the first available option.
        delete next.model;
      }
      return next;
    }
    case "session_closed":
      return { ...state, opening: false };
    case "user_message":
      return {
        ...state,
        activeRequestId: action.requestId,
        transcript: [
          ...state.transcript,
          {
            kind: "message",
            id: `user:${action.requestId}`,
            requestId: action.requestId,
            role: "user",
            text: action.text,
            streaming: false,
          },
        ],
      };
    case "turn_started":
      return { ...state, activeRequestId: action.requestId };
    case "text_delta":
      return {
        ...state,
        transcript: appendDelta(
          state.transcript,
          action.requestId,
          action.stream === "thought" ? "thought" : "assistant",
          action.text,
        ),
      };
    case "tool_call":
      return { ...state, transcript: mergeToolCall(state.transcript, action) };
    case "status":
      return { ...state, status: mergeStatus(state.status, action) };
    case "turn_done":
      return {
        ...state,
        transcript: finalizeTurn(state.transcript, action.requestId),
        activeRequestId:
          state.activeRequestId === action.requestId ? undefined : state.activeRequestId,
        lastTurn: {
          requestId: action.requestId,
          status: action.status,
          stopReason: action.stopReason,
        },
        errors:
          action.status === "failed"
            ? [...state.errors, action.error?.message ?? "Turn failed"]
            : state.errors,
      };
    case "error":
      // A failed `open_session` never emits `session_opened`, so clear the
      // opening flag here or the chat would stay locked behind a dead session.
      return { ...state, errors: [...state.errors, action.message], opening: false };
    case "clear_errors":
      return { ...state, errors: [] };
    default:
      // Unknown frames (for example a newer server message) leave state untouched.
      return state;
  }
}

function appendDelta(
  transcript: TranscriptItem[],
  requestId: string,
  role: ChatMessageRole,
  text: string,
): TranscriptItem[] {
  const last = transcript.at(-1);
  if (
    last?.kind === "message" &&
    last.requestId === requestId &&
    last.role === role &&
    last.streaming
  ) {
    return [...transcript.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [
    ...transcript,
    {
      kind: "message",
      id: `${requestId}:${role}:${transcript.length}`,
      requestId,
      role,
      text,
      streaming: true,
    },
  ];
}

function mergeToolCall(
  transcript: TranscriptItem[],
  action: Extract<ChatAction, { type: "tool_call" }>,
): TranscriptItem[] {
  const toolCallId = action.toolCallId;
  const index = toolCallId
    ? transcript.findIndex((item) => item.kind === "tool" && item.toolCallId === toolCallId)
    : -1;

  const existing = index >= 0 ? transcript[index] : undefined;
  if (existing?.kind === "tool") {
    const updated: TranscriptItem = {
      ...existing,
      text: action.text || existing.text,
      title: action.title ?? existing.title,
      status: action.status ?? existing.status,
      toolKind: action.kind ?? existing.toolKind,
      rawInput: action.rawInput ?? existing.rawInput,
      rawOutput: action.rawOutput ?? existing.rawOutput,
    };
    return [...transcript.slice(0, index), updated, ...transcript.slice(index + 1)];
  }

  const id = toolCallId ?? `${action.requestId}:tool:${transcript.length}`;
  return [
    ...transcript,
    {
      kind: "tool",
      id: `tool:${id}`,
      requestId: action.requestId,
      toolCallId: id,
      text: action.text,
      title: action.title,
      status: action.status,
      toolKind: action.kind,
      rawInput: action.rawInput,
      rawOutput: action.rawOutput,
    },
  ];
}

function mergeStatus(
  status: ChatStatusView,
  action: Extract<ChatAction, { type: "status" }>,
): ChatStatusView {
  return {
    text: action.text || status.text,
    tag: action.tag ?? status.tag,
    used: action.used ?? status.used,
    size: action.size ?? status.size,
    cost: action.cost ?? status.cost,
    entries: action.entries ?? status.entries,
    availableCommands: action.availableCommands ?? status.availableCommands,
  };
}

function finalizeTurn(transcript: TranscriptItem[], requestId: string): TranscriptItem[] {
  return transcript.map((item) =>
    item.kind === "message" && item.requestId === requestId && item.streaming
      ? { ...item, streaming: false }
      : item,
  );
}

/** View state for the multi-session shell: many chats sharing one socket. */
export type SessionsState = {
  connected: boolean;
  sessions: Record<string, ChatState>;
  order: string[];
  activeChatId?: string;
};

export type SessionsAction =
  | { type: "disconnected" }
  | {
      type: "opening";
      chatId: string;
      agent?: string;
      command?: string;
      cwd?: string;
      model?: string;
    }
  | { type: "user_message"; chatId: string; requestId: string; text: string }
  | { type: "clear_errors"; chatId?: string }
  | { type: "session_removed"; chatId: string }
  | { type: "select_session"; chatId: string }
  | ChatServerMessage;

export function createInitialSessionsState(stored: StoredSessions): SessionsState {
  const sessions: Record<string, ChatState> = {};
  const order: string[] = [];
  for (const item of stored.sessions) {
    sessions[item.chatId] = {
      ...createInitialChatState(item.chatId),
      ...(item.agent !== undefined ? { agent: item.agent } : {}),
      ...(item.command !== undefined ? { command: item.command } : {}),
      ...(item.model !== undefined ? { model: item.model } : {}),
      ...(item.cwd !== undefined ? { cwd: item.cwd } : {}),
    };
    order.push(item.chatId);
  }
  const activeChatId =
    stored.activeChatId && sessions[stored.activeChatId] ? stored.activeChatId : order.at(-1);
  return {
    connected: false,
    sessions,
    order,
    ...(activeChatId !== undefined ? { activeChatId } : {}),
  };
}

/** Routes a frame to the session it names, or to the active session for global errors. */
export function reduceSessionsState(state: SessionsState, action: SessionsAction): SessionsState {
  switch (action.type) {
    case "disconnected":
      return { ...state, connected: false };
    case "ready":
      return { ...state, connected: true };
    case "pong":
      return state;
    case "clear_errors": {
      const chatId = action.chatId ?? state.activeChatId;
      if (!chatId || !state.sessions[chatId]) {
        return state;
      }
      return patchSession(
        state,
        chatId,
        reduceChatState(state.sessions[chatId], { type: "clear_errors" }),
      );
    }
    case "session_removed":
      return removeSession(state, action.chatId);
    case "select_session":
      return state.sessions[action.chatId] ? { ...state, activeChatId: action.chatId } : state;
    case "opening": {
      const base = state.sessions[action.chatId] ?? createInitialChatState(action.chatId);
      const next = reduceChatState(base, {
        type: "opening",
        ...(action.agent !== undefined ? { agent: action.agent } : {}),
        ...(action.command !== undefined ? { command: action.command } : {}),
        ...(action.cwd !== undefined ? { cwd: action.cwd } : {}),
        ...(action.model !== undefined ? { model: action.model } : {}),
      });
      return patchSession(state, action.chatId, next);
    }
    case "user_message": {
      const session = state.sessions[action.chatId];
      if (!session) {
        return state;
      }
      return patchSession(
        state,
        action.chatId,
        reduceChatState(session, {
          type: "user_message",
          requestId: action.requestId,
          text: action.text,
        }),
      );
    }
    default: {
      const chatId = "chatId" in action ? action.chatId : undefined;
      const target = chatId ?? state.activeChatId;
      if (!target || !state.sessions[target]) {
        return state;
      }
      return patchSession(state, target, reduceChatState(state.sessions[target], action));
    }
  }
}

function patchSession(state: SessionsState, chatId: string, next: ChatState): SessionsState {
  const order = state.sessions[chatId] ? state.order : [...state.order, chatId];
  return { ...state, sessions: { ...state.sessions, [chatId]: next }, order };
}

function removeSession(state: SessionsState, chatId: string): SessionsState {
  if (!state.sessions[chatId]) {
    return state;
  }
  const sessions = { ...state.sessions };
  delete sessions[chatId];
  const order = state.order.filter((id) => id !== chatId);
  const activeChatId = state.activeChatId === chatId ? order.at(-1) : state.activeChatId;
  return {
    connected: state.connected,
    sessions,
    order,
    ...(activeChatId !== undefined ? { activeChatId } : {}),
  };
}
