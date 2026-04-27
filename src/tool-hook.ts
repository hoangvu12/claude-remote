#!/usr/bin/env node

/**
 * Claude Code tool lifecycle hooks — forwards deterministic timing signals
 * to rc.ts. Registered against:
 *   - PreToolUse          → `tool-start`    (tool is about to execute)
 *   - PostToolUse         → `tool-end`      (tool finished successfully)
 *   - PostToolUseFailure  → `tool-failure`  (tool execution errored)
 *
 * The render pipeline is still driven from the JSONL transcript (handlers/
 * tool-use.ts + tool-result.ts). These hooks exist purely so:
 *   1. Activity state ("working" / idle) flips at the exact moment the tool
 *      starts/ends instead of waiting on chokidar's ~250ms write-finish window
 *   2. Progress timers ("Running... 30s") cancel instantly when the tool
 *      finishes, instead of leaving a stale message until JSONL catches up
 *   3. Failures vs. successes are distinguished structurally instead of
 *      inferred from the `is_error` flag on the eventual tool_result block
 *
 * Subagent tool calls (agent_id present) are skipped — they would
 * double-fire alongside the main agent's own events for the wrapping Task
 * tool. Only activates when CLAUDE_REMOTE_PIPE is set (by rc.ts).
 */

import { sendPipeMessage } from "./pipe-client.js";
import type { StateSignalEvent } from "./types.js";

interface HookPayload {
  hook_event_name?: string;
  tool_name?: string;
  tool_use_id?: string;
  agent_id?: string;
  /**
   * Authoritative tool execution time, present on PostToolUse and
   * PostToolUseFailure (Claude Code 2.1.119+). Excludes permission prompts
   * and PreToolUse hook latency.
   */
  duration_ms?: number;
}

async function main() {
  const pipeName = process.env.CLAUDE_REMOTE_PIPE;
  if (!pipeName) process.exit(0);

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const input = Buffer.concat(chunks).toString("utf-8").trim();
  if (!input) process.exit(0);

  let payload: HookPayload;
  try {
    payload = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  if (payload.agent_id) process.exit(0);
  if (!payload.tool_use_id || !payload.tool_name) process.exit(0);

  let mapped: StateSignalEvent | null = null;
  switch (payload.hook_event_name) {
    case "PreToolUse":
      mapped = "tool-start";
      break;
    case "PostToolUse":
      mapped = "tool-end";
      break;
    case "PostToolUseFailure":
      mapped = "tool-failure";
      break;
  }
  if (!mapped) process.exit(0);

  try {
    await sendPipeMessage(pipeName, {
      type: "state-signal",
      event: mapped,
      toolName: payload.tool_name,
      toolUseId: payload.tool_use_id,
      durationMs: payload.duration_ms,
    });
  } catch {
    // best effort — JSONL fallback still drives the render
  }
}

main().catch(() => process.exit(0));
