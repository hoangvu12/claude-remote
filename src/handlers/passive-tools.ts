import type { MessageHandler, SessionContext, HandlerResult } from "../handler.js";
import type { ProcessedMessage } from "../types.js";
import { toolState, closeToolGroup } from "./tool-state.js";
import { PASSIVE_TOOLS, getToolSummaryNoun, isMcpTool } from "../tools.js";
import { closeAllMcpGroups } from "./mcp-tools.js";

function isPassiveToolUse(pm: ProcessedMessage): boolean {
  return pm.type === "tool-use" && !!pm.toolUseId && PASSIVE_TOOLS.has(pm.toolName || "");
}

function passiveGroupSummary(counts: Map<string, number>): string {
  return [...counts.entries()].map(([name, count]) => {
    const noun = getToolSummaryNoun(name);
    return `${name} ${count} ${noun}${count > 1 ? "s" : ""}`;
  }).join(", ");
}

export async function closePassiveGroup(ctx: SessionContext) {
  const g = toolState.activePassiveGroup;
  if (!g) return;
  toolState.activePassiveGroup = null;
  await closeToolGroup(passiveGroupSummary(g.counts), g.results, ctx);
}

export class PassiveToolHandler implements MessageHandler {
  name = "passive-tools";
  types = ["tool-use" as const];

  async handle(pm: ProcessedMessage, ctx: SessionContext): Promise<HandlerResult> {
    if (!isPassiveToolUse(pm)) {
      await closePassiveGroup(ctx);
      if (!isMcpTool(pm.toolName || "")) await closeAllMcpGroups(ctx);
      return "pass";
    }

    const name = pm.toolName || "Unknown";

    toolState.toolUseThreads.set(pm.toolUseId!, {
      thread: null,
      toolName: name,
      content: "",
    });

    if (toolState.activePassiveGroup) {
      const g = toolState.activePassiveGroup;
      g.counts.set(name, (g.counts.get(name) || 0) + 1);
      g.toolUseIds.add(pm.toolUseId!);
      return "consumed";
    }

    toolState.activePassiveGroup = {
      counts: new Map([[name, 1]]),
      toolUseIds: new Set([pm.toolUseId!]),
      results: [],
    };

    return "consumed";
  }

  destroy() {
    toolState.activePassiveGroup = null;
  }
}
