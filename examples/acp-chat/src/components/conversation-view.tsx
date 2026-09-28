import { useEffect, useRef } from "react";
import type { TranscriptItem } from "../types.js";
import { MessageBubble } from "./message-bubble.js";
import { ToolCallCard } from "./tool-call-card.js";

export function ConversationView({
  transcript,
  emptyHint,
}: {
  transcript: TranscriptItem[];
  emptyHint: string;
}) {
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [transcript]);

  if (transcript.length === 0) {
    return <p className="muted conversation-empty">{emptyHint}</p>;
  }

  return (
    <div className="conversation">
      {transcript.map((item) =>
        item.kind === "message" ? (
          <MessageBubble key={item.id} item={item} />
        ) : (
          <ToolCallCard key={item.id} item={item} />
        ),
      )}
      <div ref={bottomRef} />
    </div>
  );
}
