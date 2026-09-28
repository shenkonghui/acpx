import { z } from "zod";

export const CHAT_PROTOCOL = "acpx.chat.v1";

export type ChatClientMessage =
  | { type: "hello"; protocol: string }
  | { type: "open_session"; chatId: string; agent?: string; command?: string; cwd?: string }
  | { type: "send"; chatId: string; text: string; requestId: string }
  | { type: "cancel"; chatId: string }
  | { type: "close_session"; chatId: string; discard?: boolean }
  | { type: "ping" };

export type ChatTurnStatus = "completed" | "cancelled" | "failed";

export type ChatErrorCode =
  | "protocol_error"
  | "agent_not_found"
  | "command_not_found"
  | "command_disabled"
  | "session_error"
  | "turn_in_progress"
  | "internal_error";

export type ChatServerMessage =
  | { type: "ready"; protocol: typeof CHAT_PROTOCOL }
  | { type: "pong" }
  | { type: "session_opened"; chatId: string; sessionKey: string; agent: string; cwd: string }
  | { type: "session_closed"; chatId: string }
  | { type: "turn_started"; chatId: string; requestId: string }
  | {
      type: "text_delta";
      chatId: string;
      requestId: string;
      text: string;
      stream: "output" | "thought";
    }
  | {
      type: "tool_call";
      chatId: string;
      requestId: string;
      text: string;
      toolCallId?: string;
      status?: string;
      title?: string;
      kind?: string;
      rawInput?: unknown;
      rawOutput?: unknown;
      content?: unknown;
    }
  | {
      type: "status";
      chatId: string;
      requestId: string;
      text: string;
      tag?: string;
      used?: number;
      size?: number;
      cost?: unknown;
      entries?: unknown[];
      availableCommands?: unknown[];
    }
  | {
      type: "turn_done";
      chatId: string;
      requestId: string;
      status: ChatTurnStatus;
      stopReason?: string;
      error?: { message: string; code?: string };
    }
  | { type: "error"; chatId?: string; code: ChatErrorCode; message: string };

export const chatClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), protocol: z.string() }),
  z
    .object({
      type: z.literal("open_session"),
      chatId: z.string().min(1),
      agent: z.string().min(1).optional(),
      command: z.string().min(1).optional(),
      cwd: z.string().min(1).optional(),
    })
    .superRefine((value, ctx) => {
      if ((value.agent === undefined) === (value.command === undefined)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "open_session requires exactly one of agent or command",
        });
      }
    }),
  z.object({
    type: z.literal("send"),
    chatId: z.string().min(1),
    text: z.string().min(1),
    requestId: z.string().min(1),
  }),
  z.object({ type: z.literal("cancel"), chatId: z.string().min(1) }),
  z.object({
    type: z.literal("close_session"),
    chatId: z.string().min(1),
    discard: z.boolean().optional(),
  }),
  z.object({ type: z.literal("ping") }),
]);

export type ParsedChatClientMessage = z.infer<typeof chatClientMessageSchema>;
