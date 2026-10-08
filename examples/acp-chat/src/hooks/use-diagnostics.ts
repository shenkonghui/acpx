import { useCallback, useEffect, useState } from "react";
import type { DiagnosticsRun } from "../types.js";

/**
 * Drives the one-click agent diagnostics: POST starts a run, then the latest
 * run snapshot is polled every 1.5s while it is in progress.
 */
export function useDiagnostics() {
  const [run, setRun] = useState<DiagnosticsRun | undefined>(undefined);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const running = run !== undefined && run.finishedAt === undefined;

  useEffect(() => {
    if (!running) {
      return undefined;
    }
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const response = await fetch("/api/diagnostics");
        if (!response.ok) {
          return;
        }
        const payload = (await response.json()) as { run: DiagnosticsRun | null };
        if (!cancelled) {
          setRun(payload.run ?? undefined);
        }
      } catch {
        // Keep the last snapshot; the next tick retries.
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [running]);

  const start = useCallback(async (agents: readonly { name: string; argv?: string[] }[]) => {
    setStarting(true);
    setError(undefined);
    try {
      const response = await fetch("/api/diagnostics", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agents: agents.map(({ name, argv }) => ({ name, ...(argv ? { argv } : {}) })),
        }),
      });
      const payload = (await response.json()) as {
        run?: DiagnosticsRun;
        error?: { message?: string };
      };
      if (!response.ok) {
        throw new Error(payload.error?.message ?? "无法启动诊断");
      }
      if (payload.run) {
        setRun(payload.run);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }, []);

  return { run, running, starting, error, start };
}
