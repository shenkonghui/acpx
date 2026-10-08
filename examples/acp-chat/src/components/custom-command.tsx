import { useState } from "react";

/** Compact ad-hoc command runner, shown inside the composer's "+" panel. */
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
    setValue("");
  };

  return (
    <form
      className="composer-command"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <input
        type="text"
        value={value}
        placeholder="以临时 agent 运行命令，例如 codebuddy --acp"
        disabled={blocked}
        onChange={(event) => setValue(event.target.value)}
      />
      <button type="submit" className="button-primary" disabled={blocked || trimmed.length === 0}>
        运行
      </button>
    </form>
  );
}
