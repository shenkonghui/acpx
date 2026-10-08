import { useMemo, useState } from "react";
import { useRegistry } from "../hooks/use-registry.js";
import type { RegistryInstallMethod } from "../types.js";

type MethodChoice = "auto" | RegistryInstallMethod;

const METHOD_CHOICES: MethodChoice[] = ["auto", "binary", "npx", "uvx"];

/** "Add Provider"-style catalog of installable ACP registry agents. */
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
      <div className="registry-controls">
        <label>
          <span>安装方式</span>
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
          <span>别名</span>
          <input
            type="text"
            value={asName}
            placeholder="（agent id）"
            disabled={installing}
            onChange={(event) => setAsName(event.target.value)}
          />
        </label>
      </div>

      <div className="settings-search">
        <input
          type="text"
          value={filter}
          placeholder="搜索 provider…"
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>

      {registry.error ? <p className="error-inline">{registry.error}</p> : null}
      {registry.installError ? (
        <p className="error-inline" role="alert">
          {registry.installError}{" "}
          <button type="button" className="button-outline" onClick={registry.dismissInstallError}>
            关闭
          </button>
        </p>
      ) : null}
      {registry.warnings.length > 0 ? (
        <div className="error-inline" role="status">
          <ul>
            {registry.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
          <button type="button" className="button-outline" onClick={registry.dismissWarnings}>
            关闭
          </button>
        </div>
      ) : null}

      {registry.loading ? (
        <p className="muted small">正在加载 registry…</p>
      ) : (
        <ul className="settings-group">
          {visibleAgents.map((agent) => {
            const busy = registry.installingId === agent.id;
            const initial = agent.name.charAt(0).toUpperCase() || "?";
            return (
              <li className="settings-row" key={agent.id}>
                <div className="settings-row-body">
                  <span className="row-avatar" aria-hidden="true">
                    {initial}
                  </span>
                  <span className="row-main">
                    <span className="row-title">
                      {agent.name}
                      <span className="row-title-meta">{agent.version}</span>
                      {agent.installed ? <span className="tag tag-installed">已安装</span> : null}
                    </span>
                    {agent.description ? (
                      <span className="row-desc">{agent.description}</span>
                    ) : null}
                    <span className="registry-methods">
                      {agent.methods.length > 0 ? (
                        agent.methods.map((entry) => (
                          <span className="tag" key={entry}>
                            {entry}
                          </span>
                        ))
                      ) : (
                        <span className="tag tag-missing">不支持</span>
                      )}
                    </span>
                  </span>
                  <span className="row-actions">
                    <button
                      type="button"
                      className={agent.installed ? "button-outline" : "button-primary"}
                      disabled={installing || (!agent.installed && !agent.installable)}
                      onClick={() => runInstall(agent.id)}
                      title={`registry id: ${agent.id}`}
                    >
                      {busy ? "安装中…" : agent.installed ? "重新安装" : "安装"}
                    </button>
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
