import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Shared paths ──

export const CONFIG_DIR = path.join(os.homedir(), ".claude-remote");
export const STATUS_FLAG = path.join(CONFIG_DIR, "active");
export const PIPE_REGISTRY = path.join(CONFIG_DIR, "pipes");
export const DAEMON_PIPE_NAME = "\\\\.\\pipe\\claude-remote-daemon";

/**
 * Resolve the active Claude config directory.
 *
 * Precedence:
 *   1. CLAUDE_CONFIG_DIR env var (official Anthropic override)
 *   2. ~/.claude-switch/active-path (claude-switch v4 pointer — lets daemons
 *      follow profile switches live without a restart)
 *   3. ~/.claude (default)
 *
 * Called on-demand, not cached, so the daemon picks up profile switches
 * between requests.
 */
export function getClaudeDir(): string {
  const envDir = process.env.CLAUDE_CONFIG_DIR;
  if (envDir && fs.existsSync(envDir)) return envDir;

  try {
    const pointer = path.join(os.homedir(), ".claude-switch", "active-path");
    const dir = fs.readFileSync(pointer, "utf-8").trim();
    if (dir && fs.existsSync(dir)) return dir;
  } catch {}

  return path.join(os.homedir(), ".claude");
}

// ── Discord custom ID prefixes ──

export const ID_PREFIX = {
  ALLOW: "allow:",
  DENY: "deny:",
  ASK: "ask:",
  ASK_OTHER: "ask-other:",
  ASK_SUBMIT: "ask-submit:",
  MODAL: "modal:",
  PLAN: "plan:",
  PLAN_FEEDBACK: "plan-feedback:",
  MODE: "mode:",
  QUEUE_EDIT: "queue-edit:",
} as const;

// ── Helpers ──

export function encodeProjectPath(projectPath: string): string {
  // Claude's encoding: C:\Users\Foo Bar\project → C--Users-Foo-Bar-project
  // Drive colon becomes dash, all separators and spaces become dashes
  return projectPath
    .replace(/\\/g, "/")     // normalize to forward slashes
    .replace(/:/, "-")       // C:/ → C-/
    .replace(/\//g, "-")     // all slashes → dashes
    .replace(/ /g, "-");     // spaces → dashes
}

export function truncate(text: string, maxLen: number, suffix = "…"): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - suffix.length) + suffix;
}

export function resolveJSONLPath(sessionId: string, cwd: string): string {
  const claudeDir = path.join(getClaudeDir(), "projects");
  const encoded = encodeProjectPath(cwd);
  return path.join(claudeDir, encoded, `${sessionId}.jsonl`);
}

/**
 * Extract text content from a tool_result block.
 */
export function extractToolResultText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b.type === "text").map((b) => b.text || "").join("\n");
  }
  return "";
}

/**
 * Extract image content blocks from a tool_result.
 */
export function extractToolResultImages(
  content: string | Array<{ type: string; source?: { type: string; media_type: string; data: string } }>,
): Array<{ mediaType: string; data: string }> {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b) => b.type === "image" && b.source?.type === "base64")
    .map((b) => ({ mediaType: b.source!.media_type, data: b.source!.data }));
}

/** Map a MIME type to a file extension */
export function mimeToExt(mediaType: string): string {
  const map: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
  };
  return map[mediaType] || "png";
}

// ── Claude Code local-only CLI commands (don't trigger API calls) ──

const LOCAL_COMMANDS = [
  "/model", "/fast", "/login", "/logout",
  "/help", "/cost", "/mcp", "/stats",
];

/** Check if a message is a local-only CLI command that won't trigger an API call */
export function isLocalCommand(text: string): boolean {
  return LOCAL_COMMANDS.some((c) => text === c || text.startsWith(c + " "));
}

// ── Permission mode cycling (matches Claude Code's Shift+Tab order) ──

const MODE_CYCLE = ["default", "acceptEdits", "plan", "bypassPermissions"] as const;

export const MODE_LABELS: Record<string, string> = {
  default: "Default",
  acceptEdits: "Accept edits",
  plan: "Plan Mode",
  bypassPermissions: "Bypass Permissions",
};

/**
 * Calculate the number of Shift+Tab presses to go from `current` to `target`.
 * Returns 0 if already at target or modes are unknown.
 */
export function modeShiftTabCount(current: string | null, target: string): number {
  const from = MODE_CYCLE.indexOf((current || "default") as typeof MODE_CYCLE[number]);
  const to = MODE_CYCLE.indexOf(target as typeof MODE_CYCLE[number]);
  if (from === -1 || to === -1 || from === to) return 0;
  // Cycle forward: (to - from + len) % len
  return (to - from + MODE_CYCLE.length) % MODE_CYCLE.length;
}

/**
 * Cap a Set to maxSize, keeping the most recent entries (last added).
 * Mutates in place to preserve references.
 */
export function capSet<T>(set: Set<T>, maxSize: number): void {
  if (set.size <= maxSize) return;
  const keep = [...set].slice(-Math.floor(maxSize / 2));
  set.clear();
  for (const item of keep) set.add(item);
}

/**
 * Create a JSONL line parser for a socket/stream.
 * Buffers incoming data and calls `onLine` for each complete newline-delimited JSON line.
 */
export function createLineParser(onLine: (line: string) => void): (data: Buffer | string) => void {
  let buffer = "";
  return (data) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) {
      if (line.trim()) onLine(line);
    }
  };
}

/**
 * Safely unlink a file, ignoring ENOENT and EPERM (Windows file locks).
 */
export function safeUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "EPERM") throw err;
  }
}
