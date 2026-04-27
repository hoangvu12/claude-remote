// ── JSONL message types ──

export interface ContentBlockText {
  type: "text";
  text: string;
}

export interface ContentBlockToolUse {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ContentBlockImage {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

export interface ContentBlockToolResult {
  type: "tool_result";
  tool_use_id: string;
  content: string | (ContentBlockText | ContentBlockImage)[];
  is_error?: boolean;
}

export interface ContentBlockThinking {
  type: "thinking";
  thinking: string;
}

export type ContentBlock =
  | ContentBlockText
  | ContentBlockToolUse
  | ContentBlockToolResult
  | ContentBlockThinking
  | ContentBlockImage;

/**
 * JSONL entry types Claude Code writes today (src/types/logs.ts Entry union)
 * plus legacy types retained for backwards-compatibility when tailing older
 * transcript files. Legacy types (progress, rate_limit_event, auth_status,
 * tool_use_summary, tool_progress, prompt_suggestion, result) are no longer
 * written by current Claude Code but may appear in pre-existing JSONLs —
 * daemon.ts keeps defensive handlers for them.
 */
export type JSONLEntryType =
  | "assistant"
  | "user"
  | "system"
  | "attachment"
  | "summary"
  | "custom-title"
  | "ai-title"
  | "last-prompt"
  | "task-summary"
  | "tag"
  | "pr-link"
  | "attribution-snapshot"
  | "file-history-snapshot"
  | "queue-operation"
  | "speculation-accept"
  | "worktree-state"
  | "mode"
  | "content-replacement"
  // Legacy — not emitted by current upstream, kept for old-transcript compat
  | "progress"
  | "result"
  | "rate_limit_event"
  | "auth_status"
  | "tool_use_summary"
  | "tool_progress"
  | "prompt_suggestion";

export interface JSONLMessage {
  type: JSONLEntryType;
  uuid: string;
  parentUuid?: string;
  isSidechain?: boolean;
  timestamp: string;
  sessionId: string;
  /**
   * `system` subtype. High-value values we react to: `compact_boundary`,
   * `microcompact_boundary`, `turn_duration`, `api_error`, `api_metrics`,
   * `stop_hook_summary`. The rest we ignore.
   */
  subtype?: string;
  permissionMode?: string;
  message?: {
    role: "assistant" | "user";
    content: ContentBlock[] | string;
    model?: string;
    stop_reason?: string | null;
  };
  data?: Record<string, unknown>;
  /** Parent Agent tool_use ID (for sidechain/subagent work). */
  parentToolUseID?: string;
  toolUseID?: string;
  /** Optional correlation fields upstream writes. */
  cwd?: string;
  version?: string;
  gitBranch?: string;
  /** `system` subtype-specific metadata. Shapes vary; access narrowly. */
  compactMetadata?: {
    trigger?: "manual" | "auto";
    preTokens?: number;
    userContext?: string;
    messagesSummarized?: number;
  };
  microcompactMetadata?: {
    trigger?: "auto";
    preTokens?: number;
    tokensSaved?: number;
    compactedToolIds?: string[];
    clearedAttachmentUUIDs?: string[];
  };
  durationMs?: number;
  /** `api_error` subtype */
  error?: string;
  retryInMs?: number;
  retryAttempt?: number;
  maxRetries?: number;
  level?: string;
}

// ── Config ──

export interface Config {
  discordBotToken: string;
  guildId: string;
  categoryId: string;
  autoRemote?: boolean;
}

// ── IPC messages (rc.ts ↔ daemon pipe) ──

export interface PtyWriteMessage {
  type: "pty-write";
  sessionKey: string;
  text: string;
  /** If true, write text exactly as-is without appending \r */
  raw?: boolean;
}

export interface SessionInfoMessage {
  type: "session-info";
  sessionKey: string;
  sessionId: string;
  projectDir: string;
  channelName?: string;
  transcriptPath?: string;
  reuseChannelId?: string;
  initialPermissionMode?: string;
  /** Why this session started: startup / resume / clear / compact. From SessionStart hook. */
  sessionSource?: "startup" | "resume" | "clear" | "compact";
}

export interface SessionDisconnectMessage {
  type: "session-disconnect";
  sessionKey: string;
}

export interface DaemonReadyMessage {
  type: "daemon-ready";
  sessionKey: string;
  channelId: string;
}

export type StateSignalEvent =
  | "stop"
  | "stop-failure"
  | "post-compact"
  | "pre-compact"
  | "session-end"
  | "notification"
  | "tool-start"
  | "tool-end"
  | "tool-failure"
  | "subagent-start"
  | "subagent-end"
  | "subagent-failure";

export interface DaemonStateSignalMessage {
  type: "state-signal";
  sessionKey: string;
  event: StateSignalEvent;
  trigger?: "manual" | "auto";
  /** For pre-compact — optional user-provided instructions. */
  customInstructions?: string;
  /** For session-end — why the session ended. */
  reason?: "clear" | "resume" | "logout" | "prompt_input_exit" | "other" | "bypass_permissions_disabled";
  /** For notification — type of notification and free-form message. */
  notificationType?: "permission_prompt" | "elicitation_dialog" | "elicitation_url_dialog" | "worker_permission_prompt" | "auth_success" | string;
  message?: string;
  title?: string;
  /** For stop — optional trailing assistant text from the turn. */
  lastAssistantMessage?: string;
  /** For stop-failure — Claude's error category (e.g. `rate_limit`, `server_error`). */
  errorCode?: string;
  /** For stop-failure — human-readable error detail. */
  errorDetails?: string;
  /** For tool-start / tool-end / tool-failure — Claude's tool name (e.g. `Read`, `Bash`). */
  toolName?: string;
  /** For tool-start / tool-end / tool-failure — id correlating start with end/failure. */
  toolUseId?: string;
  /** For tool-end / tool-failure / subagent-end — authoritative tool execution time from the hook. */
  durationMs?: number;
  /** For subagent-* — Claude's subagent identifier. */
  agentId?: string;
  /** For subagent-* — id of the Agent/Task tool_use that spawned this subagent (when known). */
  parentToolUseId?: string;
}

export interface DaemonRestartMessage {
  type: "restart";
  sessionKey: string;
}

/**
 * PermissionRequest hook → daemon. Sent by `permission-hook.ts` when
 * Claude Code asks the user to authorize a tool. Routed to the active
 * session by Claude session UUID (not our internal sessionKey, which the
 * hook subprocess can't see). The daemon holds the socket open until the
 * user clicks Allow/Deny in Discord, then writes the decision JSON back.
 */
export interface DaemonPermissionRequestMessage {
  type: "permission-request";
  sessionId: string;
  toolUseId: string;
  toolName: string;
  toolInput?: Record<string, unknown>;
  permissionMode?: string;
}

export type DaemonToClient = PtyWriteMessage | DaemonReadyMessage | DaemonRestartMessage;
export type ClientToDaemon =
  | SessionInfoMessage
  | DaemonStateSignalMessage
  | SessionDisconnectMessage
  | DaemonPermissionRequestMessage;

// ── Named pipe messages (hook → rc) ──

export interface PipeEnableMessage {
  type: "enable";
  sessionId?: string;
  channelName?: string;
}

export interface PipeDisableMessage {
  type: "disable";
}

export interface PipeStatusMessage {
  type: "status";
}

export interface PipeSessionRegisterMessage {
  type: "session-register";
  sessionId: string;
  transcriptPath: string;
  cwd?: string;
  /** Why this session started (from SessionStart payload.source). */
  source?: "startup" | "resume" | "clear" | "compact";
}

export interface PipeStateSignalMessage {
  type: "state-signal";
  event: StateSignalEvent;
  trigger?: "manual" | "auto";
  customInstructions?: string;
  reason?: DaemonStateSignalMessage["reason"];
  notificationType?: DaemonStateSignalMessage["notificationType"];
  message?: string;
  title?: string;
  lastAssistantMessage?: string;
  errorCode?: string;
  errorDetails?: string;
  toolName?: string;
  toolUseId?: string;
  durationMs?: number;
  agentId?: string;
  parentToolUseId?: string;
}

export type PipeMessage = PipeEnableMessage | PipeDisableMessage | PipeStatusMessage | PipeSessionRegisterMessage | PipeStateSignalMessage;

// ── Processed message for Discord rendering ──

export type DiscordMessageType =
  | "user-prompt"
  | "assistant-text"
  | "tool-use"
  | "tool-use-group"
  | "tool-result"
  | "tool-result-error"
  | "ask-user-question"
  | "rewind"
  | "turn-duration"
  | "api-error"
  | "microcompact"
  | "status";

export interface ProcessedMessage {
  type: DiscordMessageType;
  content: string;
  uuid: string;
  toolName?: string;
  toolUseId?: string;
  toolInput?: Record<string, unknown>;
  /** Same-turn group: ids of every tool_use block folded into this group, in original order. */
  toolUseIds?: string[];
  /** Same-turn group: per-call tool inputs paired with toolUseIds. */
  toolInputs?: Record<string, unknown>[];
  questions?: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  }>;
  isFromDiscord?: boolean;
  cost?: { duration?: string; inputTokens?: number; outputTokens?: number; cost?: string };
  images?: Array<{ mediaType: string; data: string }>;
}
