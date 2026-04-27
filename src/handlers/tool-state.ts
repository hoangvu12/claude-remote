import type { ProviderMessage, ProviderThread, OutgoingMessage, OutputProvider } from "../provider.js";
import { hasThreads } from "../provider.js";
import { renderToolResultThreadMessages, resultColor } from "../discord-renderer.js";
import { truncate, mimeToExt } from "../utils.js";
import type { SessionContext } from "../handler.js";

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
  inlineMessage?: ProviderMessage | null;
  /**
   * Authoritative tool duration from PostToolUse hook (excludes permission
   * prompts + PreToolUse latency). Threaded onto the ToolEntry so the result
   * handler can include it in the final embed/thread title without re-deriving
   * elapsed from setInterval timestamps.
   */
  durationMs?: number;
}

// ── Group result (shared by passive and MCP groups) ──

export interface GroupResult {
  content: string;
  isError: boolean;
  images?: Array<{ mediaType: string; data: string }>;
}

// ── MCP group ──

export interface McpGroup {
  server: string;
  displayName: string;
  counts: Map<string, number>;
  toolUseIds: Set<string>;
  results: GroupResult[];
  indicatorMessage: ProviderMessage | null;
}

// ── Shared mutable state for tool-related handlers ──

export const toolState = {
  toolUseThreads: new Map<string, ToolEntry>(),

  /**
   * toolUseIds for which Claude Code's PermissionRequest hook has fired but
   * we haven't yet rendered Allow/Deny buttons in Discord (race: hook can
   * arrive before the JSONL tool_use line is parsed). The tool-use handler
   * checks this set on entry creation; the daemon's permission renderer
   * checks the toolUseThreads map first and falls back to this set.
   */
  permissionPending: new Set<string>(),

  activePassiveGroup: null as {
    counts: Map<string, number>;
    toolUseIds: Set<string>;
    results: GroupResult[];
  } | null,

  activeMcpGroups: new Map<string, McpGroup>(),

  taskToolUseIds: new Set<string>(),
  taskCreateTempIds: new Map<string, string>(),
  taskMap: new Map<string, TaskInfo>(),
  taskPinnedMessage: null as ProviderMessage | null,

  progressIntervals: new Map<string, ReturnType<typeof setInterval>>(),
  progressMessages: new Map<string, ProviderMessage>(),

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

  clearAllProgress(): void {
    for (const interval of this.progressIntervals.values()) {
      clearInterval(interval);
    }
    this.progressIntervals.clear();
    this.progressMessages.clear();
  },
};

export const INLINE_RESULT_THRESHOLD = 400;

// ── Shared group-close rendering ──

export async function closeToolGroup(
  summary: string,
  results: GroupResult[],
  ctx: SessionContext,
): Promise<void> {
  const provider = ctx.provider;
  const hasError = results.some((r) => r.isError);
  const icon = hasError ? "❌" : "✅";

  if (!hasThreads(provider)) {
    const combinedResult = results.map((r) => r.content.trim()).filter((t) => t && t !== "undefined").join("\n");
    const desc = combinedResult
      ? `${icon} ${summary}\n\`\`\`\n${truncate(combinedResult, 3900)}\n\`\`\``
      : `${icon} ${summary}`;
    await provider.send({ embed: { description: desc, color: resultColor(hasError) } });
    return;
  }

  const thread = await provider.createThread(truncate(`${summary} ${icon}`, 100));
  for (const r of results) {
    for (const msg of renderToolResultThreadMessages(r.content, r.isError)) {
      await provider.sendToThread(thread, { text: msg.content });
    }
    if (r.images?.length) {
      for (let i = 0; i < r.images.length; i++) {
        const img = r.images[i];
        const ext = mimeToExt(img.mediaType);
        const buf = Buffer.from(img.data, "base64");
        if (buf.length > 8 * 1024 * 1024) continue;
        await provider.sendToThread(thread, {
          files: [{ name: `image-${i + 1}.${ext}`, data: buf }],
        });
      }
    }
  }
  try { await provider.archiveThread(thread); } catch { /* best effort */ }
}
