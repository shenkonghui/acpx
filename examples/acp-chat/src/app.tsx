import { useEffect, useState } from "react";
import { AgentPicker } from "./components/agent-picker.js";
import { Composer } from "./components/composer.js";
import { ConversationView } from "./components/conversation-view.js";
import { CustomCommand } from "./components/custom-command.js";
import { ErrorBanner } from "./components/error-banner.js";
import { RegistryPanel } from "./components/registry-panel.js";
import { StatusPanel } from "./components/status-panel.js";
import { useAgentCatalog } from "./hooks/use-agent-catalog.js";
import { useChatSocket } from "./hooks/use-chat-socket.js";
import { useServerCapabilities } from "./hooks/use-server-capabilities.js";
import type { AgentSummary } from "./types.js";

export function App() {
  const { agents, loading, error: catalogError, reload } = useAgentCatalog();
  const { state, openChat, openCommand, send, cancel, dismissErrors } = useChatSocket();
  const capabilities = useServerCapabilities();
  const [mode, setMode] = useState<"agent" | "command">("agent");
  const [selectedAgentId, setSelectedAgentId] = useState<string | undefined>(undefined);
  const [cwdInput, setCwdInput] = useState("");

  useEffect(() => {
    if (mode !== "agent" || selectedAgentId || agents.length === 0) {
      return;
    }
    const preferred =
      agents.find((agent) => agent.isDefault && agent.availability !== "missing") ??
      agents.find((agent) => agent.availability !== "missing") ??
      agents[0];
    if (preferred) {
      setSelectedAgentId(preferred.id);
      openChat(preferred.id, cwdInput.trim() || undefined);
    }
  }, [agents, selectedAgentId, cwdInput, openChat, mode]);

  const selectAgent = (agent: AgentSummary) => {
    setMode("agent");
    setSelectedAgentId(agent.id);
    openChat(agent.id, cwdInput.trim() || undefined);
  };

  const runCommand = (command: string) => {
    setMode("command");
    setSelectedAgentId(undefined);
    openCommand(command, cwdInput.trim() || undefined);
  };

  const busy = state.activeRequestId !== undefined;
  const showRegistry = capabilities?.install === true;
  const showCommand = capabilities?.command === true;

  return (
    <div className="layout">
      <header className="app-header">
        <h1>acpx ACP chat</h1>
        <span className={`connection connection-${state.connected ? "on" : "off"}`}>
          {state.connected ? "connected" : "connecting…"}
        </span>
        <button type="button" onClick={reload} disabled={loading}>
          {loading ? "Loading…" : "Reload agents"}
        </button>
      </header>

      <ErrorBanner
        errors={state.errors}
        {...(catalogError ? { catalogError } : {})}
        onDismiss={dismissErrors}
      />

      <main className="app-body">
        <nav className="sidebar">
          <h2>Agents</h2>
          <AgentPicker
            agents={agents}
            {...(selectedAgentId ? { selectedAgentId } : {})}
            onSelect={selectAgent}
            disabled={busy}
          />
          <label className="cwd-field">
            <span>Working directory</span>
            <input
              type="text"
              value={cwdInput}
              placeholder="server default"
              disabled={busy}
              onChange={(event) => setCwdInput(event.target.value)}
            />
          </label>
          {showCommand ? <CustomCommand disabled={busy} busy={busy} onRun={runCommand} /> : null}
          {showRegistry ? <RegistryPanel onInstalled={reload} /> : null}
        </nav>

        <section className="chat-column">
          <ConversationView
            transcript={state.transcript}
            emptyHint={
              busy || state.opening
                ? "Starting session…"
                : "Pick an agent, then send a prompt to test the connection."
            }
          />
          <Composer
            disabled={state.agent === undefined}
            busy={busy}
            onSend={send}
            onCancel={cancel}
          />
        </section>

        <StatusPanel
          connected={state.connected}
          {...(state.agent !== undefined ? { agent: state.agent } : {})}
          {...(state.command !== undefined ? { command: state.command } : {})}
          {...(state.cwd !== undefined ? { cwd: state.cwd } : {})}
          {...(state.sessionKey !== undefined ? { sessionKey: state.sessionKey } : {})}
          {...(state.activeRequestId !== undefined
            ? { activeRequestId: state.activeRequestId }
            : {})}
          {...(state.lastTurn !== undefined ? { lastTurn: state.lastTurn } : {})}
          status={state.status}
        />
      </main>
    </div>
  );
}
