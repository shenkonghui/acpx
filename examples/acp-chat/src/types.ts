/**
 * Browser-side mirror of the server wire protocol (`server/chat-protocol.ts`) plus the
 * view models the reducer produces. Kept separate so the UI bundle never imports zod
 * or any server module.
 */
export const CHAT_PROTOCOL = "acpx.chat.v1";

export type AgentAvailability = "installed" | "missing" | "unknown";

export type AgentSource = "config" | "built-in" | "gateway-config" | "ad-hoc";

export const PERMISSION_MODES = ["approve-all", "approve-reads", "deny-all"] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

export type FsDirEntry = { name: string; path: string };

export type FsDirsResponse = {
  path: string;
  parent: string | null;
  entries: FsDirEntry[];
};

export type AgentRequirement = {
  kind: "command" | "package";
  name: string;
};

export type AgentSummary = {
  id: string;
  name: string;
  source: AgentSource;
  availability: AgentAvailability;
  launch?: { argv: string[] };
  requirements?: AgentRequirement[];
  isDefault: boolean;
};

export type RegistryInstallMethod = "binary" | "npx" | "uvx";

export type RegistryAgentSummary = {
  id: string;
  name: string;
  version: string;
  description?: string;
  methods: RegistryInstallMethod[];
  installable: boolean;
  installed: boolean;
};

export type RegistryListResponse = {
  registryVersion: string;
  platform?: string;
  agents: RegistryAgentSummary[];
};

export type RegistryInstallResult = {
  agentId: string;
  registeredName: string;
  version: string;
  method: RegistryInstallMethod;
  argv: string[];
  env?: Record<string, string>;
  installDir?: string;
  reused: boolean;
  warnings: string[];
};

export type RegistryInstallResponse = {
  ok: boolean;
  result: RegistryInstallResult;
};

export type ChatServerCapabilities = {
  install: boolean;
  command: boolean;
  settings: boolean;
};

export type ChatHealthResponse = {
  service: string;
  cwd: string;
  permissionMode: string;
  stateDir: string;
  capabilities?: ChatServerCapabilities;
};

export type SettingsAgentSource = "config" | "gateway-config" | "built-in";

export type SettingsAgent = {
  name: string;
  enabled: boolean;
  source: SettingsAgentSource;
  isBuiltIn: boolean;
  hasConfigEntry: boolean;
  /** False for project-shadowed or gateway-only rows the global config cannot change. */
  writable: boolean;
  argv: string[];
  env?: Record<string, string>;
  defaultArgv?: string[];
  availability: AgentAvailability;
  requirements?: AgentRequirement[];
  isDefault: boolean;
  /** Model ids the user enabled for this agent; absent means all models. */
  enabledModels?: string[];
  /** True when the launch command is an `acpx gateway` process; such rows cannot be disabled. */
  isGateway: boolean;
};

export type SettingsView = {
  agents: SettingsAgent[];
  globalPath: string;
  projectPath: string;
  writable: boolean;
};

export type ModelProbeResponse = {
  ok: boolean;
  models?: Array<{ modelId: string; name: string }>;
  /** True when the agent is a gateway; the list merges every backend's models. */
  isGateway?: boolean;
  error?: { code?: string; message?: string };
};

export type ChatTurnStatus = "completed" | "cancelled" | "failed";

export type ChatErrorCode =
  | "protocol_error"
  | "agent_not_found"
  | "command_not_found"
  | "command_disabled"
  | "session_error"
  | "turn_in_progress"
  | "model_unsupported"
  | "internal_error";

export type SessionModels = {
  currentModelId?: string;
  availableModelIds: string[];
  availableModels?: Array<{ modelId: string; name: string }>;
};

export type ChatClientMessage =
  | { type: "hello"; protocol: string }
  | {
      type: "open_session";
      chatId: string;
      agent?: string;
      command?: string;
      cwd?: string;
      model?: string;
      permissionMode?: PermissionMode;
    }
  | { type: "send"; chatId: string; text: string; requestId: string }
  | { type: "cancel"; chatId: string }
  | { type: "set_model"; chatId: string; model: string }
  | { type: "close_session"; chatId: string; discard?: boolean }
  | { type: "ping" };

