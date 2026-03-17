import type { MessageHandler, SessionContext, HandlerResult } from "../handler.js";
import type { ProcessedMessage } from "../types.js";
import type { ProviderMessage } from "../provider.js";
import { hasThreads } from "../provider.js";
import { toolState } from "./tool-state.js";
import { formatToolInput } from "../format-tool.js";
import { truncate, ID_PREFIX } from "../utils.js";
import { COLOR } from "../discord-renderer.js";

/** Delay before escalating an unresolved tool to a thread */
const ESCALATE_DELAY = 5000;
/** Interval for progress updates in threads */
const PROGRESS_INTERVAL = 15_000;

function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export class ToolUseHandler implements MessageHandler {
  name = "tool-use";
  types = ["tool-use" as const];
  private pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  async handle(pm: ProcessedMessage, ctx: SessionContext): Promise<HandlerResult> {
    if (!pm.toolUseId) return "pass";

    const cleanContent = pm.content.replace(/`/g, "");
    const provider = ctx.provider;

    // Cache formatted input for thread context
    const inputMessages = formatToolInput(pm, COLOR.TOOL);

    // Defer everything — no inline yet, result handler decides inline vs thread
    toolState.toolUseThreads.set(pm.toolUseId, {
      thread: null,
      toolName: pm.toolName || "Unknown",
      content: cleanContent,
      cachedInput: inputMessages,
    });

    // Escalation timer: if still unresolved after delay, create thread
    if (hasThreads(provider)) {
      const toolUseId = pm.toolUseId;
      const entry = toolState.toolUseThreads.get(toolUseId);
      const timer = setTimeout(async () => {
        this.pendingTimers.delete(timer);
        if (ctx.resolvedToolUseIds.has(toolUseId)) return;
        if (!entry) return;

        // Create thread for long-running tool (this is the only place it shows)
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

        // Permission prompt (only if not in bypass mode)
        if (ctx.permissionMode !== "bypassPermissions") {
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
      }, ESCALATE_DELAY);
      this.pendingTimers.add(timer);
    }

    return "consumed";
  }

  destroy() {
    for (const timer of this.pendingTimers) clearTimeout(timer);
    this.pendingTimers.clear();
    toolState.clearAllProgress();
  }
}
