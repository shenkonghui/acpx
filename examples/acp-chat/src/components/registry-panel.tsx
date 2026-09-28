import { useMemo, useState } from "react";
import { useRegistry } from "../hooks/use-registry.js";
import type { RegistryInstallMethod } from "../types.js";

type MethodChoice = "auto" | RegistryInstallMethod;

const METHOD_CHOICES: MethodChoice[] = ["auto", "binary", "npx", "uvx"];

export function RegistryPanel({ onInstalled }: { onInstalled?: () => void }) {
  const registry = useRegistry(onInstalled);
  const [method, setMethod] = useState<MethodChoice>("auto");
  const [asName, setAsName] = useState("");
  const [filter, setFilter] = useState("");

  const visibleAgents = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle.length === 0) {
      return registry.agents;
    }
    return registry.agents.filter((agent) =>
      `${agent.id} ${agent.name}`.toLowerCase().includes(needle),
    );
  }, [registry.agents, filter]);

  const installing = registry.installingId !== undefined;

  const runInstall = (id: string): void => {
    const alias = asName.trim();
    void registry
      .install(id, {
        ...(method === "auto" ? {} : { method }),
        ...(alias ? { asName: alias } : {}),
      })
      .catch(() => {
        // Surfaced through registry.installError.
      });
  };

  return (
    <section className="registry-panel">
      <h2>ACP registry</h2>

      <div className="registry-controls">
        <label>
          <span>method</span>
          <select
            value={method}
            disabled={installing}
            onChange={(event) => setMethod(event.target.value as MethodChoice)}
          >
            {METHOD_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {choice}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>alias</span>
          <input
            type="text"
            value={asName}
            placeholder="(agent id)"
            disabled={installing}
            onChange={(event) => setAsName(event.target.value)}
          />
        </label>
      </div>

      <input
        className="registry-filter"
        type="text"
        value={filter}
        placeholder="Filter registry…"
        onChange={(event) => setFilter(event.target.value)}
      />

      {registry.error ? <p className="error-inline">{registry.error}</p> : null}
      {registry.installError ? (
        <p className="error-inline" role="alert">
          {registry.installError}{" "}
          <button type="button" onClick={registry.dismissInstallError}>
            Dismiss
          </button>
        </p>
      ) : null}
      {registry.warnings.length > 0 ? (
        <div className="registry-warnings" role="status">
          <ul>
            {registry.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
          <button type="button" onClick={registry.dismissWarnings}>
            Dismiss
          </button>
        </div>
      ) : null}

      {registry.loading ? (
        <p className="muted">Loading registry…</p>
      ) : (
        <ul className="registry-list">
          {visibleAgents.map((agent) => {
            const busy = registry.installingId === agent.id;
            return (
              <li key={agent.id}>
                <div className="registry-line">
                  <span className="agent-name">{agent.name}</span>
                  <span className="tag">{agent.version}</span>
                </div>
                <div className="registry-line">
                  {agent.methods.length > 0 ? (
                    agent.methods.map((entry) => (
                      <span className="tag" key={entry}>
                        {entry}
                      </span>
                    ))
                  ) : (
                    <span className="tag tag-missing">unsupported</span>
                  )}
                  {agent.installed ? <span className="tag tag-installed">installed</span> : null}
                  <button
                    type="button"
                    disabled={installing || (!agent.installed && !agent.installable)}
                    onClick={() => runInstall(agent.id)}
                    title={`registry id: ${agent.id}`}
                  >
                    {busy ? "Installing…" : agent.installed ? "Reinstall" : "Install"}
                  </button>
                </div>
                {agent.description ? <p className="muted small">{agent.description}</p> : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
