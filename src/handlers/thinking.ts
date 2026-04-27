import type { MessageHandler, SessionContext, HandlerResult } from "../handler.js";
import type { ProcessedMessage } from "../types.js";
import { sendRendered } from "../discord-renderer.js";

export class ThinkingHandler implements MessageHandler {
  name = "thinking";

  async handle(pm: ProcessedMessage, ctx: SessionContext): Promise<HandlerResult> {
    if (pm.type === "user-prompt") {
      await sendRendered(ctx.provider, pm);
      return "consumed";
    }

    // Mirror upstream's AssistantThinkingMessage / AssistantRedactedThinking
    // rendering — Claude's reasoning trail surfaced as a collapsed embed so
    // users can verify intent without leaving the channel.
    if (pm.type === "thinking") {
      await sendRendered(ctx.provider, pm);
      return "consumed";
    }

    return "pass";
  }
}
