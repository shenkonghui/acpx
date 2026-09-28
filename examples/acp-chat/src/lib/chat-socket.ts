import { CHAT_PROTOCOL, type ChatClientMessage, type ChatServerMessage } from "../types.js";

const RECONNECT_DELAY_MS = 1_000;

export function buildChatWebSocketUrl(currentUrl: string = window.location.href): string {
  const url = new URL(currentUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/chat";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export type ChatSocketHandlers = {
  onMessage: (message: ChatServerMessage) => void;
  onOpen: () => void;
  onDisconnected: () => void;
};

/** Reconnecting client for the `/api/chat` WebSocket protocol. */
export class ChatSocketClient {
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private disposed = false;

  constructor(private readonly handlers: ChatSocketHandlers) {}

  connect(): void {
    if (this.disposed) {
      return;
    }
    const socket = new WebSocket(buildChatWebSocketUrl());
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.send({ type: "hello", protocol: CHAT_PROTOCOL });
      this.handlers.onOpen();
    });
    socket.addEventListener("message", (event) => {
      let message: ChatServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ChatServerMessage;
      } catch {
        return;
      }
      this.handlers.onMessage(message);
    });
    socket.addEventListener("close", () => {
      if (this.socket === socket) {
        this.socket = null;
      }
      this.handlers.onDisconnected();
      this.scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      socket.close();
    });
  }

  send(message: ChatClientMessage): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.socket.send(JSON.stringify(message));
    return true;
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== null) {
      return;
    }
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_DELAY_MS);
  }
}
