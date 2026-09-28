import { AcpxOperationalError } from "../errors.js";
import { parseAcpRegistry, resolveRegistryUrl, type AcpRegistry } from "./types.js";

export const DEFAULT_REGISTRY_TIMEOUT_MS = 30_000;

export type LoadRegistryOptions = {
  url?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export async function loadAcpRegistry(options: LoadRegistryOptions = {}): Promise<AcpRegistry> {
  const url = resolveRegistryUrl(options.url);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REGISTRY_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        signal: controller.signal,
        headers: { accept: "application/json" },
        redirect: "follow",
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new AcpxOperationalError(
          `Timed out fetching ACP registry from ${url} after ${timeoutMs}ms`,
          {
            origin: "cli",
            detailCode: "REGISTRY_FETCH_TIMEOUT",
            retryable: true,
          },
        );
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new AcpxOperationalError(`Failed to fetch ACP registry from ${url}: ${reason}`, {
        origin: "cli",
        detailCode: "REGISTRY_FETCH_FAILED",
        retryable: true,
        cause: error,
      });
    }

    if (!response.ok) {
      throw new AcpxOperationalError(
        `Failed to fetch ACP registry from ${url}: HTTP ${response.status} ${response.statusText}`.trim(),
        {
          origin: "cli",
          detailCode: "REGISTRY_FETCH_FAILED",
          retryable: true,
        },
      );
    }

    const payload = await response.text();
    return parseAcpRegistry(payload);
  } finally {
    clearTimeout(timer);
  }
}
