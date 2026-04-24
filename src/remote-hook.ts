/**
 * UserPromptSubmit hook script.
 * Intercepts /remote commands before Claude sees them — zero API cost.
 *
 * Outputs {"decision":"block","reason":"..."} to stdout to prevent the prompt
 * from reaching the API while showing the reason to the user.
 */

import { findPipe, sendPipeMessage } from "./pipe-client.js";

interface HookInput {
  session_id: string;
  hook_event_name: string;
  prompt: string;
  /** Present when the UserPromptSubmit fires from inside a subagent run. */
  agent_id?: string;
  agent_type?: string;
}

function block(reason: string): never {
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
  process.exit(0);
}

async function main() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString()) as HookInput;
  const prompt = input.prompt.trim();
  const promptLower = prompt.toLowerCase();

  if (!promptLower.startsWith("/remote")) {
    // Not our command — pass through
    process.exit(0);
  }

  // Subagents shouldn't be able to toggle remote sync from inside a Task — the
  // /remote control surface is user-facing. Silently pass through.
  if (input.agent_id) {
    process.exit(0);
  }

  const args = prompt.slice("/remote".length).trim();
  const argsLower = args.toLowerCase();

  const pipe = process.env.CLAUDE_REMOTE_PIPE || findPipe();
  if (!pipe) {
    block("No active claude-remote instance. Start Claude with `claude-remote` instead of `claude`.");
  }

  if (argsLower === "off") {
    await sendPipeMessage(pipe, { type: "disable" });
    block("Discord sync disabled");
  }

  if (argsLower === "status") {
    const resp = await sendPipeMessage(pipe, { type: "status" });
    block(`Discord sync: ${resp?.active ? "ON" : "OFF"}`);
  }

  let action: "enable" | "disable";
  let channelName: string | undefined;

  if (argsLower === "on" || argsLower.startsWith("on ")) {
    action = "enable";
    channelName = args.slice(2).trim() || undefined;
  } else if (!args) {
    const response = await sendPipeMessage(pipe, { type: "status" });
    action = response?.active ? "disable" : "enable";
  } else {
    action = "enable";
    channelName = args;
  }

  if (action === "enable") {
    await sendPipeMessage(pipe, { type: "enable", sessionId: input.session_id, channelName });
    block(`Discord sync enabled${channelName ? ` (${channelName})` : ""}`);
  } else {
    await sendPipeMessage(pipe, { type: "disable" });
    block("Discord sync disabled");
  }
}

main().catch((err) => block(`[claude-remote] Hook error: ${err}`));
