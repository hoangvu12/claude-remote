#!/usr/bin/env node

/**
 * Claude Code lifecycle hook — forwards deterministic state signals to rc.ts.
 * Registered against these hook events in settings.json:
 *   - Stop           → `stop`             (turn end; replaces idle-heuristic)
 *   - StopFailure    → `stop-failure`     (turn ended due to API error)
 *   - PostCompact    → `post-compact`     (context just got truncated)
 *   - PreCompact     → `pre-compact`      (context about to be truncated)
 *   - Notification   → `notification`     (permission prompt / elicitation / etc)
 *   - SessionEnd     → `session-end`      (clean exit, reason-distinguished)
 *   - SubagentStart  → `subagent-start`   (Task/Agent subagent spawned)
 *   - SubagentStop   → `subagent-end`     (subagent finished, includes duration)
 *
 * Only activates when CLAUDE_REMOTE_PIPE is set (by rc.ts).
 */

import { sendPipeMessage } from "./pipe-client.js";
import type { StateSignalEvent } from "./types.js";

interface HookPayload {
  hook_event_name?: string;
  // Stop
  stop_hook_active?: boolean;
  last_assistant_message?: string;
  // PreCompact / PostCompact
  trigger?: "manual" | "auto";
  custom_instructions?: string;
  compact_summary?: string;
  // Notification
  notification_type?: string;
  message?: string;
  title?: string;
  // SessionEnd
  reason?: "clear" | "resume" | "logout" | "prompt_input_exit" | "other" | "bypass_permissions_disabled";
  // StopFailure — error code is one of: authentication_failed, billing_error,
  // rate_limit, invalid_request, server_error, unknown
  error?: string;
  error_details?: string;
  // Subagent metadata — for non-Subagent* events we skip when agent_id is set
  // so subagent-originated signals don't double-fire alongside the main
  // agent's own events. SubagentStart/SubagentStop carry agent_id by design.
  agent_id?: string;
  parent_tool_use_id?: string;
  duration_ms?: number;
  is_error?: boolean;
}

async function main() {
  const pipeName = process.env.CLAUDE_REMOTE_PIPE;
  if (!pipeName) process.exit(0);

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const input = Buffer.concat(chunks).toString("utf-8").trim();
  if (!input) process.exit(0);

  let payload: HookPayload;
  try {
    payload = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  const event = payload.hook_event_name;
  if (!event) process.exit(0);

  const isSubagentEvent = event === "SubagentStart" || event === "SubagentStop";
  // Skip subagent-originated signals on the *main-thread* events, but pass
  // through SubagentStart/SubagentStop where agent_id is the identifier we
  // need.
  if (!isSubagentEvent && payload.agent_id) process.exit(0);

  let mapped: StateSignalEvent | null = null;
  switch (event) {
    case "Stop":
      mapped = "stop";
      break;
    case "StopFailure":
      mapped = "stop-failure";
      break;
    case "PostCompact":
      mapped = "post-compact";
      break;
    case "PreCompact":
      mapped = "pre-compact";
      break;
    case "Notification":
      mapped = "notification";
      break;
    case "SessionEnd":
      mapped = "session-end";
      break;
    case "SubagentStart":
      mapped = "subagent-start";
      break;
    case "SubagentStop":
      mapped = payload.is_error ? "subagent-failure" : "subagent-end";
      break;
  }

  if (!mapped) process.exit(0);

  try {
    await sendPipeMessage(pipeName, {
      type: "state-signal",
      event: mapped,
      trigger: payload.trigger,
      customInstructions: payload.custom_instructions,
      reason: payload.reason,
      notificationType: payload.notification_type,
      message: payload.message ?? payload.compact_summary,
      title: payload.title,
      lastAssistantMessage: payload.last_assistant_message,
      errorCode: payload.error,
      errorDetails: payload.error_details,
      agentId: payload.agent_id,
      parentToolUseId: payload.parent_tool_use_id,
      durationMs: payload.duration_ms,
    });
  } catch {
    // best effort
  }
}

main().catch(() => process.exit(0));
