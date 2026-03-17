import type { MessageHandler, SessionContext, HandlerResult } from "../handler.js";
import type { ProcessedMessage } from "../types.js";
import type { ProviderMessage } from "../provider.js";
import { ID_PREFIX } from "../utils.js";

const PLAN_TOOLS = new Set(["EnterPlanMode", "ExitPlanMode"]);
const COLOR_AMBER = 0xf5a623;
const COLOR_BLUE = 0x5865f2;

let planMessage: ProviderMessage | null = null;

export class PlanModeHandler implements MessageHandler {
  name = "plan-mode";
  types = ["tool-use" as const];

  async handle(pm: ProcessedMessage, ctx: SessionContext): Promise<HandlerResult> {
    if (!PLAN_TOOLS.has(pm.toolName || "")) return "pass";

    if (pm.toolUseId) ctx.resolvedToolUseIds.add(pm.toolUseId);

    if (pm.toolName === "EnterPlanMode") {
      planMessage = await ctx.provider.send({
        embed: {
          description: "📐 **Plan mode** — researching and designing an approach",
          color: COLOR_AMBER,
        },
      });
    } else if (pm.toolName === "ExitPlanMode") {
      // Replace the planning message with buttons, or send new if lost
      const msg = {
        embed: {
          description: "📐 **Ready to code?**",
          color: COLOR_BLUE,
        },
        actions: [
          { id: `${ID_PREFIX.PLAN}1`, label: "Clear context & implement", style: "success" as const },
          { id: `${ID_PREFIX.PLAN}2`, label: "Implement (keep context)", style: "primary" as const },
          { id: `${ID_PREFIX.PLAN}3`, label: "Manually approve edits", style: "secondary" as const },
          { id: `${ID_PREFIX.PLAN_FEEDBACK}${pm.toolUseId || ""}`, label: "Keep planning", style: "danger" as const },
        ],
      };

      if (planMessage) {
        await ctx.provider.edit(planMessage, msg);
        planMessage = null;
      } else {
        await ctx.provider.send(msg);
      }
    }

    return "consumed";
  }
}
