import type { MessageHandler, SessionContext, HandlerResult } from "../handler.js";
import type { ProcessedMessage } from "../types.js";
import type { ProviderMessage } from "../provider.js";
import { ID_PREFIX, truncate } from "../utils.js";
import { COLOR, MAX_EMBED_DESC } from "../discord-renderer.js";
import { PLAN_TOOLS } from "../tools.js";
const COLOR_AMBER = 0xf5a623;

export class PlanModeHandler implements MessageHandler {
  name = "plan-mode";
  types = ["tool-use" as const];
  private planMessage: ProviderMessage | null = null;

  async handle(pm: ProcessedMessage, ctx: SessionContext): Promise<HandlerResult> {
    if (!PLAN_TOOLS.has(pm.toolName || "")) return "pass";

    if (pm.toolUseId) ctx.resolvedToolUseIds.add(pm.toolUseId);

    if (pm.toolName === "EnterPlanMode") {
      this.planMessage = await ctx.provider.send({
        embed: {
          description: "📐 **Plan mode** — researching and designing an approach",
          color: COLOR_AMBER,
        },
      });
    } else if (pm.toolName === "ExitPlanMode") {
      // Delete the old "planning" indicator — it's at the top, above tool calls
      if (this.planMessage) {
        await ctx.provider.delete(this.planMessage).catch(() => {});
        this.planMessage = null;
      }

      // Show the plan text if present
      const planText = typeof pm.toolInput?.plan === "string" ? pm.toolInput.plan : "";
      if (planText) {
        await ctx.provider.send({
          embed: {
            description: truncate(`📐 **Plan**\n\n${planText}`, MAX_EMBED_DESC),
            color: COLOR_AMBER,
          },
        });
      }

      // Send selection buttons as a new message at the bottom
      await ctx.provider.send({
        embed: {
          description: "📐 **Ready to code?**",
          color: COLOR.BLURPLE,
        },
        actions: [
          { id: `${ID_PREFIX.PLAN}1`, label: "Clear context & implement", style: "success" as const },
          { id: `${ID_PREFIX.PLAN}2`, label: "Implement (keep context)", style: "primary" as const },
          { id: `${ID_PREFIX.PLAN}3`, label: "Manually approve edits", style: "secondary" as const },
          { id: `${ID_PREFIX.PLAN_FEEDBACK}${pm.toolUseId || ""}`, label: "Keep planning", style: "danger" as const },
        ],
      });
    }

    return "consumed";
  }
}
