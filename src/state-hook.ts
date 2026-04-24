#!/usr/bin/env node

/**
 * Claude Code lifecycle hook — forwards deterministic state signals to rc.ts.
 * Registered against these hook events in settings.json:
 *   - Stop           → `stop`          (turn end; replaces idle-heuristic)
 *   - PostCompact    → `post-compact`  (context just got truncated)
 *   - PreCompact     → `pre-compact`   (context about to be truncated)
 *   - Notification   → `notification`  (permission prompt / elicitation / etc)
 *   - SessionEnd     → `session-end`   (clean exit, reason-distinguished)
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
  // Subagent metadata — we skip subagent-originated signals because they
  // would double-fire alongside the main agent's own events.
  agent_id?: string;
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
  if (payload.agent_id) process.exit(0); // ignore subagent-originated signals

  let mapped: StateSignalEvent | null = null;
  switch (event) {
    case "Stop":
      mapped = "stop";
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
    });
  } catch {
    // best effort
  }
}

main().catch(() => process.exit(0));
