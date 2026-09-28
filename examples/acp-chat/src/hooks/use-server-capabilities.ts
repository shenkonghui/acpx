import { useEffect, useState } from "react";
import type { ChatServerCapabilities } from "../types.js";

/**
 * Reads the server's advertised capabilities from `/api/health`. Returns undefined
 * until the first successful response so callers can avoid showing disabled features.
 */
export function useServerCapabilities(): ChatServerCapabilities | undefined {
  const [capabilities, setCapabilities] = useState<ChatServerCapabilities | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/health");
        if (!response.ok) {
          return;
        }
        const payload = (await response.json()) as { capabilities?: ChatServerCapabilities };
        if (!cancelled && payload.capabilities) {
          setCapabilities(payload.capabilities);
        }
      } catch {
        // Leave capabilities undefined; the page still works read-only.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return capabilities;
}
