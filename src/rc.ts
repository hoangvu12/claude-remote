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
          // Relay state-signal to daemon with sessionKey
          sendToDaemon({ type: "state-signal", sessionKey: SESSION_KEY, event: msg.event, trigger: msg.trigger });
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
    } else if (msg.text.includes("\n")) {
      proc?.write(`\x1b[200~${msg.text}\x1b[201~`);
    } else {
      proc?.write(msg.text + "\r");
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
  // Send Ctrl+C then Ctrl+D to exit Claude gracefully
  proc.write("\x03");
  setTimeout(() => {
    proc?.write("\x03");
    setTimeout(() => {
      proc?.write("\x04");
      // If Claude doesn't exit within 3s, force kill
      setTimeout(() => {
        if (restarting && proc) {
          proc.kill();
        }
      }, 3000);
    }, 300);
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
