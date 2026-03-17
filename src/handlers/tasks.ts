import type { MessageHandler, SessionContext, HandlerResult } from "../handler.js";
import type { ProcessedMessage } from "../types.js";
import { toolState, TASK_TOOLS, type TaskInfo } from "./tool-state.js";
import { COLOR } from "../discord-renderer.js";

// ── Task embed rendering (provider-agnostic) ──

const STATUS_EMOJI: Record<TaskInfo["status"], string> = {
  pending: "⭕",
  in_progress: "🔄",
  completed: "✅",
  deleted: "❌",
};

function renderTaskEmbed() {
  const tasks = [...toolState.taskMap.values()].filter((t) => t.status !== "deleted");
  const lines = tasks.map((t) => `${STATUS_EMOJI[t.status] || "⭕"} ${t.subject}`);
  const done = tasks.filter((t) => t.status === "completed").length;
  const total = tasks.length;
  const barLen = 10;
  const filled = total > 0 ? Math.round((done / total) * barLen) : 0;
  const bar = "█".repeat(filled) + "░".repeat(barLen - filled);

  return {
    embed: {
      title: "📋 Tasks",
      description: lines.join("\n") || "*No tasks*",
      color: COLOR.BLURPLE,
      footer: `${bar}  ${done}/${total} completed`,
    },
  };
}

async function updateTaskPin(ctx: SessionContext) {
  if (toolState.taskMap.size === 0) return;
  const msg = renderTaskEmbed();

  if (toolState.taskPinnedMessage) {
    try {
      await ctx.provider.edit(toolState.taskPinnedMessage, msg);
      return;
    } catch {
      toolState.taskPinnedMessage = null;
    }
  }

  toolState.taskPinnedMessage = await ctx.provider.send(msg);
  if (toolState.taskPinnedMessage) {
    try { await ctx.provider.pin(toolState.taskPinnedMessage); } catch { /* best effort */ }
  }
}

function applyTaskInput(toolUseId: string, name: string, input: Record<string, unknown>) {
  if (name === "TaskCreate") {
    const tempId = `_pending_${toolUseId}`;
    toolState.taskCreateTempIds.set(toolUseId, tempId);
    toolState.taskMap.set(tempId, {
      id: tempId,
      subject: String(input.subject || input.description || "Untitled"),
      status: "pending",
    });
  } else if (name === "TaskUpdate") {
    const taskId = String(input.taskId || "");
    const existing = toolState.taskMap.get(taskId);
    if (existing) {
      if (input.status) existing.status = input.status as TaskInfo["status"];
      if (input.subject) existing.subject = String(input.subject);
    }
  }
}

function parseTaskResultContent(content: string, toolUseId?: string) {
  const createMatch = content.match(/Task #(\d+) created/);
  if (createMatch && toolUseId) {
    const realId = createMatch[1];
    const tempId = toolState.taskCreateTempIds.get(toolUseId);
    if (tempId && toolState.taskMap.has(tempId)) {
      const task = toolState.taskMap.get(tempId)!;
      toolState.taskMap.delete(tempId);
      task.id = realId;
      toolState.taskMap.set(realId, task);
    }
    toolState.taskCreateTempIds.delete(toolUseId);
    return;
  }

  if (content.match(/Updated task #\d+/)) return;

  try {
    const data = JSON.parse(content);
    if (Array.isArray(data)) {
      toolState.taskMap.clear();
      for (const t of data) {
        if (t.id && (t.subject || t.description)) {
          toolState.taskMap.set(String(t.id), {
            id: String(t.id),
            subject: String(t.subject || t.description || "Untitled"),
            status: t.status || "pending",
          });
        }
      }
    } else if (data && data.id) {
      toolState.taskMap.set(String(data.id), {
        id: String(data.id),
        subject: String(data.subject || data.description || "Untitled"),
        status: data.status || "pending",
      });
    }
  } catch {
    // Not JSON — rely on input-based tracking
  }
}

export class TaskHandler implements MessageHandler {
  name = "tasks";

  async handle(pm: ProcessedMessage, ctx: SessionContext): Promise<HandlerResult> {
    // Handle tool-use for task tools
    if (pm.type === "tool-use" && pm.toolUseId && TASK_TOOLS.has(pm.toolName || "")) {
      toolState.taskToolUseIds.add(pm.toolUseId);
      if (pm.toolInput) {
        applyTaskInput(pm.toolUseId, pm.toolName!, pm.toolInput);
        await updateTaskPin(ctx);
      }
      ctx.resolvedToolUseIds.add(pm.toolUseId);
      return "consumed";
    }

    // Handle tool-result for task tools
    if ((pm.type === "tool-result" || pm.type === "tool-result-error") &&
        pm.toolUseId && toolState.taskToolUseIds.has(pm.toolUseId)) {
      toolState.taskToolUseIds.delete(pm.toolUseId);
      parseTaskResultContent(pm.content, pm.toolUseId);
      await updateTaskPin(ctx);
      return "consumed";
    }

    return "pass";
  }
}
