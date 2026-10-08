import { useCallback, useEffect, useState } from "react";
import type { AgentSummary } from "../types.js";

export type AgentCatalogState = {
  agents: AgentSummary[];
  loading: boolean;
  error?: string;
  reload: () => void;
};

export function useAgentCatalog(): AgentCatalogState {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const response = await fetch("/api/agents");
        if (!response.ok) {
          throw new Error(`加载 agent 列表失败：${response.status}`);
        }
        const payload = (await response.json()) as { agents: AgentSummary[] };
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

  return { agents, loading, error, reload };
}
