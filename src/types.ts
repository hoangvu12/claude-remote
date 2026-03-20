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

export interface JSONLMessage {
  type: "assistant" | "user" | "system" | "progress" | "result" | "rate_limit_event" | "auth_status" | "tool_use_summary" | "tool_progress" | "prompt_suggestion" | "file-history-snapshot" | "queue-operation" | "last-prompt";
  uuid: string;
  parentUuid?: string;
  isSidechain?: boolean;
  timestamp: string;
  sessionId: string;
  subtype?: string;
  permissionMode?: string;
  message?: {
    role: "assistant" | "user";
    content: ContentBlock[] | string;
    model?: string;
    stop_reason?: string | null;
  };
  data?: Record<string, unknown>;
  /** Parent Agent tool_use ID (for progress messages) */
  parentToolUseID?: string;
  toolUseID?: string;
}

// ── Config ──

export interface Config {
  discordBotToken: string;
  guildId: string;
  categoryId: string;
  autoRemote?: boolean;
}

// ── IPC messages ──

export interface PtyWriteMessage {
  type: "pty-write";
  text: string;
  /** If true, write text exactly as-is without appending \r */
  raw?: boolean;
}

export interface SessionInfoMessage {
  type: "session-info";
  sessionId: string;
  projectDir: string;
  channelName?: string;
  transcriptPath?: string;
  reuseChannelId?: string;
  initialPermissionMode?: string;
}

export interface DaemonReadyMessage {
  type: "daemon-ready";
  channelId: string;
}

export type DaemonToParent = PtyWriteMessage | DaemonReadyMessage;
export type ParentToDaemon = SessionInfoMessage | PipeStateSignalMessage;

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
}

export interface PipeStateSignalMessage {
  type: "state-signal";
  event: "stop" | "post-compact";
  trigger?: "manual" | "auto";
}

export type PipeMessage = PipeEnableMessage | PipeDisableMessage | PipeStatusMessage | PipeSessionRegisterMessage | PipeStateSignalMessage;

// ── Processed message for Discord rendering ──

export type DiscordMessageType =
  | "user-prompt"
  | "assistant-text"
  | "tool-use"
  | "tool-result"
  | "tool-result-error"
  | "ask-user-question"
  | "rewind"
  | "turn-duration"
  | "status";

export interface ProcessedMessage {
  type: DiscordMessageType;
  content: string;
  uuid: string;
  toolName?: string;
  toolUseId?: string;
  toolInput?: Record<string, unknown>;
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
