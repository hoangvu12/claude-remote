import * as pty from "node-pty";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import { fork, type ChildProcess } from "node:child_process";
import { STATUS_FLAG, PIPE_REGISTRY, safeUnlink } from "./utils.js";
import type { DaemonToParent, PipeMessage } from "./types.js";

// ── Constants ──

const PIPE_NAME = `\\\\.\\pipe\\discord-rc-${process.pid}`;

// Use claude.exe explicitly to bypass any .cmd shim aliases we installed
const CLAUDE_BIN = "claude.exe";

// ── State ──

let daemon: ChildProcess | null = null;
let sessionId: string | null = null;
let transcriptPath: string | null = null;
let projectDir = process.cwd();
let daemonWasEnabled = false;
let lastChannelId: string | null = null;

// ── Spawn Claude in PTY ──

// Set env var so the SessionStart hook only connects to THIS rc instance
process.env.DISCORD_RC_PIPE = PIPE_NAME;

const proc = pty.spawn(CLAUDE_BIN, process.argv.slice(2), {
  name: "xterm-color",
  cols: process.stdout.columns || 120,
  rows: process.stdout.rows || 30,
  cwd: projectDir,
  env: process.env as Record<string, string>,
});

proc.onData((data) => {
  process.stdout.write(data);
});

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();
process.stdin.on("data", (data) => {
  proc.write(data.toString());
});

process.stdout.on("resize", () => {
  proc.resize(process.stdout.columns || 120, process.stdout.rows || 30);
});

proc.onExit(({ exitCode }) => {
  stopDaemon();
  cleanupPipeServer();
  setStatusFlag(false);
  process.exit(exitCode);
});

// ── Named Pipe Server ──

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

          // If daemon was running on a different session, restart it
          if (daemonWasEnabled && oldSessionId && oldSessionId !== sessionId) {
            stopDaemon();
            startDaemon();
          }

          socket.write(JSON.stringify({ status: "ok" }));
        } else if (msg.type === "enable") {
          if (msg.sessionId) sessionId = msg.sessionId;
          startDaemon(msg.channelName);
          socket.write(JSON.stringify({ status: "ok", active: true }));
        } else if (msg.type === "disable") {
          daemonWasEnabled = false;
          stopDaemon();
          socket.write(JSON.stringify({ status: "ok", active: false }));
        } else if (msg.type === "status") {
          socket.write(JSON.stringify({ status: "ok", active: daemon !== null }));
        }
      } catch {
        socket.write(JSON.stringify({ status: "error" }));
      }
      socket.end();
    });
  });

  pipeServer.on("error", () => {});

  pipeServer.listen(PIPE_NAME, () => {
    registerPipe();
  });
}

function registerPipe() {
  try {
    fs.mkdirSync(PIPE_REGISTRY, { recursive: true });
    fs.writeFileSync(path.join(PIPE_REGISTRY, `${process.pid}.json`), JSON.stringify({
      pid: process.pid,
      pipe: PIPE_NAME,
      cwd: projectDir,
      startedAt: new Date().toISOString(),
    }));
  } catch { /* best effort */ }
}

function unregisterPipe() {
  safeUnlink(path.join(PIPE_REGISTRY, `${process.pid}.json`));
}

function cleanupPipeServer() {
  if (pipeServer) {
    pipeServer.close();
    pipeServer = null;
  }
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

// ── Daemon management ──

let lastChannelName: string | undefined;

function startDaemon(channelName?: string) {
  daemonWasEnabled = true;
  if (channelName !== undefined) lastChannelName = channelName;

  if (daemon) return;

  if (!sessionId) return;

  const daemonPath = path.resolve(import.meta.dirname, "daemon.js");

  daemon = fork(daemonPath, [], {
    env: {
      ...process.env,
      DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN || "",
      DISCORD_GUILD_ID: process.env.DISCORD_GUILD_ID || "",
      DISCORD_CATEGORY_ID: process.env.DISCORD_CATEGORY_ID || "",
    },
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });

  // Silence daemon output
  daemon.stdout?.resume();
  daemon.stderr?.resume();

  daemon.on("message", (msg: DaemonToParent) => {
    if (msg.type === "pty-write") {
      proc.write(msg.raw ? msg.text : msg.text + "\r");
    } else if (msg.type === "daemon-ready") {
      lastChannelId = msg.channelId;
      setStatusFlag(true);
    }
  });

  daemon.on("exit", (code) => {
    daemon = null;
    // Auto-restart on hot-reload exit or unexpected crash
    if (daemonWasEnabled && code !== null) {
      setTimeout(() => startDaemon(lastChannelName), 1000);
    }
  });

  daemon.on("error", () => {
    daemon = null;
  });

  // Set status flag immediately so statusline shows On right away
  setStatusFlag(true);

  // Pass transcript path directly if we have it from the hook
  daemon.send({ type: "session-info", sessionId, projectDir, channelName, transcriptPath, reuseChannelId: lastChannelId || undefined });
}

function stopDaemon() {
  if (!daemon) return;
  daemon.kill("SIGTERM");
  daemon = null;
  setStatusFlag(false);
}

// ── Start ──

startPipeServer();

// Hot-reload is handled by the daemon itself — it watches its own files
// and exits with a special code. The auto-restart in daemon.on("exit") picks it up.

// ── Graceful shutdown ──

function shutdown() {
  stopDaemon();
  cleanupPipeServer();
  proc.kill();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
