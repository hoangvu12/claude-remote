/**
 * UserPromptSubmit hook script.
 * Intercepts /discord on|off commands before Claude sees them.
 */

import { findPipe, sendPipeMessage } from "./pipe-client.js";

interface HookInput {
  session_id: string;
  hook_event_name: string;
  prompt: string;
}

async function main() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString()) as HookInput;
  const prompt = input.prompt.trim().toLowerCase();

  if (!prompt.startsWith("/discord")) {
    process.exit(0);
  }

  const pipe = findPipe();
  if (!pipe) {
    process.stderr.write("[discord-rc] No active rc instance found. Start Claude with `discord-rc` instead of `claude`.\n");
    process.exit(2);
  }

  const args = input.prompt.trim().slice("/discord".length).trim();
  const argsLower = args.toLowerCase();

  if (argsLower === "off") {
    await sendPipeMessage(pipe, { type: "disable" });
    process.stderr.write("Discord sync disabled\n");
    process.exit(2);
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
    process.stderr.write(`Discord sync enabled${channelName ? ` (${channelName})` : ""}\n`);
  } else {
    await sendPipeMessage(pipe, { type: "disable" });
    process.stderr.write("Discord sync disabled\n");
  }
  process.exit(2);
}

main().catch((err) => {
  process.stderr.write(`[discord-rc] Hook error: ${err}\n`);
  process.exit(0);
});
