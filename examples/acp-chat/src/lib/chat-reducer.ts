import type {
  ChatAction,
  ChatMessageRole,
  ChatState,
  ChatStatusView,
  TranscriptItem,
} from "../types.js";

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
      };
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
      return { ...state, errors: [...state.errors, action.message] };
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
