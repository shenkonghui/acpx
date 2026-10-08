import { useCallback, useEffect, useMemo, useState } from "react";
import { useDiagnostics } from "../hooks/use-diagnostics.js";
import type { SettingsState, SettingsSaveInput } from "../hooks/use-settings.js";
import { joinArgv, splitArgv } from "../lib/argv.js";
import type {
  AgentDiagnostic,
  DiagnosticPhaseStatus,
  ModelProbeResponse,
  SettingsAgent,
  SettingsAgentSource,
} from "../types.js";
import { RegistryPanel } from "./registry-panel.js";

const SOURCE_LABELS: Record<SettingsAgentSource, string> = {
  config: "配置",
  "gateway-config": "网关",
  "built-in": "内置",
};

const AVAILABILITY_LABELS: Record<SettingsAgent["availability"], string> = {
  installed: "已安装",
  missing: "缺失",
  unknown: "未知",
};

export function SettingsView({
  settings,
  disabled,
  showRegistry,
  onAgentInstalled,
}: {
  settings: SettingsState;
  disabled?: boolean;
  showRegistry?: boolean;
  onAgentInstalled?: () => void;
}) {
  const [filter, setFilter] = useState("");
  const view = settings.view;

  const visible = useMemo(() => {
    const agents = view?.agents ?? [];
    const needle = filter.trim().toLowerCase();
    if (needle.length === 0) {
      return agents;
    }
    return agents.filter(
      (agent) =>
        agent.name.toLowerCase().includes(needle) ||
        joinArgv(agent.argv).toLowerCase().includes(needle),
    );
  }, [view, filter]);

  if (!view) {
    return (
      <div className="settings-panel">
        {settings.loading ? (
          <p className="muted">正在加载设置…</p>
        ) : (
          <p className="error-inline">{settings.error ?? "设置不可用。"}</p>
        )}
      </div>
    );
  }

  const writable = view.writable && !disabled;
  const configured = visible.filter((agent) => agent.hasConfigEntry);
  const searching = filter.trim().length > 0;
  // The enable-models editor is a standalone section for gateway agents only.
  const gatewayAgents = (view?.agents ?? []).filter((agent) => agent.isGateway);

  // Mirrors the visible list (configured agents only): built-ins without a
  // config entry default to enabled but are not managed or shown here.
  const testable = view.agents.filter(
    (agent) => agent.hasConfigEntry && agent.availability === "installed" && agent.enabled,
  );
  const diagnostics = useDiagnostics();

  return (
    <div className="settings-panel">
      <h2 className="settings-title">Agent 列表</h2>
      <p className="settings-subtitle">
        在 <span className="mono">{view.globalPath}</span> 中有配置项的 agent
        会列在这里，并且可以完整编辑。新增 agent 请从 ACP registry 安装。
        {writable ? null : (
          <> {view.writable ? "编辑功能已禁用。" : "编辑功能已禁用（--no-settings）。"}</>
        )}
      </p>

      <div className="settings-search">
        <input
          type="text"
          value={filter}
          placeholder="搜索 agent…"
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>

      {settings.error ? (
        <p className="error-inline" role="alert">
          {settings.error}
        </p>
      ) : null}

      <ul className="settings-group">
        {configured.map((agent) => (
          <SettingsRow
            key={agent.name}
            agent={agent}
            saving={settings.saving}
            disabled={!writable}
            onSave={settings.save}
          />
        ))}
        {configured.length === 0 ? (
          <li className="settings-row">
            <div className="settings-row-body">
              <span className="row-main">
                <span className="row-desc">
                  {searching ? "没有匹配的已配置 agent" : "尚未配置任何 agent"}
                  ——可从 ACP registry 安装。
                </span>
              </span>
            </div>
          </li>
        ) : null}
      </ul>

      {gatewayAgents.length > 0 ? (
        <>
          <h2 className="settings-title">网关模型</h2>
          <p className="settings-subtitle">
            只针对网关
            agent（acpx-gateway）设置启用模型：探测会合并网关下所有后端的模型，勾选保存后，聊天页的模型选择器只显示已启用的模型；不勾选
            = 全部可用。
          </p>
          {gatewayAgents.map((agent) => (
            <ModelSelector
              key={agent.name}
              agent={agent}
              saving={settings.saving}
              disabled={!writable}
              onSave={settings.save}
            />
          ))}
        </>
      ) : null}

      <h2 className="settings-title">诊断</h2>
      <p className="settings-subtitle">
        一键在隔离会话中测试每个已启用的 agent：初始化（启动进程 + ACP 握手）、模型列表，以及 ping
        往返。
      </p>
      <div className="diag-header">
        <button
          type="button"
          className="button-primary"
          disabled={diagnostics.starting || diagnostics.running || testable.length === 0}
          onClick={() =>
            void diagnostics.start(
              testable.map((agent) => ({ name: agent.name, argv: agent.argv })),
            )
          }
        >
          {diagnostics.running
            ? "测试中…"
            : diagnostics.starting
              ? "启动中…"
              : `测试已启用的 agent（${testable.length}）`}
        </button>
        {diagnostics.error ? <span className="error-inline">{diagnostics.error}</span> : null}
        {diagnostics.run?.finishedAt !== undefined ? (
          <span className="muted small">
            {diagnostics.run.agents.filter((agent) => agent.ping.status === "ok").length}/
            {diagnostics.run.agents.length} 个正常，耗时{" "}
            {((diagnostics.run.finishedAt - diagnostics.run.startedAt) / 1000).toFixed(1)}s
          </span>
        ) : null}
      </div>
      {diagnostics.run && diagnostics.run.agents.length > 0 ? (
        <ul className="settings-group">
          {diagnostics.run.agents.map((agent) => (
            <AgentDiagnosticRow key={agent.name} agent={agent} />
          ))}
        </ul>
      ) : null}

      {showRegistry ? (
        <>
          <h2 className="settings-title">从 ACP registry 添加</h2>
          <p className="settings-subtitle">
            从官方 registry 安装 agent。安装会写入 <span className="mono">agents.&lt;name&gt;</span>{" "}
            配置项，安装后立即可选。
          </p>
          <RegistryPanel onInstalled={onAgentInstalled} />
        </>
      ) : null}
    </div>
  );
}

