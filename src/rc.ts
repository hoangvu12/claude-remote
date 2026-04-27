import * as pty from "node-pty";
import type { IPty } from "node-pty";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { STATUS_FLAG, PIPE_REGISTRY, DAEMON_PIPE_NAME, safeUnlink, createLineParser } from "./utils.js";
import type { DaemonToClient, ClientToDaemon, PipeMessage } from "./types.js";

// ── Constants ──

const HOOK_PIPE_NAME = `\\\\.\\pipe\\claude-remote-${process.pid}`;
const SESSION_KEY = `rc-${process.pid}`;

// Use claude.exe explicitly to bypass any .cmd shim aliases we installed
const CLAUDE_BIN = "claude.exe";

// ── State ──

const cliArgs = process.argv.slice(2);
const claudeArgs = cliArgs.filter((a) => a !== "--remote");
const initialPermissionMode = cliArgs.includes("--dangerously-skip-permissions") ? "bypassPermissions" : "default";
const autoRemote = cliArgs.includes("--remote") || process.env.CLAUDE_REMOTE_AUTO === "1";

let daemonSocket: net.Socket | null = null;
let sessionId: string | null = null;
let transcriptPath: string | null = null;
let projectDir = process.cwd();
let daemonWasEnabled = false;
let lastChannelId: string | null = null;
let connecting = false;
let restarting = false;
let proc: IPty | null = null;
let sessionSource: "startup" | "resume" | "clear" | "compact" | undefined;

// ── Terminal restore (Windows ConPTY leaves win32-input-mode enabled) ──

function restoreTerminal() {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  if (process.platform === "win32") {
    process.stdout.write("\x1b[?9001l");
  }
  process.stdin.unref();
}

function setupTerminalInput() {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
}

// ── Spawn Claude in PTY ──

process.env.CLAUDE_REMOTE_PIPE = HOOK_PIPE_NAME;

function spawnClaude(): IPty {
  const p = pty.spawn(CLAUDE_BIN, claudeArgs, {
    name: "xterm-color",
    cols: process.stdout.columns || 120,
    rows: process.stdout.rows || 30,
    cwd: projectDir,
    env: process.env as Record<string, string>,
  });

  p.onData((data) => {
    process.stdout.write(data);
  });

  p.onExit(({ exitCode }) => {
    if (restarting) {
      restarting = false;
      sessionId = null;
      transcriptPath = null;
      console.log("[rc] Restarting Claude...");
      proc = spawnClaude();
      return;
    }
    restoreTerminal();
    disconnectDaemon();
    cleanupPipeServer();
    setStatusFlag(false);
    process.exit(exitCode);
  });

  return p;
}

proc = spawnClaude();

setupTerminalInput();
process.stdin.on("data", (data) => {
  proc?.write(data.toString());
});

process.stdout.on("resize", () => {
  proc?.resize(process.stdout.columns || 120, process.stdout.rows || 30);
});

// ── Hook Pipe Server (hooks → rc.ts) ──

let pipeServer: net.Server | null = null;

function startPipeServer() {
  pipeServer = net.createServer((socket) => {
    socket.on("data", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as PipeMessage;

        if (msg.type === "session-register") {
          const oldSessionId = sessionId;
          sessionId = msg.sessionId;
          transcriptPath = msg.transcriptPath;
          if (msg.cwd) projectDir = msg.cwd;
          sessionSource = msg.source;

          if (daemonWasEnabled && oldSessionId && oldSessionId !== sessionId) {
            disconnectDaemon();
            connectToDaemon();
          }

          if (autoRemote && !daemonSocket && !connecting) {
            connectToDaemon();
          }

          socket.write(JSON.stringify({ status: "ok" }));
        } else if (msg.type === "enable") {
          if (msg.sessionId) sessionId = msg.sessionId;
          connectToDaemon(msg.channelName);
          socket.write(JSON.stringify({ status: "ok", active: true }));
        } else if (msg.type === "disable") {
          daemonWasEnabled = false;
          disconnectDaemon();
          socket.write(JSON.stringify({ status: "ok", active: false }));
        } else if (msg.type === "state-signal") {
          // Relay state-signal to daemon with sessionKey; forward all optional fields.
          sendToDaemon({
            type: "state-signal",
            sessionKey: SESSION_KEY,
            event: msg.event,
            trigger: msg.trigger,
            customInstructions: msg.customInstructions,
            reason: msg.reason,
            notificationType: msg.notificationType,
            message: msg.message,
            title: msg.title,
            lastAssistantMessage: msg.lastAssistantMessage,
            errorCode: msg.errorCode,
            errorDetails: msg.errorDetails,
            toolName: msg.toolName,
            toolUseId: msg.toolUseId,
            durationMs: msg.durationMs,
            agentId: msg.agentId,
            parentToolUseId: msg.parentToolUseId,
          });
          socket.write(JSON.stringify({ status: "ok" }));
        } else if (msg.type === "status") {
          socket.write(JSON.stringify({ status: "ok", active: daemonSocket !== null }));
        }
      } catch {
        socket.write(JSON.stringify({ status: "error" }));
      }
      socket.end();
    });
  });

  pipeServer.on("error", () => {});
  pipeServer.listen(HOOK_PIPE_NAME, () => { registerPipe(); });
}

