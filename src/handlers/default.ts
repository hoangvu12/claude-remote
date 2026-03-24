import type { MessageHandler, SessionContext, HandlerResult } from "../handler.js";
import type { ProcessedMessage } from "../types.js";
import { sendRendered } from "../discord-renderer.js";
import { closePassiveGroup } from "./passive-tools.js";
import { closeAllMcpGroups } from "./mcp-tools.js";

export class DefaultHandler implements MessageHandler {
  name = "default";

  async handle(pm: ProcessedMessage, ctx: SessionContext): Promise<HandlerResult> {
    await closePassiveGroup(ctx);
    await closeAllMcpGroups(ctx);
    await sendRendered(ctx.provider, pm);
    return "consumed";
  }
}
