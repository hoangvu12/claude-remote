#!/usr/bin/env node

/**
 * Standalone CLI for /remote skill.
 * Called by Claude Code's Bash tool via the skill.
 *
 * Usage:
 *   remote-cmd                  → toggle
 *   remote-cmd on [name]        → enable, optional channel name
 *   remote-cmd off              → disable
 *   remote-cmd status           → print current state
 */

import { findPipe, sendPipeMessage } from "./pipe-client.js";

async function main() {
  const args = process.argv.slice(2);
  const subcommand = args[0]?.toLowerCase();

  const pipe = process.env.CLAUDE_REMOTE_PIPE || findPipe();
  if (!pipe) {
    console.log("ERROR: No active claude-remote instance. Start Claude with `claude-remote` instead of `claude`.");
    process.exit(1);
  }

  if (subcommand === "status") {
    const resp = await sendPipeMessage(pipe, { type: "status" });
    console.log(resp?.active ? "ON" : "OFF");
    return;
  }

  if (subcommand === "off") {
    await sendPipeMessage(pipe, { type: "disable" });
    console.log("Discord sync disabled");
    return;
  }

  if (subcommand === "on") {
    const channelName = args.slice(1).join(" ") || undefined;
    await sendPipeMessage(pipe, { type: "enable", channelName });
    console.log(`Discord sync enabled${channelName ? ` (${channelName})` : ""}`);
    return;
  }

  // No subcommand = toggle
  const resp = await sendPipeMessage(pipe, { type: "status" });
  if (resp?.active) {
    await sendPipeMessage(pipe, { type: "disable" });
    console.log("Discord sync disabled");
  } else {
    const channelName = args.join(" ") || undefined;
    await sendPipeMessage(pipe, { type: "enable", channelName });
    console.log(`Discord sync enabled${channelName ? ` (${channelName})` : ""}`);
  }
}

main().catch((err) => {
  console.log(`ERROR: ${err.message}`);
  process.exit(1);
});
