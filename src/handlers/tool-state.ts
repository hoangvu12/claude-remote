import type { ProviderMessage, ProviderThread, OutgoingMessage, OutputProvider } from "../provider.js";

// ── Task types ──

export interface TaskInfo {
  id: string;
  subject: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
}

// ── Tool thread entry ──

export interface ToolEntry {
  thread: ProviderThread | null;
  toolName: string;
  content: string;
  cachedInput?: OutgoingMessage[];
  /** Inline embed shown in channel — deleted when escalated to thread */
  inlineMessage?: ProviderMessage | null;
}

// ── Shared mutable state for tool-related handlers ──

export const toolState = {
  /** toolUseId → thread/tool info */
  toolUseThreads: new Map<string, ToolEntry>(),

  /** Active passive tool group (Read/Grep/Glob) */
  activePassiveGroup: null as {
    inlineMessage: ProviderMessage | null;
    counts: Map<string, number>;
    toolUseIds: Set<string>;
    /** Buffered results for inline display */
    results: Array<{ content: string; isError: boolean; images?: Array<{ mediaType: string; data: string }> }>;
  } | null,

  /** Task tool tracking */
  taskToolUseIds: new Set<string>(),
  taskCreateTempIds: new Map<string, string>(),
  taskMap: new Map<string, TaskInfo>(),
  taskPinnedMessage: null as ProviderMessage | null,

  /** Progress intervals for long-running tool threads */
  progressIntervals: new Map<string, ReturnType<typeof setInterval>>(),
  progressMessages: new Map<string, ProviderMessage>(),

  /** Clean up progress timer and message for a resolved tool */
  async cleanupProgress(toolUseId: string, provider: OutputProvider): Promise<void> {
    const interval = this.progressIntervals.get(toolUseId);
    if (interval) {
      clearInterval(interval);
      this.progressIntervals.delete(toolUseId);
    }
    const msg = this.progressMessages.get(toolUseId);
    if (msg) {
      try { await provider.delete(msg); } catch { /* already gone */ }
      this.progressMessages.delete(toolUseId);
    }
  },

  /** Clean up all pending progress intervals (e.g. on destroy) */
  clearAllProgress(): void {
    for (const interval of this.progressIntervals.values()) {
      clearInterval(interval);
    }
    this.progressIntervals.clear();
    this.progressMessages.clear();
  },
};

export const INLINE_RESULT_THRESHOLD = 400;
export const PASSIVE_TOOLS = new Set(["Read", "Grep", "Glob"]);
export const TASK_TOOLS = new Set(["TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]);
