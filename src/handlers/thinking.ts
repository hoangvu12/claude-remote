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

    return "pass";
  }
}
