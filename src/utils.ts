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
  ALLOW_ALWAYS: "allow-always:",
  EDIT_ALLOW: "edit-allow:",
  DENY: "deny:",
  ASK: "ask:",
  ASK_OTHER: "ask-other:",
  ASK_SUBMIT: "ask-submit:",
  MODAL: "modal:",
  PLAN: "plan:",
  PLAN_FEEDBACK: "plan-feedback:",
  MODE: "mode:",
  QUEUE_EDIT: "queue-edit:",
  ELICIT_ACCEPT: "elicit-accept:",
  ELICIT_DECLINE: "elicit-decline:",
  ELICIT_CANCEL: "elicit-cancel:",
  CLEANUP_CONFIRM: "cleanup-confirm:",
  CLEANUP_CANCEL: "cleanup-cancel:",
} as const;

// ── Daemon paths ──

export const SESSIONS_FILE = path.join(CONFIG_DIR, "sessions.json");

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

export function plural(n: number, singular: string, pluralForm = singular + "s"): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

export function resolveJSONLPath(sessionId: string, cwd: string): string {
  const claudeDir = path.join(getClaudeDir(), "projects");
  const encoded = encodeProjectPath(cwd);
  return path.join(claudeDir, encoded, `${sessionId}.jsonl`);
}

/**
 * Subagent transcripts live one level under the parent session — verified
 * against upstream `getAgentTranscriptPath` and the `subagents/agent-<id>.jsonl`
 * naming pattern referenced in src/utils/stats.ts. Layout:
 *   <claudeDir>/projects/<encoded-cwd>/<parentSessionId>/subagents/agent-<agentId>.jsonl
 * The directory may not exist yet when SubagentStart fires; chokidar handles
 * non-existent paths via its parent-directory fallback.
 */
export function resolveSubagentJSONLPath(parentSessionId: string, cwd: string, agentId: string): string {
  const claudeDir = path.join(getClaudeDir(), "projects");
  const encoded = encodeProjectPath(cwd);
  return path.join(claudeDir, encoded, parentSessionId, "subagents", `agent-${agentId}.jsonl`);
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
//
// Mirrors upstream's `immediate: true` + `type: 'local-jsx'` command set in
// src/commands/*/index.ts — these run entirely in the TUI without contacting
// the API, so they should not flip activity to "thinking" when seen in JSONL.

const LOCAL_COMMANDS = [
  "/model", "/fast", "/login", "/logout",
  "/help", "/cost", "/mcp", "/stats",
  "/agents", "/add-dir", "/clear", "/compact", "/config", "/context",
  "/copy", "/diff", "/doctor", "/effort", "/env", "/exit", "/export",
  "/files", "/hooks", "/ide", "/init", "/memory", "/onboarding",
  "/output-style", "/permissions", "/plugin", "/release-notes",
  "/rename", "/resume", "/review", "/security-review", "/skills",
  "/status", "/tag", "/theme", "/tasks", "/usage", "/vim",
];

/** Check if a message is a local-only CLI command that won't trigger an API call */
export function isLocalCommand(text: string): boolean {
  return LOCAL_COMMANDS.some((c) => text === c || text.startsWith(c + " "));
}

// ── Permission mode cycling (matches Claude Code's Shift+Tab order) ──
//
// Claude Code computes the Shift+Tab next-mode dynamically (see upstream
// getNextPermissionMode.ts). `bypassPermissions` only appears in the cycle
// when `isBypassPermissionsModeAvailable` — i.e. the user launched with
// `--dangerously-skip-permissions` AND settings don't disable it. For regular
// users the cycle is 3-way (default → acceptEdits → plan → default).

const MODE_CYCLE_WITH_BYPASS = ["default", "acceptEdits", "plan", "bypassPermissions"] as const;
const MODE_CYCLE_NO_BYPASS = ["default", "acceptEdits", "plan"] as const;

export const MODE_LABELS: Record<string, string> = {
  default: "Default",
  acceptEdits: "Accept edits",
  plan: "Plan Mode",
  bypassPermissions: "Bypass Permissions",
};

export type CycleMode = typeof MODE_CYCLE_WITH_BYPASS[number];

/** Return the cycle order for a session based on whether bypass is reachable. */
export function getModeCycle(bypassAvailable: boolean): readonly CycleMode[] {
  return bypassAvailable ? MODE_CYCLE_WITH_BYPASS : MODE_CYCLE_NO_BYPASS;
}

/**
 * Calculate the number of Shift+Tab presses to go from `current` to `target`
 * given the available cycle. Returns 0 if already at target or either mode is
 * not in the cycle (callers should check `isModeReachable` first).
 */
export function modeShiftTabCount(current: string | null, target: string, cycle: readonly CycleMode[]): number {
  const from = cycle.indexOf((current || "default") as CycleMode);
  const to = cycle.indexOf(target as CycleMode);
  if (from === -1 || to === -1 || from === to) return 0;
  return (to - from + cycle.length) % cycle.length;
}

/** True if `target` appears in the provided cycle. */
export function isModeReachable(target: string, cycle: readonly CycleMode[]): boolean {
  return cycle.includes(target as CycleMode);
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
