import type { ChatStatusView, LastTurn } from "../types.js";

export function StatusPanel({
  connected,
  agent,
  command,
  cwd,
  sessionKey,
  activeRequestId,
  lastTurn,
  status,
}: {
  connected: boolean;
  agent?: string;
  command?: string;
  cwd?: string;
  sessionKey?: string;
  activeRequestId?: string;
  lastTurn?: LastTurn;
  status: ChatStatusView;
}) {
  const planEntries = status.entries.map(describeEntry).filter((entry) => entry.length > 0);
  const commands = status.availableCommands.map(describeCommand).filter((name) => name.length > 0);

  return (
    <aside className="status-panel">
      <h2>Session</h2>
      <dl className="status-list">
        <dt>connection</dt>
        <dd>{connected ? "connected" : "disconnected"}</dd>
        <dt>agent</dt>
        <dd>{agent ?? "—"}</dd>
        {command ? (
          <>
            <dt>command</dt>
            <dd className="mono small">{command}</dd>
          </>
        ) : null}
        <dt>cwd</dt>
        <dd className="mono">{cwd ?? "—"}</dd>
        <dt>state</dt>
        <dd>{activeRequestId ? "running a turn" : lastTurn ? lastTurn.status : "idle"}</dd>
        {sessionKey ? (
          <>
            <dt>session</dt>
            <dd className="mono small">{sessionKey}</dd>
          </>
        ) : null}
        {status.used !== undefined ? (
          <>
            <dt>context</dt>
            <dd>
              {status.size !== undefined ? `${status.used} / ${status.size}` : String(status.used)}
            </dd>
          </>
        ) : null}
      </dl>

      {status.text ? (
        <>
          <h2>Status</h2>
          <p className="muted">{status.text}</p>
        </>
      ) : null}

      {planEntries.length > 0 ? (
        <>
          <h2>Plan</h2>
          <ol className="plan-list">
            {planEntries.map((entry, index) => (
              <li key={`${index}-${entry}`}>{entry}</li>
            ))}
          </ol>
        </>
      ) : null}

      {commands.length > 0 ? (
        <>
          <h2>Commands</h2>
          <div className="command-chips">
            {commands.map((name) => (
              <span className="tag" key={name}>
                /{name}
              </span>
            ))}
          </div>
        </>
      ) : null}
    </aside>
  );
}

function describeEntry(entry: unknown): string {
  if (typeof entry === "string") {
    return entry;
  }
  if (entry && typeof entry === "object") {
    const record = entry as Record<string, unknown>;
    const text = record.content ?? record.title ?? record.description;
    if (typeof text === "string") {
      const status = record.status;
      return typeof status === "string" || typeof status === "number"
        ? `${text} (${status})`
        : text;
    }
  }
  return "";
}

function describeCommand(command: unknown): string {
  if (typeof command === "string") {
    return command;
  }
  if (command && typeof command === "object") {
    const name = (command as Record<string, unknown>).name;
    if (typeof name === "string") {
      return name;
    }
  }
  return "";
}
