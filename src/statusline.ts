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

interface SessionData {
  model?: { display_name?: string };
  context_window?: { used_percentage?: number };
  cost?: { total_cost_usd?: number };
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

  const parts = [
    `[${model}]`,
    `${Math.round(context)}% ctx`,
  ];

  if (cost !== undefined) {
    parts.push(`$${cost.toFixed(3)}`);
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
