import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Shared paths ──

export const CONFIG_DIR = path.join(os.homedir(), ".discord-rc");
export const STATUS_FLAG = path.join(CONFIG_DIR, "active");
export const PIPE_REGISTRY = path.join(CONFIG_DIR, "pipes");

// ── Discord custom ID prefixes ──

export const ID_PREFIX = {
  ALLOW: "allow:",
  DENY: "deny:",
  ASK: "ask:",
  ASK_OTHER: "ask-other:",
  MODAL: "modal:",
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

export function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + "…" : str;
}

export function resolveJSONLPath(sessionId: string, cwd: string): string {
  const claudeDir = path.join(os.homedir(), ".claude", "projects");
  const encoded = encodeProjectPath(cwd);
  return path.join(claudeDir, encoded, `${sessionId}.jsonl`);
}

/**
 * Extract text content from a tool_result block.
 */
export function extractToolResultText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b) => b.text || "").join("\n");
  }
  return "";
}

/**
 * Safely unlink a file, ignoring ENOENT.
 */
export function safeUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
