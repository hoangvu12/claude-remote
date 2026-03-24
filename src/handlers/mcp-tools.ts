import type { MessageHandler, SessionContext, HandlerResult } from "../handler.js";
import type { ProcessedMessage } from "../types.js";
import { toolState, closeToolGroup } from "./tool-state.js";
import { isMcpTool, parseMcpToolName, getMcpServerDisplayName } from "../tools.js";
import { COLOR } from "../discord-renderer.js";

function mcpGroupSummary(group: { displayName: string; counts: Map<string, number> }): string {
  const total = [...group.counts.values()].reduce((a, b) => a + b, 0);
  if (total === 1) {
    const [tool] = group.counts.keys();
    return `${group.displayName} — ${tool}`;
  }
  const parts = [...group.counts.entries()].map(([tool, count]) =>
    count > 1 ? `${tool} x${count}` : tool
  );
  return `${group.displayName} — ${parts.join(", ")}`;
}

async function closeMcpGroup(server: string, ctx: SessionContext) {
  const group = toolState.activeMcpGroups.get(server);
  if (!group) return;
  toolState.activeMcpGroups.delete(server);

  if (group.indicatorMessage) {
    try { await ctx.provider.delete(group.indicatorMessage); } catch { /* already gone */ }
  }

  await closeToolGroup(mcpGroupSummary(group), group.results, ctx);
}

export async function closeAllMcpGroups(ctx: SessionContext) {
  for (const server of [...toolState.activeMcpGroups.keys()]) {
    await closeMcpGroup(server, ctx);
  }
}

export function isMcpGroupResult(toolUseId: string): string | null {
  for (const [server, group] of toolState.activeMcpGroups) {
    if (group.toolUseIds.has(toolUseId)) return server;
  }
  return null;
}

export function bufferMcpResult(
  server: string,
  toolUseId: string,
  content: string,
  isError: boolean,
  images?: Array<{ mediaType: string; data: string }>,
) {
  const group = toolState.activeMcpGroups.get(server);
  if (!group) return;

  group.results.push({ content, isError, images });
  toolState.toolUseThreads.delete(toolUseId);
}

export class McpToolHandler implements MessageHandler {
  name = "mcp-tools";
  types = ["tool-use" as const];

  async handle(pm: ProcessedMessage, ctx: SessionContext): Promise<HandlerResult> {
    const toolName = pm.toolName || "";
    if (!pm.toolUseId || !isMcpTool(toolName)) return "pass";

    const parsed = parseMcpToolName(toolName);
    if (!parsed) return "pass";

    const { server, tool } = parsed;
    const displayName = getMcpServerDisplayName(server);

    toolState.toolUseThreads.set(pm.toolUseId, {
      thread: null,
      toolName: toolName,
      content: "",
    });

    const existing = toolState.activeMcpGroups.get(server);
    if (existing) {
      existing.counts.set(tool, (existing.counts.get(tool) || 0) + 1);
      existing.toolUseIds.add(pm.toolUseId);

      if (existing.indicatorMessage) {
        const total = [...existing.counts.values()].reduce((a, b) => a + b, 0);
        try {
          await ctx.provider.edit(existing.indicatorMessage, {
            embed: {
              description: `🔌 **Querying ${displayName}...** (${total} calls)`,
              color: COLOR.TOOL,
            },
          });
        } catch { /* best effort */ }
      }

      return "consumed";
    }

    const indicatorMessage = await ctx.provider.send({
      embed: {
        description: `🔌 **Querying ${displayName}...**`,
        color: COLOR.TOOL,
      },
    });

    toolState.activeMcpGroups.set(server, {
      server,
      displayName,
      counts: new Map([[tool, 1]]),
      toolUseIds: new Set([pm.toolUseId]),
      results: [],
      indicatorMessage,
    });

    return "consumed";
  }

  destroy() {
    toolState.activeMcpGroups.clear();
  }
}