export type ChatServerMessage =
  | { type: "ready"; protocol: string }
  | { type: "pong" }
  | {
      type: "session_opened";
      chatId: string;
      sessionKey: string;
      agent: string;
      cwd: string;
      model?: string;
      models?: SessionModels;
      permissionMode?: PermissionMode;
    }
  | { type: "session_closed"; chatId: string }
  | { type: "session_models"; chatId: string; models: SessionModels }
  | { type: "turn_started"; chatId: string; requestId: string }
  | {
      type: "text_delta";
      chatId: string;
      requestId: string;
      text: string;
      stream: "output" | "thought";
    }
  | {
      type: "tool_call";
      chatId: string;
      requestId: string;
      text: string;
      toolCallId?: string;
      status?: string;
      title?: string;
      kind?: string;
      rawInput?: unknown;
      rawOutput?: unknown;
      content?: unknown;
    }
  | {
      type: "status";
      chatId: string;
      requestId: string;
      text: string;
      tag?: string;
      used?: number;
      size?: number;
      cost?: unknown;
      entries?: unknown[];
      availableCommands?: unknown[];
    }
  | {
      type: "turn_done";
      chatId: string;
      requestId: string;
      status: ChatTurnStatus;
      stopReason?: string;
      error?: { message: string; code?: string };
    }
  | { type: "error"; chatId?: string; code: ChatErrorCode; message: string };

export type ChatMessageRole = "user" | "assistant" | "thought";

export type TranscriptItem =
  | {
      kind: "message";
      id: string;
      requestId: string;
      role: ChatMessageRole;
      text: string;
      streaming: boolean;
    }
  | {
      kind: "tool";
      id: string;
      requestId: string;
      toolCallId: string;
      text: string;
      title?: string;
      status?: string;
      toolKind?: string;
      rawInput?: unknown;
      rawOutput?: unknown;
    };

export type ChatStatusView = {
  text?: string;
  tag?: string;
  used?: number;
  size?: number;
  cost?: unknown;
  entries: unknown[];
  availableCommands: unknown[];
};

export type LastTurn = {
  requestId: string;
  status: ChatTurnStatus;
  stopReason?: string;
};

export type ChatState = {
  connected: boolean;
  chatId: string;
  agent?: string;
  command?: string;
  sessionKey?: string;
  cwd?: string;
  model?: string;
  models?: SessionModels;
  permissionMode?: PermissionMode;
  activeRequestId?: string;
  transcript: TranscriptItem[];
  status: ChatStatusView;
  errors: string[];
  lastTurn?: LastTurn;
  opening: boolean;
};

/** Local actions mixed into the server message stream by the reducer. */
export type ChatAction =
  | { type: "disconnected" }
  | {
      type: "opening";
      agent?: string;
      command?: string;
      cwd?: string;
      model?: string;
      permissionMode?: PermissionMode;
    }
  | { type: "user_message"; requestId: string; text: string }
  | { type: "clear_errors" }
  | ChatServerMessage;

export type DiagnosticPhaseStatus = "pending" | "running" | "ok" | "failed" | "skipped";

export type DiagnosticInit = {
  status: DiagnosticPhaseStatus;
  ms?: number;
  error?: string;
};

export type DiagnosticModels = {
  status: DiagnosticPhaseStatus;
  names: string[];
  error?: string;
};

export type DiagnosticPing = {
  status: DiagnosticPhaseStatus;
  ms?: number;
  reply?: string;
  error?: string;
};

export type DiagnosticBackend = {
  name: string;
  status: DiagnosticPhaseStatus;
  names: string[];
  error?: string;
};

export type AgentDiagnostic = {
  name: string;
  argv?: string[];
  init: DiagnosticInit;
  models: DiagnosticModels;
  ping: DiagnosticPing;
  /** Present when the agent is an acpx gateway: models per backend agent. */
  isGateway?: boolean;
  backends?: DiagnosticBackend[];
};

export type DiagnosticsRun = {
  id: number;
  startedAt: number;
  finishedAt?: number;
  agents: AgentDiagnostic[];
};
