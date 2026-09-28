import type { TranscriptItem } from "../types.js";

export function MessageBubble({ item }: { item: Extract<TranscriptItem, { kind: "message" }> }) {
  return (
    <article className={`bubble bubble-${item.role}`}>
      <header className="bubble-role">{item.role === "user" ? "you" : item.role}</header>
      <pre className="bubble-text">{item.text}</pre>
      {item.streaming ? <span className="streaming-dot" aria-label="streaming" /> : null}
    </article>
  );
}