function registerPipe() {
  try {
    fs.mkdirSync(PIPE_REGISTRY, { recursive: true });
    fs.writeFileSync(path.join(PIPE_REGISTRY, `${process.pid}.json`), JSON.stringify({
      pid: process.pid,
      pipe: HOOK_PIPE_NAME,
      cwd: projectDir,
      startedAt: new Date().toISOString(),
    }));
  } catch { /* best effort */ }
}

function unregisterPipe() {
  safeUnlink(path.join(PIPE_REGISTRY, `${process.pid}.json`));
}

function cleanupPipeServer() {
  if (pipeServer) { pipeServer.close(); pipeServer = null; }
  unregisterPipe();
}

// ── Status flag ──

function setStatusFlag(active: boolean) {
  if (active) {
    fs.mkdirSync(path.dirname(STATUS_FLAG), { recursive: true });
    fs.writeFileSync(STATUS_FLAG, String(process.pid));
  } else {
    safeUnlink(STATUS_FLAG);
  }
}

// ── Daemon connection management ──

let lastChannelName: string | undefined;

function sendToDaemon(msg: ClientToDaemon) {
  if (daemonSocket && !daemonSocket.destroyed) {
    try {
      daemonSocket.write(JSON.stringify(msg) + "\n");
    } catch { /* socket gone */ }
  }
}

function handleDaemonMessage(msg: DaemonToClient) {
  if (msg.sessionKey !== SESSION_KEY) return; // not for us
  if (msg.type === "pty-write") {
    if (msg.raw) {
      proc?.write(msg.text);
    } else if (msg.text.includes("\n") || msg.text.length >= 800) {
      // Claude Code debounces paste completion by 100ms (usePasteHandler.ts)
      // and auto-treats any chunk >800 chars as paste. Appending \r to the
      // same write gets it absorbed into the paste buffer as a literal
      // newline instead of a submit, so send \r on a delayed timer well
      // clear of the 100ms debounce. Second \r is a safety retry; Enter on
      // an empty prompt is a no-op.
      //
      // For image-path pastes, usePasteHandler kicks off async Sharp resize
      // (imageResizer.ts) inside Promise.all before calling onImagePaste.
      // On Windows the cold-start of Sharp regularly exceeds 300ms, so a
      // 400ms Enter races the resize and submits an empty/partial buffer.
      // Use a much longer delay when the paste contains an image path.
      const hasImagePath = /\.(png|jpe?g|gif|webp)(\s|$)/i.test(msg.text);
      const firstEnter = hasImagePath ? 1500 : 400;
      const secondEnter = hasImagePath ? 3000 : 900;
      proc?.write(`\x1b[200~${msg.text}\x1b[201~`);
      setTimeout(() => proc?.write("\r"), firstEnter);
      setTimeout(() => proc?.write("\r"), secondEnter);
    } else {
      // Short single-line text. Even though we don't wrap in bracketed
      // paste markers, ConPTY on Windows can fragment a single PTY write
      // into multiple input events arriving < 100ms apart. When that
      // happens Claude's usePasteHandler still batches the burst as a
      // paste and the trailing \r becomes a literal newline — the user
      // sees their text + a blank line and no submit. Defer the Enter
      // past the 100ms debounce window so it's never absorbed into the
      // burst, with a safety retry like the paste branch.
      proc?.write(msg.text);
      setTimeout(() => proc?.write("\r"), 250);
      setTimeout(() => proc?.write("\r"), 600);
    }
  } else if (msg.type === "daemon-ready") {
    lastChannelId = msg.channelId;
    setStatusFlag(true);
  } else if (msg.type === "restart") {
    restartClaude();
  }
}

