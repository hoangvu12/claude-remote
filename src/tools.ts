/**
 * Centralized tool registry — single source of truth for all Claude Code tool metadata.
 * Mirrors Claude Code CLI's Set-based architecture for tool grouping.
 */

// ── Tool Groups ──

export const PASSIVE_TOOLS = new Set(["Read", "Grep", "Glob"]);
export const EDIT_TOOLS = new Set(["Edit", "Write"]);
export const TASK_TOOLS = new Set(["TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]);
export const PLAN_TOOLS = new Set(["EnterPlanMode", "ExitPlanMode"]);
export const THREAD_TOOLS = new Set(["Bash", "Agent"]);
export const INTERACTIVE_TOOLS = new Set(["AskUserQuestion"]);
export const HIDDEN_TOOLS = new Set(["ToolSearch"]);

/**
 * Tools where 2+ parallel calls in a single assistant turn fold into one
 * `tool-use-group` ProcessedMessage. Mirrors Claude Code's same-turn grouping
 * (utils/groupToolUses.ts) — opt-in per tool because it only makes sense when
 * the tool's input is small enough to summarize and the parallel pattern is
 * common. Agent is intentionally excluded (each subagent has a distinct task).
 *
 * MCP tools (`mcp__*`) are *also* groupable but checked separately via
 * `isGroupableTool` because they share a server-namespaced naming convention
 * rather than a fixed name.
 */
export const GROUPABLE_TOOLS = new Set(["Read", "Grep", "Glob", "Edit", "Write", "Bash"]);

export function isGroupableTool(name: string): boolean {
  return GROUPABLE_TOOLS.has(name) || isMcpTool(name);
}

// ── Summary nouns for passive tool grouping ──

const SUMMARY_NOUNS: Record<string, string> = {
  Read: "file",
  Grep: "pattern",
  Glob: "pattern",
};

export function getToolSummaryNoun(toolName: string): string {
  return SUMMARY_NOUNS[toolName] ?? "call";
}

// ── MCP Tool Helpers ──

export function isMcpTool(toolName: string): boolean {
  return toolName.startsWith("mcp__");
}

export function parseMcpToolName(toolName: string): { server: string; tool: string } | null {
  if (!isMcpTool(toolName)) return null;
  const parts = toolName.split("__");
  if (parts.length < 3) return null;
  return { server: parts[1], tool: parts.slice(2).join("__") };
}

export function getMcpServerDisplayName(serverName: string): string {
  return serverName
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
