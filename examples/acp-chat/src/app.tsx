import { useEffect, useMemo, useRef, useState } from "react";
import { AgentSelect } from "./components/agent-select.js";
import { Composer } from "./components/composer.js";
import { ConversationView } from "./components/conversation-view.js";
import { CustomCommand } from "./components/custom-command.js";
import { DirectoryPicker } from "./components/directory-picker.js";
import { ErrorBanner } from "./components/error-banner.js";
import { ModelPicker } from "./components/model-picker.js";
import { SessionList, type SessionListItem } from "./components/session-list.js";
import { SettingsView } from "./components/settings-view.js";
import { StatusPanel } from "./components/status-panel.js";
import { useAgentCatalog } from "./hooks/use-agent-catalog.js";
import { useChatSocket } from "./hooks/use-chat-socket.js";
import { useServerCapabilities } from "./hooks/use-server-capabilities.js";
import { useSettings } from "./hooks/use-settings.js";
import type { AgentSummary, PermissionMode } from "./types.js";

export function App() {
  const { agents, loading, error: catalogError, reload } = useAgentCatalog();
  const {
    state,
    openChat,
    openCommand,
    send,
    cancel,
    closeChat,
    setModel,
    selectSession,
    dismissErrors,
  } = useChatSocket();
  const server = useServerCapabilities();
  const settingsEnabled = server?.capabilities.settings === true;
  const settings = useSettings(settingsEnabled);

  const [view, setView] = useState<"chat" | "settings">("chat");
  const [selectedAgentId, setSelectedAgentId] = useState<string | undefined>(undefined);
  const [cwdInput, setCwdInput] = useState("");
  const [chosenPermissionMode, setChosenPermissionMode] = useState<PermissionMode | undefined>(
    undefined,
  );
  const autoOpenedRef = useRef(false);

  const permissionMode: PermissionMode =
    chosenPermissionMode ?? (server?.permissionMode as PermissionMode | undefined) ?? "approve-all";

  const activeChatId = state.activeChatId;
  const active = activeChatId ? state.sessions[activeChatId] : undefined;
  const busy = active?.activeRequestId !== undefined;
  // True while `open_session` is in flight (first open, agent switch, or mode
  // change). Sending or switching again in that window races the server's
  // session replacement, so the controls stay disabled until `session_opened`.
  const opening = active?.opening === true;
  const locked = busy || opening;

  // The picker (and the auto-opened session) prefer agents with an explicit
  // entry; built-ins only step in when nothing is configured at all.
  const configuredAgents = useMemo(
    () =>
      agents.filter(
        (agent) =>
          agent.source === "config" ||
          agent.source === "gateway-config" ||
          agent.source === "ad-hoc",
      ),
    [agents],
  );
  const defaultAgent = useMemo(
    () =>
      configuredAgents.find((agent) => agent.isDefault && agent.availability !== "missing") ??
      configuredAgents.find((agent) => agent.availability !== "missing") ??
      agents.find((agent) => agent.isDefault && agent.availability !== "missing") ??
      agents.find((agent) => agent.availability !== "missing") ??
      agents[0],
    [agents, configuredAgents],
  );

  const sessionItems = useMemo<SessionListItem[]>(
    () =>
      state.order.flatMap((chatId) => {
        const session = state.sessions[chatId];
        if (!session) {
          return [];
        }
        return [
          {
            chatId,
            label: session.agent ?? session.command ?? chatId.slice(0, 8),
            ...(session.cwd ? { detail: session.cwd } : {}),
            ...(session.activeRequestId ? { running: true } : {}),
          },
        ];
      }),
    [state.order, state.sessions],
  );

  // Open one default session on first load when nothing was restored.
  useEffect(() => {
    if (
      autoOpenedRef.current ||
      view !== "chat" ||
      state.order.length > 0 ||
      agents.length === 0 ||
      !defaultAgent
    ) {
      return;
    }
    autoOpenedRef.current = true;
    setSelectedAgentId(defaultAgent.id);
    openChat(defaultAgent.id, {
      ...(cwdInput.trim() ? { cwd: cwdInput.trim() } : {}),
      permissionMode,
    });
  }, [agents, defaultAgent, openChat, cwdInput, view, state.order.length, permissionMode]);

  const newSession = (): void => {
    const agentId = selectedAgentId ?? defaultAgent?.id;
    if (!agentId) {
      return;
    }
    openChat(agentId, {
      ...(cwdInput.trim() ? { cwd: cwdInput.trim() } : {}),
      permissionMode,
    });
  };

  const selectAgent = (agent: AgentSummary): void => {
    setSelectedAgentId(agent.id);
    const cwd = cwdInput.trim();
    const options = { ...(cwd ? { cwd } : {}), permissionMode };
    if (activeChatId) {
      openChat(agent.id, { ...options, chatId: activeChatId });
    } else {
      openChat(agent.id, options);
    }
  };

  const selectCwd = (path: string): void => {
    setCwdInput(path);
    if (!active || busy) {
      return;
    }
    if (active.agent) {
      openChat(active.agent, {
        ...(path ? { cwd: path } : {}),
        ...(active.model ? { model: active.model } : {}),
        permissionMode,
        chatId: active.chatId,
      });
    } else if (active.command) {
      openCommand(active.command, {
        ...(path ? { cwd: path } : {}),
        permissionMode,
        chatId: active.chatId,
      });
    }
  };

  // The mode is applied when a runtime session is created, so switching it
  // reopens the active chat (its transcript is client-side and resets).
  const changePermissionMode = (mode: PermissionMode): void => {
    setChosenPermissionMode(mode);
    if (!active || busy || !sessionReady) {
      return;
    }
    closeChat(active.chatId, true);
    if (active.agent) {
      openChat(active.agent, {
        ...(active.cwd ? { cwd: active.cwd } : {}),
        ...(active.model ? { model: active.model } : {}),
        permissionMode: mode,
      });
    } else if (active.command) {
      openCommand(active.command, {
        ...(active.cwd ? { cwd: active.cwd } : {}),
        permissionMode: mode,
      });
    }
  };

  const runCommand = (command: string): void => {
    const cwd = cwdInput.trim();
    openCommand(command, { ...(cwd ? { cwd } : {}), permissionMode });
  };

  const showRegistry = server?.capabilities.install === true;
  const showCommand = server?.capabilities.command === true;
  const sessionReady =
    active !== undefined && (active.agent !== undefined || active.command !== undefined);
  const transcriptEmpty = (active?.transcript ?? []).length === 0;
  const emptyState = !sessionReady || transcriptEmpty;

  const sessionTitle =
    active?.agent ?? (active?.command !== undefined ? active.command : undefined) ?? "acpx chat";

  const agentSelect = (
    <AgentSelect
      agents={agents}
      {...(selectedAgentId ? { selectedAgentId } : {})}
      onSelect={selectAgent}
      disabled={locked}
    />
  );
  const cwdPicker = (
    <DirectoryPicker
      {...(cwdInput ? { value: cwdInput } : {})}
      {...(server?.cwd ? { defaultPath: server.cwd } : {})}
      disabled={locked}
      onChange={selectCwd}
    />
  );
  const modelPicker = active ? (
    <ModelPicker
      {...(active.models ? { models: active.models } : {})}
      {...(active.model ? { current: active.model } : {})}
      disabled={locked}
      onChange={(model) => setModel(active.chatId, model)}
    />
  ) : null;
  const permissionChip = (
    <span className="chip" title="权限模式">
      <span className="chip-glyph" aria-hidden="true">
        ✓
      </span>
      <select
        value={permissionMode}
        disabled={locked}
        onChange={(event) => changePermissionMode(event.target.value as PermissionMode)}
        aria-label="权限模式"
      >
        <option value="approve-all">全部允许</option>
        <option value="approve-reads">仅允许读取</option>
        <option value="deny-all">全部拒绝</option>
      </select>
    </span>
  );
  const customCommand = showCommand ? (
    <CustomCommand disabled={locked} busy={busy} onRun={runCommand} />
  ) : null;

  const sendFrom = (chatId: string | undefined) => (text: string) =>
    chatId !== undefined ? send(chatId, text) : false;

  return (
    <div className="layout">
      <div className="app-shell">
        <aside className="sidebar">
          <div className="sidebar-brand">
            acpx chat
            <span
              className={`connection-dot ${state.connected ? "on" : "off"}`}
              title={state.connected ? "已连接" : "连接中…"}
            />
          </div>
          <SessionList
            sessions={sessionItems}
            {...(activeChatId ? { activeChatId } : {})}
            onSelect={selectSession}
            onClose={(chatId) => closeChat(chatId)}
            onNew={newSession}
          />
        </aside>

        <div className="main">
          <header className="main-header">
            <div className="main-header-title">
              {sessionTitle}
              {busy ? <span className="running-dot" aria-label="运行中" /> : null}
            </div>
            <details className="status-details">
              <summary>会话信息</summary>
              <StatusPanel
                connected={state.connected}
                {...(active?.agent !== undefined ? { agent: active.agent } : {})}
                {...(active?.command !== undefined ? { command: active.command } : {})}
                {...(active?.cwd !== undefined ? { cwd: active.cwd } : {})}
                {...(active?.model !== undefined ? { model: active.model } : {})}
                {...(active?.permissionMode !== undefined
                  ? { permissionMode: active.permissionMode }
                  : { permissionMode })}
                {...(active?.sessionKey !== undefined ? { sessionKey: active.sessionKey } : {})}
                {...(active?.activeRequestId !== undefined
                  ? { activeRequestId: active.activeRequestId }
                  : {})}
                {...(active?.lastTurn !== undefined ? { lastTurn: active.lastTurn } : {})}
                status={active?.status ?? { entries: [], availableCommands: [] }}
              />
            </details>
            <button type="button" onClick={reload} disabled={loading}>
              {loading ? "加载中…" : "重新加载"}
            </button>
            <nav className="view-tabs">
              <button
                type="button"
                className={view === "chat" ? "view-tab-active" : undefined}
                onClick={() => setView("chat")}
              >
                对话
              </button>
              {settingsEnabled ? (
                <button
                  type="button"
                  className={view === "settings" ? "view-tab-active" : undefined}
                  onClick={() => setView("settings")}
                >
                  设置
                </button>
              ) : null}
            </nav>
          </header>

          <ErrorBanner
            errors={active?.errors ?? []}
            {...(catalogError ? { catalogError } : {})}
            onDismiss={() => dismissErrors(active?.chatId)}
          />

          {view === "settings" ? (
            <main className="app-body-settings">
              <SettingsView
                settings={settings}
                disabled={!settingsEnabled}
                {...(showRegistry ? { showRegistry } : {})}
                onAgentInstalled={reload}
              />
            </main>
          ) : emptyState ? (
            <main className="chat-column">
              <div className="conversation conversation-empty">
                <div className="empty-hero">
                  <h1>新建会话</h1>
                  <p className="muted">选择一个 agent 并发送 prompt 开始对话。</p>
                  <div className="empty-selectors">
                    {agentSelect}
                    {cwdPicker}
                  </div>
                </div>
                <Composer
                  disabled={!sessionReady || opening}
                  busy={busy}
                  onSend={sendFrom(activeChatId)}
                  onCancel={() => {
                    if (active) {
                      cancel(active.chatId);
                    }
                  }}
                  toolbar={
                    <>
                      {modelPicker}
                      {permissionChip}
                    </>
                  }
                />
              </div>
            </main>
          ) : (
            <main className="chat-column">
              <ConversationView transcript={active?.transcript ?? []} />
              <Composer
                disabled={!sessionReady || opening}
                busy={busy}
                onSend={sendFrom(activeChatId)}
                onCancel={() => {
                  if (active) {
                    cancel(active.chatId);
                  }
                }}
                toolbar={
                  <>
                    {agentSelect}
                    {cwdPicker}
                    {modelPicker}
                    {permissionChip}
                  </>
                }
                {...(customCommand ? { extra: customCommand } : {})}
              />
            </main>
          )}
        </div>
      </div>
    </div>
  );
}
