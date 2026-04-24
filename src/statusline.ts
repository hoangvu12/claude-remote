#!/usr/bin/env node

/**
 * Claude Code statusline script.
 * Shows "Remote: On/Off" alongside model info in the status bar.
 *
 * Receives JSON session data on stdin from Claude Code.
 * Prints formatted status text to stdout.
 */

import fs from "node:fs";
import path from "node:path";
import { STATUS_FLAG, CONFIG_DIR } from "./utils.js";

/**
 * Shape of `buildStatusLineCommandInput` from upstream (components/StatusLine.tsx).
 * All fields are optional — upstream adds fields over time and we only render
 * what's present.
 */
interface SessionData {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  permission_mode?: string;
  session_name?: string;
  version?: string;
  model?: { id?: string; display_name?: string };
  workspace?: { current_dir?: string; project_dir?: string; added_dirs?: string[] };
  output_style?: { name?: string };
  cost?: {
    total_cost_usd?: number;
    total_duration_ms?: number;
    total_api_duration_ms?: number;
    total_lines_added?: number;
    total_lines_removed?: number;
  };
  context_window?: {
    total_input_tokens?: number;
    total_output_tokens?: number;
    context_window_size?: number;
    current_usage?: number;
    used_percentage?: number;
    remaining_percentage?: number;
  };
  exceeds_200k_tokens?: boolean;
  rate_limits?: {
    five_hour?: { used_percentage?: number; resets_at?: string };
    seven_day?: { used_percentage?: number; resets_at?: string };
  };
  vim?: { mode?: string };
  agent?: { name?: string };
  remote?: { session_id?: string };
  worktree?: { name?: string; path?: string; branch?: string; original_cwd?: string; original_branch?: string };
}

// Read session JSON from stdin
const chunks: Buffer[] = [];
process.stdin.on("data", (chunk) => chunks.push(chunk as Buffer));
process.stdin.on("end", () => {
  let session: SessionData = {};
  try {
    session = JSON.parse(Buffer.concat(chunks).toString());
  } catch { /* use defaults */ }

  const model = session.model?.display_name || "Claude";
  const context = session.context_window?.used_percentage ?? 0;
  const cost = session.cost?.total_cost_usd;
  const exceeds200k = session.exceeds_200k_tokens === true;
  const rateFiveHour = session.rate_limits?.five_hour?.used_percentage;
  const worktree = session.worktree;
  const outputStyle = session.output_style?.name;
  const vimMode = session.vim?.mode;

  // Check if Discord RC daemon is active for THIS session.
  // CLAUDE_REMOTE_PIPE is only set when running under claude-remote (rc.ts).
  // Its format is \\.\pipe\claude-remote-{pid}, so extract the rc PID from it.
  let isActive = false;
  const pipeName = process.env.CLAUDE_REMOTE_PIPE;
  if (pipeName) {
    const rcPidMatch = pipeName.match(/claude-remote-(\d+)$/);
    const rcPid = rcPidMatch ? parseInt(rcPidMatch[1], 10) : null;
    try {
      const flagPid = parseInt(fs.readFileSync(STATUS_FLAG, "utf-8").trim(), 10);
      if (flagPid && rcPid && flagPid === rcPid) {
        process.kill(flagPid, 0); // throws if process doesn't exist
        isActive = true;
      }
    } catch {
      // File missing or PID dead — clean up stale flag
      try { fs.unlinkSync(STATUS_FLAG); } catch { /* already gone */ }
    }
  }
  const rcStatus = isActive
    ? "\x1b[32m● On\x1b[0m"   // green dot
    : "\x1b[90m○ Off\x1b[0m"; // dim

  const ctxLabel = exceeds200k
    ? `\x1b[31m${Math.round(context)}% ctx!\x1b[0m`
    : context >= 80
      ? `\x1b[33m${Math.round(context)}% ctx\x1b[0m`
      : `${Math.round(context)}% ctx`;

  const parts = [
    `[${model}]`,
    ctxLabel,
  ];

  if (cost !== undefined) {
    parts.push(`$${cost.toFixed(3)}`);
  }

  if (rateFiveHour !== undefined && rateFiveHour >= 80) {
    // Warn when the 5h rate-limit bucket is getting full.
    parts.push(`\x1b[33m${Math.round(rateFiveHour)}% 5h\x1b[0m`);
  }

  if (worktree?.name) {
    parts.push(`\x1b[36m⎇ ${worktree.name}\x1b[0m`);
  }

  if (vimMode) {
    parts.push(`\x1b[35m${vimMode.toUpperCase()}\x1b[0m`);
  }

  if (outputStyle && outputStyle !== "default") {
    parts.push(`\x1b[90m(${outputStyle})\x1b[0m`);
  }

  parts.push(`Remote: ${rcStatus}`);

  // Check for available update
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, "update-check.json"), "utf-8")) as { latestVersion?: string };
    const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf-8")) as { version?: string };
    if (cache.latestVersion && pkg.version && cache.latestVersion !== pkg.version) {
      parts.push(`\x1b[33m↑ ${cache.latestVersion}\x1b[0m`);
    }
  } catch { /* no cache or no update */ }

  process.stdout.write(parts.join("  "));
});
