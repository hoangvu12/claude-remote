#!/usr/bin/env node

/**
 * Claude Code Elicitation hook — MCP server form-input channel.
 *
 * Mirrors the permission-hook.ts pattern: blocks until the user submits a
 * Discord modal, then returns the structured response via hookSpecificOutput.
 * Falls through (passthrough) when:
 *   - daemon not running
 *   - no matching session
 *   - timeout (4 min) waiting for a response
 *   - daemon explicitly asks for passthrough
 *
 * Both `Elicitation` and `ElicitationResult` events route here. Elicitation
 * is the request side; ElicitationResult is the observability side (we
 * forward it to the daemon for logging but don't override).
 *
 * Registered against the Elicitation event with a 5min timeout (matched to
 * the daemon-side wait window).
 */

import net from "node:net";
import { DAEMON_PIPE_NAME } from "./utils.js";

interface ElicitationHookInput {
  hook_event_name?: string;
  session_id?: string;
  mcp_server_name?: string;
  message?: string;
  mode?: "form" | "url";
  url?: string;
  elicitation_id?: string;
  requested_schema?: Record<string, unknown>;
  // ElicitationResult-specific
  action?: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

interface DaemonElicitationDecision {
  action: "accept" | "decline" | "cancel" | "passthrough";
  content?: Record<string, unknown>;
}

const RESPONSE_TIMEOUT_MS = 4 * 60 * 1000;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8").trim();
}

function passthrough(): never {
  process.exit(0);
}

function requestDecision(payload: ElicitationHookInput): Promise<DaemonElicitationDecision | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: DaemonElicitationDecision | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* already gone */ }
      resolve(result);
    };

    const timer = setTimeout(() => finish(null), RESPONSE_TIMEOUT_MS);

    const socket = net.createConnection(DAEMON_PIPE_NAME, () => {
      socket.write(JSON.stringify({
        type: "elicitation-request",
        sessionId: payload.session_id,
        elicitationId: payload.elicitation_id,
        mcpServerName: payload.mcp_server_name,
        message: payload.message,
        mode: payload.mode,
        url: payload.url,
        requestedSchema: payload.requested_schema,
      }) + "\n");
    });

    let buf = "";
    socket.on("data", (data) => {
      buf += data.toString();
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      try {
        finish(JSON.parse(buf.slice(0, nl)) as DaemonElicitationDecision);
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

  let payload: ElicitationHookInput;
  try {
    payload = JSON.parse(raw);
  } catch {
    passthrough();
  }

  // ElicitationResult is observability-only — forward without blocking the
  // turn. The daemon logs it; we never override the action.
  if (payload.hook_event_name === "ElicitationResult") {
    passthrough();
  }

  if (payload.hook_event_name !== "Elicitation") passthrough();
  if (!payload.session_id) passthrough();

  const decision = await requestDecision(payload);
  if (!decision || decision.action === "passthrough") passthrough();

  const hookSpecificOutput = {
    hookEventName: "Elicitation",
    action: decision.action,
    ...(decision.content ? { content: decision.content } : {}),
  };

  process.stdout.write(JSON.stringify({ hookSpecificOutput }));
  process.exit(0);
}

main().catch(() => process.exit(0));
