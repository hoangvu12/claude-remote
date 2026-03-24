import type { MessageHandler, SessionContext, HandlerResult } from "../handler.js";
import type { ProcessedMessage } from "../types.js";
import { formatToolInput } from "../format-tool.js";
import { COLOR } from "../discord-renderer.js";
import { EDIT_TOOLS } from "../tools.js";

export class EditWriteHandler implements MessageHandler {
  name = "edit-write";
  types = ["tool-use" as const];

  async handle(pm: ProcessedMessage, ctx: SessionContext): Promise<HandlerResult> {
    if (!pm.toolUseId || !EDIT_TOOLS.has(pm.toolName || "")) {
      return "pass";
    }

    // Show inline in channel, no thread
    for (const msg of formatToolInput(pm, COLOR.TOOL)) {
      await ctx.provider.send(msg);
    }

    ctx.resolvedToolUseIds.add(pm.toolUseId);
    return "consumed";
  }
}
