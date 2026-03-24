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
