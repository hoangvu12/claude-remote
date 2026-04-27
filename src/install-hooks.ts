/**
 * Canonical list of Claude Code hook events claude-remote installs into
 * `~/.claude/settings.json`, plus helpers shared by cli.ts (manual setup)
 * and daemon.ts (idempotent auto-heal on startup).
 *
 * Auto-heal exists so users don't have to re-run `claude-remote setup`
 * every time we add a new hook event in a release. The daemon checks the
 * installed list on boot and patches in anything missing — non-destructive,
 * never touches third-party hooks.
 *
 * If a user explicitly uninstalled with `claude-remote uninstall` they
 * presumably also stopped running the daemon, so auto-heal not running
 * isn't a problem in that scenario.
 */

import fs from "node:fs";
import path from "node:path";
import { getClaudeDir } from "./utils.js";

export const HOOK_EVENT_TYPES = [
  "UserPromptSubmit",
  "SessionStart",
  "SessionEnd",
  "Stop",
  "StopFailure",
  "PreCompact",
  "PostCompact",
  "Notification",
  "PermissionRequest",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "SubagentStart",
  "SubagentStop",
];

/** Substrings used to identify hook entries that belong to claude-remote. */
export const HOOK_SCRIPT_NAMES = [
  "remote-hook",
  "discord-hook",
  "session-hook",
  "state-hook",
  "permission-hook",
  "tool-hook",
];

export interface ExpectedHook {
  event: string;
  script: string;
  timeoutMs: number;
}

/**
 * Source of truth for what we install. Order matters only for stability of
 * the on-disk JSON when the file is rewritten.
 */
export const EXPECTED_HOOKS: ExpectedHook[] = [
  { event: "UserPromptSubmit", script: "remote-hook", timeoutMs: 5_000 },
  // Second UserPromptSubmit hook — runs in parallel with remote-hook to
  // forward a "user-prompt-submit" state-signal. This is the earliest TUI
  // signal that a turn has started (upstream's notifySessionStateChanged
  // chokepoint is gated on non-interactive mode and never fires in TUI).
  { event: "UserPromptSubmit", script: "state-hook", timeoutMs: 5_000 },
  { event: "SessionStart", script: "session-hook", timeoutMs: 5_000 },
  { event: "SessionEnd", script: "state-hook", timeoutMs: 5_000 },
  { event: "Stop", script: "state-hook", timeoutMs: 5_000 },
  { event: "StopFailure", script: "state-hook", timeoutMs: 5_000 },
  { event: "PreCompact", script: "state-hook", timeoutMs: 5_000 },
  { event: "PostCompact", script: "state-hook", timeoutMs: 5_000 },
  { event: "Notification", script: "state-hook", timeoutMs: 5_000 },
  // 5min — permission-hook.ts blocks until the user clicks Allow/Deny in
  // Discord. Hook itself uses a 4min internal timeout so it always finishes
  // by passthrough rather than being SIGKILLed by Claude.
  { event: "PermissionRequest", script: "permission-hook", timeoutMs: 5 * 60 * 1000 },
  // Tool lifecycle — fire-and-forget timing signals; render still flows from JSONL.
  { event: "PreToolUse", script: "tool-hook", timeoutMs: 5_000 },
  { event: "PostToolUse", script: "tool-hook", timeoutMs: 5_000 },
  { event: "PostToolUseFailure", script: "tool-hook", timeoutMs: 5_000 },
  // Subagent lifecycle — deterministic spawn/finish for Task/Agent subagents.
  // state-hook handles them too but allows agent_id through (skip-on-agent_id
  // filter is only for the main-thread Stop/Start variants).
  { event: "SubagentStart", script: "state-hook", timeoutMs: 5_000 },
  { event: "SubagentStop", script: "state-hook", timeoutMs: 5_000 },
];

export function getClaudeSettingsPath(): string {
  return path.join(getClaudeDir(), "settings.json");
}

export function getHookCommand(scriptName: string): string {
  const scriptPath = path.resolve(import.meta.dirname, `${scriptName}.js`);
  return `node "${scriptPath}"`;
}

export function isOurHook(h: Record<string, string>): boolean {
  return HOOK_SCRIPT_NAMES.some((name) => h.command?.includes(name));
}

export function cleanRemoteHooks(hooks: Record<string, unknown[]>) {
  for (const eventType of HOOK_EVENT_TYPES) {
    if (Array.isArray(hooks[eventType])) {
      hooks[eventType] = hooks[eventType].filter((entry: unknown) => {
        const e = entry as Record<string, unknown>;
        const innerHooks = e.hooks as Array<Record<string, string>> | undefined;
        return !innerHooks?.some(isOurHook);
      });
      if (hooks[eventType].length === 0) delete hooks[eventType];
    }
  }
}

/**
 * Non-destructive installer: adds any missing claude-remote hook entries to
 * settings.json without touching third-party hooks or other settings keys.
 * Returns the list of events that were patched in (empty when already
 * up-to-date).
 *
 * Safe to call on every daemon startup. If `~/.claude/settings.json` doesn't
 * exist (no Claude install or fresh user dir), creates it with just our hooks.
 */
export function ensureHooksInstalled(): string[] {
  const settingsPath = getClaudeSettingsPath();
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch { /* missing or unparseable — start from empty */ }

  const hooks = (settings.hooks || {}) as Record<string, unknown[]>;
  const added: string[] = [];

  for (const { event, script, timeoutMs } of EXPECTED_HOOKS) {
    if (!Array.isArray(hooks[event])) hooks[event] = [];
    const expectedCommand = getHookCommand(script);
    const alreadyPresent = hooks[event].some((entry) => {
      const innerHooks = (entry as Record<string, unknown>).hooks as
        | Array<Record<string, unknown>>
        | undefined;
      return innerHooks?.some((h) => h.command === expectedCommand);
    });
    if (alreadyPresent) continue;
    hooks[event].push({
      matcher: "",
      hooks: [{ type: "command", command: expectedCommand, timeout: timeoutMs }],
    });
    added.push(event);
  }

  if (added.length === 0) return added;

  settings.hooks = hooks;
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return added;
}
