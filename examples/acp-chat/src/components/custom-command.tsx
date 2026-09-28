import { useState } from "react";

export function CustomCommand({
  disabled,
  busy,
  onRun,
}: {
  disabled?: boolean;
  busy?: boolean;
  onRun: (command: string) => void;
}) {
  const [value, setValue] = useState("");
  const trimmed = value.trim();
  const blocked = disabled === true || busy === true;

  const submit = (): void => {
    if (trimmed.length === 0 || blocked) {
      return;
    }
    onRun(trimmed);
  };

  return (
    <form
      className="custom-command"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <h2>Custom command</h2>
      <input
        type="text"
        value={value}
        placeholder="e.g. codebuddy --acp"
        disabled={blocked}
        onChange={(event) => setValue(event.target.value)}
      />
      <button type="submit" disabled={blocked || trimmed.length === 0}>
        Run
      </button>
      <p className="muted small">
        Runs any command that resolves on PATH as a temporary agent (like <code>acpx --agent</code>
        ).
      </p>
    </form>
  );
}
