import * as pty from "node-pty";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import { fork, type ChildProcess } from "node:child_process";
import os from "node:os";
import { STATUS_FLAG, PIPE_REGISTRY, encodeProjectPath, safeUnlink } from "./utils.js";
import type { DaemonToParent, PipeMessage } from "./types.js";

// ── Constants ──

const PIPE_NAME = `\\\\.\\pipe\\discord-rc-${process.pid}`;

// Use claude.exe explicitly to bypass any .cmd shim aliases we installed
const CLAUDE_BIN = "claude.exe";

// ── State ──

let daemon: ChildProcess | null = null;
let sessionId: string | null = null;
let projectDir = process.cwd();

// ── Spawn Claude in PTY ──

console.log("[rc] Starting Claude Code in PTY...");

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
  console.log(`\n[rc] Claude exited with code ${exitCode}`);
  stopDaemon();
  cleanupPipeServer();
  setStatusFlag(false);
  process.exit(exitCode);
});

// ── Session detection ──

const claudeProjectsDir = path.join(os.homedir(), ".claude", "projects");
const encodedCwd = encodeProjectPath(projectDir);
const sessionDir = path.join(claudeProjectsDir, encodedCwd);

const sessionPoll = setInterval(() => {
  try {
    if (!fs.existsSync(sessionDir)) return;

    let newest = "";
    let newestTime = 0;
    for (const f of fs.readdirSync(sessionDir)) {
      if (!f.endsWith(".jsonl")) continue;
      const t = fs.statSync(path.join(sessionDir, f)).mtimeMs;
      if (t > newestTime) { newestTime = t; newest = f; }
    }

    if (newest) {
      const newSessionId = newest.replace(".jsonl", "");
      if (newSessionId !== sessionId) {
        sessionId = newSessionId;
        console.log(`[rc] Detected session: ${sessionId}`);
        clearInterval(sessionPoll);
      }
    }
  } catch {
    // directory might not exist yet
  }
}, 1000);

setTimeout(() => clearInterval(sessionPoll), 60000);

// ── Named Pipe Server ──

let pipeServer: net.Server | null = null;

function startPipeServer() {
  pipeServer = net.createServer((socket) => {
    socket.on("data", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as PipeMessage;
        console.log(`[rc] Pipe message: ${msg.type}`);

        if (msg.type === "enable") {
          if (msg.sessionId) sessionId = msg.sessionId;
          startDaemon(msg.channelName);
          socket.write(JSON.stringify({ status: "ok", active: true }));
        } else if (msg.type === "disable") {
          stopDaemon();
          socket.write(JSON.stringify({ status: "ok", active: false }));
        } else if (msg.type === "status") {
          socket.write(JSON.stringify({ status: "ok", active: daemon !== null }));
        }
      } catch (err) {
        console.error("[rc] Pipe parse error:", err);
        socket.write(JSON.stringify({ status: "error", message: String(err) }));
      }
      socket.end();
    });
  });

  pipeServer.on("error", (err) => {
    console.error("[rc] Pipe server error:", err);
  });

  pipeServer.listen(PIPE_NAME, () => {
    console.log(`[rc] Pipe server listening on ${PIPE_NAME}`);
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

function startDaemon(channelName?: string) {
  if (daemon) {
    console.log("[rc] Daemon already running");
    return;
  }

  if (!sessionId) {
    console.error("[rc] Cannot start daemon: no session ID detected yet");
    return;
  }

  console.log("[rc] Starting Discord daemon...");

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

  // Silence daemon output — it's debug noise that flashes in the PTY
  daemon.stdout?.resume();
  daemon.stderr?.resume();

  daemon.on("message", (msg: DaemonToParent) => {
    if (msg.type === "pty-write") {
      proc.write(msg.text + "\r");
    } else if (msg.type === "daemon-ready") {
      console.log(`[rc] Daemon ready, channel: ${msg.channelId}`);
      setStatusFlag(true);
    }
  });

  daemon.on("exit", (code) => {
    console.log(`[rc] Daemon exited with code ${code}`);
    daemon = null;
  });

  daemon.on("error", (err) => {
    console.error("[rc] Daemon error:", err);
    daemon = null;
  });

  daemon.send({ type: "session-info", sessionId, projectDir, channelName });
}

function stopDaemon() {
  if (!daemon) return;
  console.log("[rc] Stopping daemon...");
  daemon.kill("SIGTERM");
  daemon = null;
  setStatusFlag(false);
}

// ── Start ──

startPipeServer();

// ── Graceful shutdown ──

function shutdown() {
  stopDaemon();
  cleanupPipeServer();
  proc.kill();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
