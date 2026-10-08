import { useState } from "react";
import type { ReactNode } from "react";

export function Composer({
  disabled,
  busy,
  onSend,
  onCancel,
  toolbar,
  extra,
  placeholder,
}: {
  disabled: boolean;
  busy: boolean;
  onSend: (text: string) => boolean;
  onCancel: () => void;
  /** Chips rendered at the left of the toolbar (agent, model, …). */
  toolbar?: ReactNode;
  /** Extra panel toggled by the "+" button (e.g. ad-hoc command runner). */
  extra?: ReactNode;
  placeholder?: string;
}) {
  const [text, setText] = useState("");
  const [extraOpen, setExtraOpen] = useState(false);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled || busy) {
      return;
    }
    if (onSend(trimmed)) {
      setText("");
    }
  };

  return (
    <div className="composer-wrap">
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {extra && extraOpen ? <div className="composer-command-host">{extra}</div> : null}
        <textarea
          className="composer-input"
          value={text}
          placeholder={
            placeholder ?? (disabled ? "选择一个 agent 开始对话" : "输入 prompt（Enter 发送）")
          }
          disabled={disabled}
          rows={2}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className="composer-toolbar">
          {extra ? (
            <button
              type="button"
              className="composer-plus"
              title="运行临时命令"
              aria-label="运行临时命令"
              aria-expanded={extraOpen}
              onClick={() => setExtraOpen((value) => !value)}
            >
              +
            </button>
          ) : null}
          {toolbar}
          <span className="composer-spacer" />
          {busy ? (
            <button
              type="button"
              className="composer-stop"
              title="停止当前运行"
              aria-label="停止当前运行"
              onClick={onCancel}
            >
              ■
            </button>
          ) : (
            <button
              type="submit"
              className="composer-send"
              title="发送（Enter）"
              aria-label="发送 prompt"
              disabled={disabled || !text.trim()}
            >
              ↓
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
