import path from "node:path";
import type { MessageHandler, SessionContext, HandlerResult } from "../handler.js";
import type { ProcessedMessage } from "../types.js";
import { hasThreads } from "../provider.js";
import { toolState, type ToolEntry } from "./tool-state.js";
import { closePassiveGroup } from "./passive-tools.js";
import { closeAllMcpGroups } from "./mcp-tools.js";
import { formatToolInput } from "../format-tool.js";
import { COLOR } from "../discord-renderer.js";
import { truncate } from "../utils.js";
import { PASSIVE_TOOLS, EDIT_TOOLS, THREAD_TOOLS, isMcpTool, parseMcpToolName, getMcpServerDisplayName } from "../tools.js";

/**
 * Same-turn group handler — fold N parallel calls of the same tool (emitted as
 * one `tool-use-group` PM by the parser) into a single rendered unit.
 *
 *   - Passive (Read/Grep/Glob): bulk-add all ids into the active passive group.
 *     Cross-turn rollup ("Read 8 files") still happens via PassiveToolHandler
 *     when the next non-passive message closes the group.
 *   - Edit/Write: one channel embed listing the files, one thread carrying the
 *     individual diffs. All ids share the same ToolEntry so tool-result.ts
 *     routes per-call results into the shared thread and only finalizes when
 *     the last result lands.
 *   - Bash: one shared thread "Bash × N"; commands posted as thread messages.
 *     Same shared-ToolEntry pattern as Edit/Write.
 *   - Anything else with toolUseIds set should not have been emitted as a
 *     group by the parser — guard with a `pass` so the individual handlers
 *     can pick it up if it slips through.
 */
export class ToolUseGroupHandler implements MessageHandler {
  name = "tool-use-group";
  types = ["tool-use-group" as const];

  async handle(pm: ProcessedMessage, ctx: SessionContext): Promise<HandlerResult> {
    if (!pm.toolName || !pm.toolUseIds?.length || !pm.toolInputs?.length) return "pass";
    if (pm.toolUseIds.length !== pm.toolInputs.length) return "pass";

    const name = pm.toolName;
    const provider = ctx.provider;

    if (isMcpTool(name)) {
      const parsed = parseMcpToolName(name);
      if (!parsed) return "pass";
      const { server, tool } = parsed;
      const displayName = getMcpServerDisplayName(server);

      let group = toolState.activeMcpGroups.get(server);
      if (!group) {
        const indicatorMessage = await provider.send({
          embed: {
            description: `🔌 **Querying ${displayName}...**`,
            color: COLOR.TOOL,
          },
        });
        group = {
          server,
          displayName,
          counts: new Map(),
          toolUseIds: new Set(),
          results: [],
          indicatorMessage,
        };
        toolState.activeMcpGroups.set(server, group);
      }

      group.counts.set(tool, (group.counts.get(tool) || 0) + pm.toolUseIds.length);
      for (const id of pm.toolUseIds) {
        group.toolUseIds.add(id);
        toolState.toolUseThreads.set(id, { thread: null, toolName: name, content: "" });
      }

      if (group.indicatorMessage) {
        const total = [...group.counts.values()].reduce((a, b) => a + b, 0);
        try {
          await provider.edit(group.indicatorMessage, {
            embed: {
              description: `🔌 **Querying ${displayName}...** (${total} calls)`,
              color: COLOR.TOOL,
            },
          });
        } catch { /* best effort */ }
      }
      return "consumed";
    }

    if (PASSIVE_TOOLS.has(name)) {
      // Mirror PassiveToolHandler: don't render directly, just register all
      // ids into the active passive group so the cross-turn summary picks them
      // up. Closing other groups here matches the single-call passive flow.
      if (!isMcpTool(name)) await closeAllMcpGroups(ctx);

      let group = toolState.activePassiveGroup;
      if (!group) {
        group = { counts: new Map(), toolUseIds: new Set(), results: [] };
        toolState.activePassiveGroup = group;
      }
      group.counts.set(name, (group.counts.get(name) || 0) + pm.toolUseIds.length);
      for (const id of pm.toolUseIds) {
        group.toolUseIds.add(id);
        toolState.toolUseThreads.set(id, { thread: null, toolName: name, content: "" });
      }
      return "consumed";
    }

    // Non-passive tools start a new "block" — close any active passive/MCP
    // groupings the same way single tool calls would.
    await closePassiveGroup(ctx);
    await closeAllMcpGroups(ctx);

    if (EDIT_TOOLS.has(name)) {
      const fileLabels = pm.toolInputs
        .map((i) => path.basename(String(i.file_path || "")))
        .filter(Boolean);
      const summary = fileLabels.length
        ? `${name} × ${pm.toolUseIds.length} — ${fileLabels.join(", ")}`
        : `${name} × ${pm.toolUseIds.length}`;

      if (!hasThreads(provider)) {
        // Fallback for providers without thread support: emit each edit inline
        // (same behavior as the single-call EditWriteHandler).
        for (let i = 0; i < pm.toolUseIds.length; i++) {
          const subPm = this.subPm(pm, i);
          for (const msg of formatToolInput(subPm, COLOR.TOOL)) {
            await provider.send(msg);
          }
          ctx.resolvedToolUseIds.add(pm.toolUseIds[i]);
        }
        return "consumed";
      }

      const thread = await provider.createThread(truncate(`✏️ ${summary}`, 100));
      const sharedEntry: ToolEntry = {
        thread,
        toolName: name,
        content: truncate(fileLabels.join(", ") || `× ${pm.toolUseIds.length}`, 80),
      };
      for (let i = 0; i < pm.toolUseIds.length; i++) {
        const subPm = this.subPm(pm, i);
        for (const msg of formatToolInput(subPm, COLOR.TOOL)) {
          await provider.sendToThread(thread, msg);
        }
        toolState.toolUseThreads.set(pm.toolUseIds[i], sharedEntry);
      }
      await provider.send({
        embed: {
          description: `✏️ **${name}** × ${pm.toolUseIds.length}${fileLabels.length ? ` — ${truncate(fileLabels.join(", "), 200)}` : ""}`,
          color: COLOR.TOOL,
        },
      });
      return "consumed";
    }

    if (THREAD_TOOLS.has(name) && hasThreads(provider)) {
      const thread = await provider.createThread(truncate(`🔧 ${name} × ${pm.toolUseIds.length}`, 100));
      const sharedEntry: ToolEntry = {
        thread,
        toolName: name,
        content: `× ${pm.toolUseIds.length}`,
      };
      for (let i = 0; i < pm.toolUseIds.length; i++) {
        const subPm = this.subPm(pm, i);
        for (const msg of formatToolInput(subPm, COLOR.TOOL)) {
          await provider.sendToThread(thread, msg);
        }
        toolState.toolUseThreads.set(pm.toolUseIds[i], sharedEntry);
      }
      return "consumed";
    }

    // Threads unavailable for a thread-tool: fall back to one inline embed per
    // call so result routing keeps working.
    for (let i = 0; i < pm.toolUseIds.length; i++) {
      const subPm = this.subPm(pm, i);
      for (const msg of formatToolInput(subPm, COLOR.TOOL)) {
        await provider.send(msg);
      }
    }
    return "consumed";
  }

  private subPm(pm: ProcessedMessage, i: number): ProcessedMessage {
    return {
      type: "tool-use",
      content: "",
      uuid: pm.uuid,
      toolName: pm.toolName,
      toolUseId: pm.toolUseIds![i],
      toolInput: pm.toolInputs![i],
    };
  }
}
