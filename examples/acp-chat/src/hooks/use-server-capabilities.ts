import { useEffect, useState } from "react";
import type { ChatServerCapabilities, ChatHealthResponse } from "../types.js";

export type ServerInfo = {
  capabilities: ChatServerCapabilities;
  cwd: string;
  permissionMode: string;
};

/**
 * Reads `/api/health` for the feature switches plus the server default cwd and
 * permission mode. Returns undefined until the first successful response.
 */
export function useServerCapabilities(): ServerInfo | undefined {
  const [info, setInfo] = useState<ServerInfo | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/health");
        if (!response.ok) {
          return;
        }
        const payload = (await response.json()) as ChatHealthResponse;
        if (!cancelled && payload.capabilities) {
          setInfo({
            capabilities: payload.capabilities,
            cwd: payload.cwd,
            permissionMode: payload.permissionMode,
          });
        }
      } catch {
        // Leave info undefined; the page still works read-only.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return info;
}