function restartClaude() {
  if (restarting || !proc) return;
  restarting = true;
  // Claude Code's useExitOnCtrlCD wants two presses of the SAME key within a
  // ~2s window. Mixing Ctrl+C and Ctrl+D resets each other's pending state and
  // never confirms. Cancel any in-flight work with Escape first, then double
  // Ctrl+D to cleanly exit.
  proc.write("\x1b");
  setTimeout(() => {
    proc?.write("\x04");
    setTimeout(() => proc?.write("\x04"), 250);
    setTimeout(() => {
      if (restarting && proc) proc.kill();
    }, 3000);
  }, 300);
}

function spawnDaemon() {
  const daemonPath = path.resolve(import.meta.dirname, "daemon.js");
  const logDir = path.join(os.homedir(), ".claude-remote");
  fs.mkdirSync(logDir, { recursive: true });
  const logFd = fs.openSync(path.join(logDir, "daemon.log"), "a");
  const child = spawn(process.execPath, [daemonPath], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN || "",
      DISCORD_GUILD_ID: process.env.DISCORD_GUILD_ID || "",
      DISCORD_CATEGORY_ID: process.env.DISCORD_CATEGORY_ID || "",
    },
  });
  child.unref();
  fs.closeSync(logFd);
  console.log(`[rc] Spawned daemon (PID ${child.pid})`);
}

function connectToDaemon(channelName?: string) {
  daemonWasEnabled = true;
  if (channelName !== undefined) lastChannelName = channelName;
  if (daemonSocket && !daemonSocket.destroyed) return;
  if (!sessionId) return;
  if (connecting) return;

  connecting = true;

  let attempts = 0;
  const maxAttempts = 15;
  let spawned = false;

  const tryConnect = () => {
    attempts++;
    const socket = net.connect(DAEMON_PIPE_NAME);

    socket.on("connect", () => {
      connecting = false;
      daemonSocket = socket;
      setStatusFlag(true);

      // Send session info
      sendToDaemon({
        type: "session-info",
        sessionKey: SESSION_KEY,
        sessionId: sessionId!,
        projectDir,
        channelName: lastChannelName,
        transcriptPath: transcriptPath || undefined,
        reuseChannelId: lastChannelId || undefined,
        initialPermissionMode,
        sessionSource,
      });

      // Handle incoming messages from daemon (JSONL framing)
      socket.on("data", createLineParser((line) => {
        try {
          handleDaemonMessage(JSON.parse(line) as DaemonToClient);
        } catch { /* parse error */ }
      }));

      socket.on("close", () => {
        // Only act if this is still the active socket (not replaced by reconnect)
        if (daemonSocket !== socket) return;
        daemonSocket = null;
        setStatusFlag(false);
        if (daemonWasEnabled) {
          console.log("[rc] Daemon connection lost, reconnecting in 2s...");
          setTimeout(() => connectToDaemon(lastChannelName), 2000);
        }
      });

      socket.on("error", () => {
        // handled by close
      });
    });

    socket.on("error", (err: NodeJS.ErrnoException) => {
      socket.destroy();
      if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
        if (!spawned) {
          spawned = true;
          spawnDaemon();
        }
        if (attempts < maxAttempts) {
          // Backoff: 300ms, 500ms, 700ms, ...
          const delay = 200 + attempts * 200;
          setTimeout(tryConnect, delay);
        } else {
          connecting = false;
          console.error("[rc] Failed to connect to daemon after", maxAttempts, "attempts");
          setStatusFlag(false);
        }
      } else {
        connecting = false;
        console.error("[rc] Daemon connect error:", err.message);
        setStatusFlag(false);
      }
    });
  };

  tryConnect();
}

function disconnectDaemon() {
  daemonWasEnabled = false;
  if (daemonSocket && !daemonSocket.destroyed) {
    sendToDaemon({ type: "session-disconnect", sessionKey: SESSION_KEY });
    // Store ref — clear daemonSocket first so async close handler
    // doesn't trigger reconnect after connectToDaemon sets daemonWasEnabled=true
    const sock = daemonSocket;
    daemonSocket = null;
    sock.destroy();
  } else {
    daemonSocket = null;
  }
  setStatusFlag(false);
}

// ── Start ──

startPipeServer();

// ── Graceful shutdown ──

function shutdown() {
  restoreTerminal();
  disconnectDaemon();
  cleanupPipeServer();
  proc?.kill();
  setTimeout(() => process.exit(0), 500);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
