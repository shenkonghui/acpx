import type { TranscriptItem } from "../types.js";

export function ToolCallCard({ item }: { item: Extract<TranscriptItem, { kind: "tool" }> }) {
  return (
    <article className="tool-card">
      <header className="tool-head">
        <span className="tool-title">{item.title ?? item.toolKind ?? "tool call"}</span>
        {item.status ? <span className={`tag tag-tool-${item.status}`}>{item.status}</span> : null}
      </header>
      {item.text ? <p className="tool-text">{item.text}</p> : null}
      {item.rawInput !== undefined ? (
        <details>
          <summary>input</summary>
          <pre>{formatJson(item.rawInput)}</pre>
        </details>
      ) : null}
      {item.rawOutput !== undefined ? (
        <details>
          <summary>output</summary>
          <pre>{formatJson(item.rawOutput)}</pre>
        </details>
      ) : null}
    </article>
  );
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
