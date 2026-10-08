import type { ChatStatusView, ChatTurnStatus, LastTurn } from "../types.js";

const TURN_STATUS_LABELS: Record<ChatTurnStatus, string> = {
  completed: "已完成",
  cancelled: "已取消",
  failed: "已失败",
};

export function StatusPanel({
  connected,
  agent,
  command,
  cwd,
  model,
  permissionMode,
  sessionKey,
  activeRequestId,
  lastTurn,
  status,
}: {
  connected: boolean;
  agent?: string;
  command?: string;
  cwd?: string;
  model?: string;
  permissionMode?: string;
  sessionKey?: string;
  activeRequestId?: string;
  lastTurn?: LastTurn;
  status: ChatStatusView;
}) {
  const planEntries = status.entries.map(describeEntry).filter((entry) => entry.length > 0);
  const commands = status.availableCommands.map(describeCommand).filter((name) => name.length > 0);

  return (
    <aside className="status-panel">
      <h2>会话</h2>
      <dl className="status-list">
        <dt>连接</dt>
        <dd>{connected ? "已连接" : "未连接"}</dd>
        <dt>agent</dt>
        <dd>{agent ?? "—"}</dd>
        {command ? (
          <>
            <dt>命令</dt>
            <dd className="mono small">{command}</dd>
          </>
        ) : null}
        <dt>工作目录</dt>
        <dd className="mono">{cwd ?? "—"}</dd>
        {model ? (
          <>
            <dt>模型</dt>
            <dd className="mono small">{model}</dd>
          </>
        ) : null}
        <dt>权限</dt>
        <dd>{permissionMode ?? "—"}</dd>
        <dt>状态</dt>
        <dd>
          {activeRequestId ? "正在运行" : lastTurn ? TURN_STATUS_LABELS[lastTurn.status] : "空闲"}
        </dd>
        {sessionKey ? (
          <>
            <dt>会话 ID</dt>
            <dd className="mono small">{sessionKey}</dd>
          </>
        ) : null}
        {status.used !== undefined ? (
          <>
            <dt>上下文</dt>
            <dd>
              {status.size !== undefined ? `${status.used} / ${status.size}` : String(status.used)}
            </dd>
          </>
        ) : null}
      </dl>

      {status.text ? (
        <>
          <h2>状态</h2>
          <p className="muted">{status.text}</p>
        </>
      ) : null}

      {planEntries.length > 0 ? (
        <>
          <h2>计划</h2>
          <ol className="plan-list">
            {planEntries.map((entry, index) => (
              <li key={`${index}-${entry}`}>{entry}</li>
            ))}
          </ol>
        </>
      ) : null}

      {commands.length > 0 ? (
        <>
          <h2>命令</h2>
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
