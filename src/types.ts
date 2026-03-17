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

export interface ContentBlockToolResult {
  type: "tool_result";
  tool_use_id: string;
  content: string | ContentBlockText[];
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
  | ContentBlockThinking;

export interface JSONLMessage {
  type: "assistant" | "user" | "system" | "progress" | "file-history-snapshot" | "queue-operation" | "last-prompt";
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
  };
  data?: Record<string, unknown>;
}

// ── Config ──

export interface Config {
  discordBotToken: string;
  guildId: string;
  categoryId: string;
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
}

export interface DaemonReadyMessage {
  type: "daemon-ready";
  channelId: string;
}

export type DaemonToParent = PtyWriteMessage | DaemonReadyMessage;
export type ParentToDaemon = SessionInfoMessage;

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

export type PipeMessage = PipeEnableMessage | PipeDisableMessage | PipeStatusMessage | PipeSessionRegisterMessage;

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
}
