import type { MessageHandler, SessionContext, HandlerResult } from "../handler.js";
import type { ProcessedMessage } from "../types.js";
import type { ProviderMessage, OutputProvider } from "../provider.js";
import { hasThreads } from "../provider.js";
import { toolState, type ToolEntry } from "./tool-state.js";
import { formatToolInput } from "../format-tool.js";
import { truncate, ID_PREFIX } from "../utils.js";
import { COLOR } from "../discord-renderer.js";
import { THREAD_TOOLS } from "../tools.js";

/** Short window to wait for a fast result before escalating to thread */
const FAST_RESULT_WINDOW = 300;
/** Interval for progress updates in threads */
const PROGRESS_INTERVAL = 15_000;

function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * Post the Allow/Deny prompt into a tool's thread. Used by:
 *  - escalateToThread, when we know a permission is pending at thread creation
 *    (PermissionRequest hook arrived before the FAST_RESULT_WINDOW expired)
 *  - daemon's handlePermissionRequest, when the hook arrives after the thread
 *    already exists (the common case for slow tools like Bash)
 *
 * Rendering is keyed off the actual hook firing — NOT permissionMode — because
 * Claude Code's safety-check branch (e.g. `~/.claude/settings.json` edits) asks
 * for permission even when --dangerously-skip-permissions is on, and the user
 * needs buttons in those cases too.
 */
export async function renderPermissionPrompt(
  entry: ToolEntry,
  toolUseId: string,
  provider: OutputProvider & { sendToThread: Function },
): Promise<void> {
  if (!entry.thread) return;
  await provider.sendToThread(entry.thread, {
    embed: {
      title: "⚠️ Permission needed",
      description: `**${entry.toolName}** ${entry.content}`,
      color: COLOR.PERMISSION,
    },
    actions: [
      { id: `${ID_PREFIX.ALLOW}${toolUseId}`, label: "Allow", style: "success" },
      { id: `${ID_PREFIX.DENY}${toolUseId}`, label: "Deny", style: "danger" },
    ],
  });
}

/** Escalate an unresolved tool to a thread; render permission prompt if a hook is already pending. */
async function escalateToThread(
  entry: ToolEntry,
  toolUseId: string,
  ctx: SessionContext,
  provider: OutputProvider & { createThread: Function; sendToThread: Function },
) {
  // Delete inline embed — thread replaces it
  if (entry.inlineMessage) {
    try { await provider.delete(entry.inlineMessage); } catch { /* already gone */ }
    entry.inlineMessage = null;
  }

  // Create thread for long-running tool
  if (!entry.thread) {
    entry.thread = await provider.createThread(
      truncate(`⏳ ${entry.toolName} — ${entry.content}`, 100)
    );
    if (entry.cachedInput) {
      for (const msg of entry.cachedInput) {
        await provider.sendToThread(entry.thread, msg);
      }
      delete entry.cachedInput;
    }
  }

  // If the PermissionRequest hook already fired for this tool while we were
  // waiting on FAST_RESULT_WINDOW, render the prompt now.
  if (toolState.permissionPending.has(toolUseId)) {
    toolState.permissionPending.delete(toolUseId);
    await renderPermissionPrompt(entry, toolUseId, provider);
  }

  // Start progress timer — shows elapsed time in thread
  const startTime = Date.now();
  let progressMsg: ProviderMessage | null = null;
  const interval = setInterval(async () => {
    if (!entry.thread || ctx.resolvedToolUseIds.has(toolUseId)) {
      clearInterval(interval);
      toolState.progressIntervals.delete(toolUseId);
      return;
    }
    const elapsed = formatElapsed(Date.now() - startTime);
    const text = `⏳ Running... ${elapsed}`;
    try {
      if (progressMsg) {
        await provider.edit(progressMsg, { text });
      } else {
        progressMsg = await provider.sendToThread(entry.thread, { text });
        if (progressMsg) toolState.progressMessages.set(toolUseId, progressMsg);
      }
    } catch { /* best effort */ }
  }, PROGRESS_INTERVAL);
  toolState.progressIntervals.set(toolUseId, interval);
}

export class ToolUseHandler implements MessageHandler {
  name = "tool-use";
  types = ["tool-use" as const];
  private pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  async handle(pm: ProcessedMessage, ctx: SessionContext): Promise<HandlerResult> {
    if (!pm.toolUseId) return "pass";

    const cleanContent = pm.content.replace(/`/g, "");
    const provider = ctx.provider;
    const name = pm.toolName || "Unknown";
    const immediate = THREAD_TOOLS.has(name);

    // Cache formatted input for thread context
    const inputMessages = formatToolInput(pm, COLOR.TOOL);

    // Only send inline embed for providers without thread support (fallback)
    const inlineMsg = (!immediate && !hasThreads(provider)) ? await provider.send({
      embed: {
        description: `🔧 **${name}** ${cleanContent}`,
        color: COLOR.TOOL,
      },
    }) : null;

    const entry: ToolEntry = {
      thread: null,
      toolName: name,
      content: cleanContent,
      cachedInput: inputMessages,
      inlineMessage: inlineMsg,
    };
    toolState.toolUseThreads.set(pm.toolUseId, entry);

    if (hasThreads(provider)) {
      const toolUseId = pm.toolUseId;
      // Escalate immediately for THREAD_TOOLS (Bash/Agent) OR when the
      // PermissionRequest hook already fired for this tool — waiting another
      // 300ms would leave the user staring at an unanswerable prompt.
      const needPermission = toolState.permissionPending.has(toolUseId);

      if (immediate || needPermission) {
        await escalateToThread(entry, toolUseId, ctx, provider);
      } else {
        // Short window for fast results — escalate to thread if no result arrives
        const timer = setTimeout(async () => {
          this.pendingTimers.delete(timer);
          if (ctx.resolvedToolUseIds.has(toolUseId)) return;
          await escalateToThread(entry, toolUseId, ctx, provider);
        }, FAST_RESULT_WINDOW);
        this.pendingTimers.add(timer);
      }
    }

    return "consumed";
  }

  destroy() {
    for (const timer of this.pendingTimers) clearTimeout(timer);
    this.pendingTimers.clear();
    toolState.clearAllProgress();
  }
}
