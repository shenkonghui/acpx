import { useState } from "react";

export function Composer({
  disabled,
  busy,
  onSend,
  onCancel,
}: {
  disabled: boolean;
  busy: boolean;
  onSend: (text: string) => boolean;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");

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
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <textarea
        className="composer-input"
        value={text}
        placeholder={
          disabled ? "Select an agent to start chatting" : "Send a prompt (Enter to send)"
        }
        disabled={disabled}
        rows={3}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="composer-actions">
        <button
          type="submit"
          className="button-primary"
          disabled={disabled || busy || !text.trim()}
        >
          Send
        </button>
        <button type="button" onClick={onCancel} disabled={!busy}>
          Stop
        </button>
      </div>
    </form>
  );
}
