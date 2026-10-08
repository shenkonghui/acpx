export type SessionListItem = {
  chatId: string;
  label: string;
  detail?: string;
  running?: boolean;
};

export function SessionList({
  sessions,
  activeChatId,
  onSelect,
  onClose,
  onNew,
  disabled,
}: {
  sessions: SessionListItem[];
  activeChatId?: string;
  onSelect: (chatId: string) => void;
  onClose: (chatId: string) => void;
  onNew: () => void;
  disabled?: boolean;
}) {
  return (
    <section className="sidebar-section">
      <div className="sidebar-section-title">
        <span>会话</span>
        <button
          type="button"
          onClick={onNew}
          disabled={disabled}
          title="新建会话"
          aria-label="新建会话"
          style={{ padding: "0 6px", fontSize: 14 }}
        >
          +
        </button>
      </div>
      {sessions.length === 0 ? (
        <p className="sidebar-hint">暂无会话。</p>
      ) : (
        <ul>
          {sessions.map((session) => {
            const selected = session.chatId === activeChatId;
            return (
              <li key={session.chatId}>
                <div className={`session-item${selected ? " session-item-selected" : ""}`}>
                  <button
                    type="button"
                    className="session-select"
                    onClick={() => onSelect(session.chatId)}
                    title={session.detail ?? session.chatId}
                  >
                    <span className="session-label">
                      {session.running ? (
                        <span className="running-dot" aria-label="运行中" />
                      ) : null}
                      {session.label}
                    </span>
                    {session.detail ? (
                      <span className="session-detail mono small">{session.detail}</span>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    className="session-close"
                    onClick={() => onClose(session.chatId)}
                    title="关闭会话"
                    aria-label={`关闭会话 ${session.label}`}
                  >
                    ×
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
