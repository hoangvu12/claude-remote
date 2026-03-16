#!/usr/bin/env node

/**
 * Claude Code statusline script.
 * Shows "Discord RC: On/Off" alongside model info in the status bar.
 *
 * Receives JSON session data on stdin from Claude Code.
 * Prints formatted status text to stdout.
 */

import fs from "node:fs";
import { STATUS_FLAG } from "./utils.js";

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

  // Check if Discord RC daemon is active
  const isActive = fs.existsSync(STATUS_FLAG);
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

  parts.push(`Discord RC: ${rcStatus}`);

  process.stdout.write(parts.join("  "));
});
