#!/usr/bin/env node

/**
 * Claude Code PermissionRequest hook — deterministic Allow/Deny answer
 * channel. Connects to the daemon, registers itself as the responder for
 * this tool_use_id, blocks until the user clicks an Allow/Deny button in
 * Discord, and returns the decision as a structured hookSpecificOutput.
 *
 * Replaces the legacy "send ENTER/ESC into the PTY" path in daemon.ts —
 * which assumed Yes was always the highlighted default. Falls through
 * (exit 0 with no decision) on any failure so the in-terminal dialog
 * still works as before:
 *   - daemon not running
 *   - no matching session
 *   - timeout (4 min) waiting for a click
 *   - daemon explicitly asks for passthrough (e.g. user already clicked
 *     before the hook arrived, daemon already keyboard-simulated it)
 *
 * Registered against the PermissionRequest event by cli.ts with a 5min
 * timeout (matched to the daemon-side wait window).
 */

import net from "node:net";
import { DAEMON_PIPE_NAME } from "./utils.js";

interface PermissionRequestHookInput {
  hook_event_name?: string;
  session_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  permission_mode?: string;
  agent_id?: string;
}

interface DaemonDecision {
  behavior: "allow" | "deny" | "passthrough";
  updatedInput?: Record<string, unknown>;
  message?: string;
}

const RESPONSE_TIMEOUT_MS = 4 * 60 * 1000;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8").trim();
}

function passthrough(): never {
  // Empty stdout, exit 0 — Claude proceeds with the normal dialog.
  process.exit(0);
}

function requestDecision(payload: PermissionRequestHookInput): Promise<DaemonDecision | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: DaemonDecision | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* already gone */ }
      resolve(result);
    };

    const timer = setTimeout(() => finish(null), RESPONSE_TIMEOUT_MS);

    const socket = net.createConnection(DAEMON_PIPE_NAME, () => {
      socket.write(JSON.stringify({
        type: "permission-request",
        sessionId: payload.session_id,
        toolUseId: payload.tool_use_id,
        toolName: payload.tool_name,
        toolInput: payload.tool_input,
        permissionMode: payload.permission_mode,
      }) + "\n");
    });

    let buf = "";
    socket.on("data", (data) => {
      buf += data.toString();
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      try {
        finish(JSON.parse(buf.slice(0, nl)) as DaemonDecision);
      } catch {
        finish(null);
      }
    });

    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
  });
}

async function main() {
  const raw = await readStdin();
  if (!raw) passthrough();

  let payload: PermissionRequestHookInput;
  try {
    payload = JSON.parse(raw);
  } catch {
    passthrough();
  }

  if (payload.hook_event_name !== "PermissionRequest") passthrough();
  if (!payload.session_id || !payload.tool_use_id || !payload.tool_name) passthrough();
  // Subagent permission requests are answered in their own context — leave
  // them to the regular flow so we don't double-resolve.
  if (payload.agent_id) passthrough();

  const decision = await requestDecision(payload);
  if (!decision || decision.behavior === "passthrough") passthrough();

  const hookSpecificOutput =
    decision.behavior === "allow"
      ? {
          hookEventName: "PermissionRequest",
          decision: {
            behavior: "allow" as const,
            ...(decision.updatedInput ? { updatedInput: decision.updatedInput } : {}),
          },
        }
      : {
          hookEventName: "PermissionRequest",
          decision: {
            behavior: "deny" as const,
            ...(decision.message ? { message: decision.message } : {}),
          },
        };

  process.stdout.write(JSON.stringify({ hookSpecificOutput }));
  process.exit(0);
}

main().catch(() => process.exit(0));
