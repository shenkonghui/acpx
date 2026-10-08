/** Splits a command line into argv, honouring single/double quotes and backslashes. */
export function splitArgv(input: string): string[] {
  const argv: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quote === null && (char === " " || char === "\t")) {
      if (started) {
        argv.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    if (char === "\\" && quote !== "'" && index + 1 < input.length) {
      current += input[index + 1];
      started = true;
      index += 1;
      continue;
    }
    if (quote === null && (char === '"' || char === "'")) {
      quote = char;
      started = true;
      continue;
    }
    if (quote === char) {
      quote = null;
      continue;
    }
    current += char;
    started = true;
  }

  if (quote !== null) {
    throw new Error(`Unterminated ${quote === '"' ? "double" : "single"} quote`);
  }
  if (started) {
    argv.push(current);
  }
  return argv;
}

const SAFE_ARG = /^[A-Za-z0-9_@%+=:,./^~-]+$/u;

/** Renders argv as a command line, quoting arguments that need it. */
export function joinArgv(argv: readonly string[]): string {
  return argv
    .map((arg) => (arg.length > 0 && SAFE_ARG.test(arg) ? arg : JSON.stringify(arg)))
    .join(" ");
}
