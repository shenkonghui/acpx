import { useCallback, useEffect, useState } from "react";
import type { SettingsView } from "../types.js";

export type SettingsSaveInput =
  | {
      action: "upsert";
      name: string;
      enabled?: boolean;
      argv?: string[];
      env?: Record<string, string> | null;
      /** null/empty clears the list (all models allowed). */
      enabledModels?: string[] | null;
    }
  | { action: "remove"; name: string };

export type SettingsState = {
  view?: SettingsView;
  loading: boolean;
  error?: string;
  saving: boolean;
  reload: () => void;
  save: (input: SettingsSaveInput) => Promise<boolean>;
};

export function useSettings(enabled: boolean): SettingsState {
  const [view, setView] = useState<SettingsView | undefined>(undefined);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (enabled) {
      setLoading(true);
      void (async () => {
        try {
          const response = await fetch("/api/settings");
          if (!response.ok) {
            throw new Error(`加载设置失败：${response.status}`);
          }
          const payload = (await response.json()) as SettingsView;
          if (!cancelled) {
            setView(payload);
            setError(undefined);
          }
        } catch (caught) {
          if (!cancelled) {
            setError(errorMessage(caught));
          }
        } finally {
          if (!cancelled) {
            setLoading(false);
          }
        }
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [enabled, reloadToken]);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  const save = useCallback(
    async (input: SettingsSaveInput): Promise<boolean> => {
      setSaving(true);
      try {
        const request =
          input.action === "remove"
            ? { path: "/api/settings/agents/remove", body: { name: input.name } }
            : {
                path: "/api/settings/agents",
                body: {
                  name: input.name,
                  ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
                  ...(input.argv !== undefined ? { argv: input.argv } : {}),
                  ...(input.env !== undefined ? { env: input.env } : {}),
                  ...(input.enabledModels !== undefined
                    ? { enabledModels: input.enabledModels }
                    : {}),
                },
              };
        const response = await fetch(request.path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request.body),
        });
        if (!response.ok) {
          const payload = (await response.json().catch(() => undefined)) as
            | { error?: { message?: string } }
            | undefined;
          throw new Error(payload?.error?.message ?? `请求失败：${response.status}`);
        }
        setError(undefined);
        reload();
        return true;
      } catch (caught) {
        setError(errorMessage(caught));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [reload],
  );

  return { view, loading, error, saving, reload, save };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
