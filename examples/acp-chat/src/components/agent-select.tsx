import type { AgentSummary } from "../types.js";

/**
 * Agent selector styled as a Pase picker badge (avatar + native select with a
 * custom chevron). Only agents with an explicit entry (config / gateway-config /
 * ad-hoc) are listed; built-in adapters stay out of the way unless nothing is
 * configured at all. Missing entries stay visible but disabled so their
 * requirements can be discovered from the option label.
 */
export function AgentSelect({
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
    return <span className="chip muted small">未配置任何 ACP agent</span>;
  }

  const configured = agents.filter(
    (agent) =>
      agent.source === "config" || agent.source === "gateway-config" || agent.source === "ad-hoc",
  );
  const listed = configured.length > 0 ? configured : agents;

  const selected =
    listed.find((agent) => agent.id === selectedAgentId) ??
    listed.find((agent) => agent.isDefault && agent.availability !== "missing") ??
    listed.find((agent) => agent.availability !== "missing") ??
    listed[0];
  const initial = selected.name.charAt(0).toUpperCase() || "?";

  return (
    <span className="chip" title={describeAgent(selected)}>
      <span className="chip-avatar" aria-hidden="true">
        {initial}
      </span>
      <select
        value={selected.id}
        disabled={disabled}
        onChange={(event) => {
          const agent = listed.find((item) => item.id === event.target.value);
          if (agent) {
            onSelect(agent);
          }
        }}
        aria-label="Agent"
      >
        {listed.map((agent) => (
          <option key={agent.id} value={agent.id} disabled={agent.availability === "missing"}>
            {agent.name}
            {agent.availability === "missing" ? "（缺失）" : ""}
          </option>
        ))}
      </select>
    </span>
  );
}

function describeAgent(agent: AgentSummary): string {
  if (agent.availability === "installed" && agent.launch) {
    return agent.launch.argv.join(" ");
  }
  if (agent.availability === "missing" && agent.requirements) {
    return `缺少：${agent.requirements.map((item) => `${item.kind} ${item.name}`).join(", ")}`;
  }
  return agent.id;
}
