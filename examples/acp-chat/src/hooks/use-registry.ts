import { useCallback, useEffect, useState } from "react";
import type {
  RegistryAgentSummary,
  RegistryInstallMethod,
  RegistryInstallResult,
} from "../types.js";

export type RegistryInstallOptions = {
  method?: RegistryInstallMethod;
  asName?: string;
  force?: boolean;
};

export type RegistryState = {
  agents: RegistryAgentSummary[];
  loading: boolean;
  error?: string;
  reload: () => void;
  install: (id: string, options?: RegistryInstallOptions) => Promise<RegistryInstallResult>;
  installingId?: string;
  installError?: string;
  warnings: string[];
  dismissInstallError: () => void;
  dismissWarnings: () => void;
};

export function useRegistry(onInstalled?: () => void): RegistryState {
  const [agents, setAgents] = useState<RegistryAgentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [reloadToken, setReloadToken] = useState(0);
  const [installingId, setInstallingId] = useState<string | undefined>(undefined);
  const [installError, setInstallError] = useState<string | undefined>(undefined);
  const [warnings, setWarnings] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const response = await fetch("/api/registry");
        if (!response.ok) {
          throw new Error(`加载 ACP registry 失败：${response.status}`);
        }
        const payload = (await response.json()) as { agents: RegistryAgentSummary[] };
        if (!cancelled) {
          setAgents(payload.agents);
          setError(undefined);
        }
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);
  const dismissInstallError = useCallback(() => setInstallError(undefined), []);
  const dismissWarnings = useCallback(() => setWarnings([]), []);

  const install = useCallback(
    async (id: string, options: RegistryInstallOptions = {}) => {
      setInstallingId(id);
      setInstallError(undefined);
      try {
        const response = await fetch("/api/registry/install", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, ...options }),
        });
        const payload = (await response.json().catch(() => undefined)) as
          | { result?: RegistryInstallResult; error?: { message?: string } }
          | undefined;
        if (!response.ok || !payload?.result) {
          throw new Error(payload?.error?.message ?? `安装失败：${response.status}`);
        }
        setWarnings(payload.result.warnings);
        setReloadToken((token) => token + 1);
        onInstalled?.();
        return payload.result;
      } catch (caught) {
        setInstallError(caught instanceof Error ? caught.message : String(caught));
        throw caught;
      } finally {
        setInstallingId(undefined);
      }
    },
    [onInstalled],
  );

  return {
    agents,
    loading,
    ...(error !== undefined ? { error } : {}),
    reload,
    install,
    ...(installingId !== undefined ? { installingId } : {}),
    ...(installError !== undefined ? { installError } : {}),
    warnings,
    dismissInstallError,
    dismissWarnings,
  };
}
