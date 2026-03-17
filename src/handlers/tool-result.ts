import type { MessageHandler, SessionContext, HandlerResult } from "../handler.js";
import type { ProcessedMessage } from "../types.js";
import type { ProviderThread } from "../provider.js";
import { hasThreads, editOrSend } from "../provider.js";
import { toolState, INLINE_RESULT_THRESHOLD } from "./tool-state.js";
import { renderToolResultThreadMessages, resultColor } from "../discord-renderer.js";
import { truncate, mimeToExt } from "../utils.js";

/** Send result content to a thread */
async function sendResultToThread(
  ctx: SessionContext,
  thread: ProviderThread,
  content: string,
  isError: boolean,
  images?: Array<{ mediaType: string; data: string }>,
) {
  const provider = ctx.provider;
  if (!hasThreads(provider)) return;
  for (const msg of renderToolResultThreadMessages(content, isError)) {
    await provider.sendToThread(thread, { text: msg.content });
  }
  if (images?.length) {
    await sendImagesToThread(ctx, thread, images);
  }
}

/** Send decoded images as file attachments to a thread */
async function sendImagesToThread(
  ctx: SessionContext,
  thread: ProviderThread,
  images: Array<{ mediaType: string; data: string }>,
) {
  const provider = ctx.provider;
  if (!hasThreads(provider)) return;
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const ext = mimeToExt(img.mediaType);
    const buf = Buffer.from(img.data, "base64");
    if (buf.length > 8 * 1024 * 1024) continue; // skip files over 8MB Discord limit
    await provider.sendToThread(thread, {
      files: [{ name: `image-${i + 1}.${ext}`, data: buf }],
    });
  }
}

/** Rename thread with result icon and archive it */
async function finalizeThread(
  ctx: SessionContext,
  thread: ProviderThread,
  toolName: string,
  content: string,
  icon: string,
) {
  const provider = ctx.provider;
  if (!hasThreads(provider)) return;
  try { await provider.renameThread(thread, truncate(`${toolName} — ${content} ${icon}`, 100)); } catch {}
  try { await provider.archiveThread(thread); } catch {}
}

export class ToolResultHandler implements MessageHandler {
  name = "tool-result";
  types = ["tool-result" as const, "tool-result-error" as const];

  async handle(pm: ProcessedMessage, ctx: SessionContext): Promise<HandlerResult> {
    if (!pm.toolUseId) return "pass";

    ctx.resolvedToolUseIds.add(pm.toolUseId);

    // Clean up progress timer
    await toolState.cleanupProgress(pm.toolUseId, ctx.provider);

    // Task tool results handled by TaskHandler
    if (toolState.taskToolUseIds.has(pm.toolUseId)) {
      return "pass";
    }

    const isError = pm.type === "tool-result-error";
    const entry = toolState.toolUseThreads.get(pm.toolUseId);
    if (!entry) return "consumed"; // Edit/Write or already resolved

    const provider = ctx.provider;
    const icon = isError ? "❌" : "✅";
    const label = `**${entry.toolName}** — \`${truncate(entry.content, 80)}\``;
    const color = resultColor(isError);

    // Passive group results → buffer for display at close
    const group = toolState.activePassiveGroup;
    if (group && group.toolUseIds.has(pm.toolUseId)) {
      group.results.push({ content: pm.content, isError, images: pm.images });
      toolState.toolUseThreads.delete(pm.toolUseId);
      return "consumed";
    }

    const resultText = pm.content.trim();
    const isEmpty = !resultText || resultText === "undefined";
    const isShort = !isEmpty && resultText.length <= INLINE_RESULT_THRESHOLD;

    // Already escalated to thread (slow >5s) → inline embed was already deleted
    if (entry.thread && hasThreads(provider)) {
      await sendResultToThread(ctx, entry.thread, resultText, isError, pm.images);
      toolState.toolUseThreads.delete(pm.toolUseId);

      // Rename and archive if no other tools share this thread
      const sameThread = [...toolState.toolUseThreads.values()].some(
        (e) => e.thread?.id === entry.thread!.id
      );
      if (!sameThread) {
        await finalizeThread(ctx, entry.thread, entry.toolName, entry.content, icon);
      }
      return "consumed";
    }

    // Fast result — no thread yet
    if ((isEmpty || isShort) && !pm.images?.length) {
      const desc = isEmpty
        ? `${icon} ${label} *(no output)*`
        : `${icon} ${label}\n\`\`\`\n${resultText}\n\`\`\``;
      await editOrSend(provider, entry.inlineMessage, { embed: { description: desc, color } });
      toolState.toolUseThreads.delete(pm.toolUseId);
    } else if (hasThreads(provider)) {
      // Long result → delete inline embed, escalate to thread
      const [, thread] = await Promise.all([
        entry.inlineMessage
          ? provider.delete(entry.inlineMessage).catch(() => {})
          : Promise.resolve(),
        provider.createThread(truncate(`${entry.toolName} — ${entry.content} ${icon}`, 100)),
      ]);
      if (entry.cachedInput) {
        for (const msg of entry.cachedInput) {
          await provider.sendToThread(thread, msg);
        }
      }

      await sendResultToThread(ctx, thread, resultText, isError, pm.images);
      try { await provider.archiveThread(thread); } catch { /* best effort */ }
      toolState.toolUseThreads.delete(pm.toolUseId);
    } else {
      // No thread support — edit inline embed
      const desc = `${icon} ${label}\n\`\`\`\n${truncate(resultText, 3900)}\n\`\`\``;
      await editOrSend(provider, entry.inlineMessage, { embed: { description: desc, color } });
      toolState.toolUseThreads.delete(pm.toolUseId);
    }

    return "consumed";
  }
}