function SettingsRow({
  agent,
  saving,
  disabled,
  onSave,
}: {
  agent: SettingsAgent;
  saving: boolean;
  disabled: boolean;
  onSave: (input: SettingsSaveInput) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [argvText, setArgvText] = useState(() => joinArgv(agent.argv));
  const [envText, setEnvText] = useState(() => formatEnv(agent.env));
  const [localError, setLocalError] = useState<string | undefined>(undefined);

  useEffect(() => {
    setArgvText(joinArgv(agent.argv));
    setEnvText(formatEnv(agent.env));
  }, [agent.argv, agent.env]);

  // Gateway rows (acpx-gateway, gateway-config backends) default to always-on:
  // the enable switch and remove button are locked, but argv editing stays open.
  const locked = disabled || saving || !agent.writable || agent.isGateway;
  const editable = disabled || saving || !agent.writable;

  const toggleEnabled = (): void => {
    void onSave({ action: "upsert", name: agent.name, enabled: !agent.enabled });
  };

  const save = async (): Promise<void> => {
    setLocalError(undefined);
    let argv: string[];
    try {
      argv = splitArgv(argvText);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
      return;
    }
    if (argv.length === 0) {
      setLocalError("命令不能为空。");
      return;
    }
    const env = parseEnv(envText);
    if (typeof env === "string") {
      setLocalError(env);
      return;
    }
    const ok = await onSave({
      action: "upsert",
      name: agent.name,
      argv,
      env: Object.keys(env).length > 0 ? env : null,
    });
    if (ok) {
      setEditing(false);
    }
  };

  const reset = async (): Promise<void> => {
    if (!agent.defaultArgv) {
      return;
    }
    const ok = await onSave({
      action: "upsert",
      name: agent.name,
      argv: [...agent.defaultArgv],
      env: null,
    });
    if (ok) {
      setEditing(false);
    }
  };

  const remove = async (): Promise<void> => {
    await onSave({ action: "remove", name: agent.name });
  };

  const initial = agent.name.charAt(0).toUpperCase() || "?";

  return (
    <li className="settings-row">
      <div className="settings-row-body">
        <span className={`row-avatar${agent.enabled ? "" : " row-avatar-off"}`} aria-hidden="true">
          {initial}
        </span>
        <span className="row-main">
          <span className="row-title">
            {agent.name}
            <span className="row-title-meta">{SOURCE_LABELS[agent.source]}</span>
            {agent.isDefault ? <span className="row-title-meta">· 默认</span> : null}
            {agent.isGateway ? (
              <span className="row-title-meta">· 网关进程，不可停用</span>
            ) : agent.writable ? null : (
              <span className="row-title-meta">· 只读</span>
            )}
          </span>
          <span className="row-desc mono">{joinArgv(agent.argv) || "—"}</span>
          <span className="row-title">
            <span
              className={`availability-dot availability-${agent.availability}`}
              aria-hidden="true"
            />
            <span className="row-title-meta">
              {AVAILABILITY_LABELS[agent.availability]}
              {agent.hasConfigEntry && !agent.enabled ? " · 已停用" : ""}
            </span>
          </span>
        </span>
        <span className="row-actions">
          {agent.hasConfigEntry ? (
            <>
              <button
                type="button"
                role="switch"
                aria-checked={agent.enabled}
                aria-label={`${agent.enabled ? "停用" : "启用"} ${agent.name}`}
                className={`switch${agent.enabled ? " on" : ""}`}
                disabled={locked}
                title={agent.isGateway ? "网关 agent 默认不允许停用" : undefined}
                onClick={toggleEnabled}
              />
              <button
                type="button"
                className="button-outline"
                disabled={editable}
                onClick={() => setEditing((value) => !value)}
              >
                {editing ? "收起" : "编辑"}
              </button>
              <button
                type="button"
                className="button-danger"
                disabled={locked}
                title={agent.isGateway ? "网关 agent 默认不允许移除" : undefined}
                onClick={remove}
              >
                移除
              </button>
            </>
          ) : null}
        </span>
      </div>

      {editing ? (
        <div className="settings-editor">
          <label>
            <span>命令</span>
            <input
              type="text"
              value={argvText}
              disabled={saving}
              onChange={(event) => setArgvText(event.target.value)}
            />
          </label>
          <label>
            <span>环境变量（每行 KEY=VALUE）</span>
            <textarea
              rows={3}
              value={envText}
              disabled={saving}
              onChange={(event) => setEnvText(event.target.value)}
            />
          </label>
          {localError ? <p className="error-inline">{localError}</p> : null}
          <div className="settings-editor-actions">
            <button
              type="button"
              className="button-primary"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? "保存中…" : "保存"}
            </button>
            {agent.defaultArgv ? (
              <button
                type="button"
                className="button-outline"
                disabled={saving}
                onClick={() => void reset()}
              >
                恢复默认
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

type ProbeState = {
  loading: boolean;
  models: Array<{ modelId: string; name: string }>;
  isGateway: boolean;
  error?: string;
};

/**
 * Filterable multi-select over the agent's advertised models. An empty
 * selection means every model is allowed; the choice persists as the agent's
 * `enabledModels` config entry and narrows the chat model picker.
 */
function ModelSelector({
  agent,
  saving,
  disabled,
  onSave,
}: {
  agent: SettingsAgent;
  saving: boolean;
  disabled: boolean;
  onSave: (input: SettingsSaveInput) => Promise<boolean>;
}) {
  const [probe, setProbe] = useState<ProbeState>({ loading: true, models: [], isGateway: false });
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set(agent.enabledModels ?? []));

  const loadModels = useCallback(
    async (signal: AbortSignal): Promise<void> => {
      setProbe({ loading: true, models: [], isGateway: false });
      try {
        const response = await fetch(
          `/api/settings/models?agent=${encodeURIComponent(agent.name)}`,
          { signal },
        );
        const payload = (await response.json().catch(() => undefined)) as
          | ModelProbeResponse
          | undefined;
        if (!response.ok) {
          throw new Error(payload?.error?.message ?? `探测失败：${response.status}`);
        }
        setProbe({
          loading: false,
          models: payload?.models ?? [],
          isGateway: payload?.isGateway === true,
        });
      } catch (caught) {
        if (signal.aborted) {
          return;
        }
        setProbe({
          loading: false,
          models: [],
          isGateway: false,
          error: caught instanceof Error ? caught.message : String(caught),
        });
      }
    },
    [agent.name],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadModels(controller.signal);
    return () => controller.abort();
  }, [loadModels]);

  const needle = filter.trim().toLowerCase();
  const visibleModels = useMemo(() => {
    if (needle.length === 0) {
      return probe.models;
    }
    return probe.models.filter(
      (model) =>
        model.name.toLowerCase().includes(needle) || model.modelId.toLowerCase().includes(needle),
    );
  }, [probe.models, needle]);

  const toggle = (modelId: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(modelId)) {
        next.delete(modelId);
      } else {
        next.add(modelId);
      }
      return next;
    });
  };

  const saveModels = async (models: string[] | null): Promise<void> => {
    await onSave({ action: "upsert", name: agent.name, enabledModels: models });
  };

  return (
    <div className="model-selector">
      <span>
        {agent.name}
        {probe.isGateway ? " · 已合并网关各后端模型" : ""}
      </span>
      <div className="model-selector-bar">
        <input
          type="text"
          className="model-selector-filter"
          placeholder="筛选模型…"
          value={filter}
          disabled={disabled}
          onChange={(event) => setFilter(event.target.value)}
        />
        {probe.loading ? (
          <span className="muted small">探测中…</span>
        ) : (
          <button
            type="button"
            className="button-outline small"
            disabled={disabled || saving}
            onClick={() => {
              const controller = new AbortController();
              void loadModels(controller.signal);
            }}
          >
            重新探测
          </button>
        )}
      </div>
      {probe.error ? <p className="error-inline">{probe.error}</p> : null}
      {!probe.loading && !probe.error && probe.models.length === 0 ? (
        <p className="muted small">该 agent 未上报任何模型。</p>
      ) : null}
      {visibleModels.length > 0 ? (
        <ul className="model-selector-list">
          {visibleModels.map((model) => (
            <li key={model.modelId}>
              <label className="model-selector-item">
                <input
                  type="checkbox"
                  checked={selected.has(model.modelId)}
                  disabled={disabled}
                  onChange={() => toggle(model.modelId)}
                />
                <span className="model-selector-name">{model.name}</span>
                {model.modelId !== model.name ? (
                  <span className="model-selector-id mono">{model.modelId}</span>
                ) : null}
              </label>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="model-selector-actions">
        <span className="muted small">
          已选 {selected.size}/{probe.models.length}
        </span>
        <button
          type="button"
          className="button-outline"
          disabled={disabled || saving || probe.loading || selected.size === 0}
          onClick={() => setSelected(new Set())}
        >
          全部启用
        </button>
        <button
          type="button"
          className="button-primary"
          disabled={disabled || saving || probe.loading}
          onClick={() => void saveModels(selected.size > 0 ? [...selected] : null)}
        >
          {saving ? "保存中…" : "保存模型"}
        </button>
      </div>
    </div>
  );
}

function AgentDiagnosticRow({ agent }: { agent: AgentDiagnostic }) {
  const firstError = agent.init.error ?? agent.models.error ?? agent.ping.error ?? undefined;
  const initial = agent.name.charAt(0).toUpperCase() || "?";
  return (
    <li className="settings-row">
      <div className="settings-row-body">
        <span className="row-avatar" aria-hidden="true">
          {initial}
        </span>
        <span className="row-main">
          <span className="row-title">
            {agent.name}
            {agent.isGateway ? <span className="row-title-meta">· 网关</span> : null}
          </span>
          {firstError ? (
            <span className="diag-error" title={firstError}>
              {firstError}
            </span>
          ) : null}
        </span>
        <span className="diag-cells">
          <DiagCell
            label="初始化"
            status={agent.init.status}
            text={agent.init.ms !== undefined ? `${agent.init.ms}ms` : undefined}
            detail={agent.init.error}
          />
          <DiagCell
            label="模型"
            status={agent.models.status}
            text={
              agent.models.names.length > 0
                ? `${agent.models.names.length} (${agent.models.names.slice(0, 3).join(", ")})`
                : agent.models.status === "ok"
                  ? "无"
                  : undefined
            }
            detail={agent.models.error}
          />
          <DiagCell
            label="ping"
            status={agent.ping.status}
            text={
              agent.ping.ms !== undefined
                ? `${agent.ping.ms}ms${agent.ping.reply ? ` · ${truncate(agent.ping.reply, 60)}` : ""}`
                : undefined
            }
            detail={agent.ping.error}
          />
        </span>
      </div>
      {agent.backends && agent.backends.length > 0 ? (
        <div className="diag-backends">
          {agent.backends.map((backend) => (
            <div key={backend.name} className="diag-backend">
              <span className="diag-backend-name mono" title={backend.name}>
                {backend.name}
              </span>
              <span className={`diag-value diag-${backend.status}`}>
                {backend.status === "ok"
                  ? `✓ ${backend.names.length} 个模型${
                      backend.names.length > 0 ? ` · ${backend.names.slice(0, 3).join(", ")}` : ""
                    }`
                  : backend.status === "failed"
                    ? `✗ ${backend.error ?? "失败"}`
                    : backend.status === "running"
                      ? "…"
                      : "–"}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </li>
  );
}

function DiagCell({
  label,
  status,
  text,
  detail,
}: {
  label: string;
  status: DiagnosticPhaseStatus;
  text?: string;
  detail?: string;
}) {
  const markers: Record<DiagnosticPhaseStatus, string> = {
    pending: "–",
    running: "…",
    ok: "✓",
    failed: "✗",
    skipped: "–",
  };
  return (
    <span className={`diag-cell diag-${status}`} title={detail} data-status={status}>
      <span className="diag-label">{label}</span>
      <span className="diag-value">
        <span aria-hidden="true">{markers[status]}</span> {text ?? ""}
      </span>
    </span>
  );
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function formatEnv(env: Record<string, string> | undefined): string {
  return env
    ? Object.entries(env)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n")
    : "";
}

/** Returns the parsed env map, or an error message string. */
function parseEnv(text: string): Record<string, string> | string {
  const env: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const equals = line.indexOf("=");
    if (equals <= 0) {
      return `无效的环境变量行：${rawLine}`;
    }
    const key = line.slice(0, equals).trim();
    if (key.length === 0 || key.includes("=")) {
      return `无效的环境变量名：${key}`;
    }
    env[key] = line.slice(equals + 1);
  }
  return env;
}
