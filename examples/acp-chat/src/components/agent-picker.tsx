import type { AgentSource, AgentSummary } from "../types.js";

const SOURCE_LABELS: Record<AgentSource, string> = {
  config: "config",
  "gateway-config": "gateway",
  "built-in": "built-in",
  "ad-hoc": "custom",
};

const AVAILABILITY_LABELS = {
  installed: "ready",
  missing: "missing",
  unknown: "unknown",
} as const;

export function AgentPicker({
  agents,
  selectedAgentId,
  onSelect,
  disabled,
}: {
  agents: AgentSummary[];
  selectedAgentId?: string;
  onSelect: (agent: AgentSummary) => void;
  disabled?: boolean;
}) {
  if (agents.length === 0) {
    return <p className="muted">No ACP agents found. Configure one in ~/.acpx/config.json.</p>;
  }

  const defaultId = agents.find((agent) => agent.isDefault)?.id;

  return (
    <ul className="agent-list">
      {agents.map((agent) => {
        const selected = agent.id === selectedAgentId;
        return (
          <li key={agent.id}>
            <button
              type="button"
              className={`agent-item${selected ? " agent-item-selected" : ""}`}
              onClick={() => onSelect(agent)}
              disabled={disabled || agent.availability === "missing"}
              title={describeRequirements(agent)}
            >
              <span className="agent-line">
                <span className="agent-name">{agent.name}</span>
                {agent.id === defaultId ? <span className="tag tag-default">default</span> : null}
              </span>
              <span className="agent-line">
                <span className={`tag tag-${agent.availability}`}>
                  {AVAILABILITY_LABELS[agent.availability]}
                </span>
                <span className="tag">{SOURCE_LABELS[agent.source]}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function describeRequirements(agent: AgentSummary): string {
  if (agent.availability === "installed" && agent.launch) {
    return agent.launch.argv.join(" ");
  }
  if (agent.availability === "missing" && agent.requirements) {
    return `Missing: ${agent.requirements.map((item) => `${item.kind} ${item.name}`).join(", ")}`;
  }
  return agent.id;
}
