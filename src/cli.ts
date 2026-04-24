#!/usr/bin/env node

import * as p from "@clack/prompts";
import pc from "picocolors";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { CONFIG_DIR, getClaudeDir } from "./utils.js";
import type { Config } from "./types.js";

const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const UPDATE_CACHE = path.join(CONFIG_DIR, "update-check.json");
const CHECK_INTERVAL = 60 * 60 * 1000; // 1 hour

// Workaround for @clack/prompts spinner leaving stdin in broken state on Windows.
// The spinner's block() function puts stdin into raw mode but never restores it on
// Windows, which prevents all subsequent prompts from receiving keyboard input.
// See: https://github.com/bombshell-dev/clack/issues/176
//      https://github.com/bombshell-dev/clack/issues/408
type Task = {
  title: string;
  task: (message: (string: string) => void) => string | Promise<string> | void | Promise<void>;
  enabled?: boolean;
};

async function tasks(taskList: Task[]) {
  await p.tasks(taskList);
  if (process.platform === "win32" && process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
}

// Read our own version from package.json
const require = createRequire(import.meta.url);
const PKG_NAME: string = require("../package.json").name;
const PKG_VERSION: string = require("../package.json").version;

// ── Helpers ──

export function loadConfig(): Config | null {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) as Config;
  } catch {
    return null;
  }
}

function saveConfig(config: Config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
}

function getClaudeSettingsPath(): string {
  return path.join(getClaudeDir(), "settings.json");
}

function getSkillDir(): string {
  return path.join(getClaudeDir(), "skills", "remote");
}

function getStatuslineCommand(): string {
  const scriptPath = path.resolve(import.meta.dirname, "statusline.js");
  return `node "${scriptPath}"`;
}

// ── Skill & statusline management ──

const HOOK_EVENT_TYPES = ["UserPromptSubmit", "SessionStart", "SessionEnd", "Stop", "PreCompact", "PostCompact", "Notification"];
const HOOK_SCRIPT_NAMES = ["remote-hook", "discord-hook", "session-hook", "state-hook"];

function isOurHook(h: Record<string, string>): boolean {
  return HOOK_SCRIPT_NAMES.some((name) => h.command?.includes(name));
}

function cleanRemoteHooks(hooks: Record<string, unknown[]>) {
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

function getHookCommand(scriptName: string): string {
  const scriptPath = path.resolve(import.meta.dirname, `${scriptName}.js`);
  return `node "${scriptPath}"`;
}

function installHooksAndStatusline() {
  // Remove old /discord skill if it exists (migration from discord-rc)
  const oldSkillDir = path.join(getClaudeDir(), "skills", "discord");
  fs.rmSync(oldSkillDir, { recursive: true, force: true });

  // Recreate /remote skill dir — removes old Haiku-based skill if present.
  // The stub only exists for fuzzy-finder discoverability; actual work is done
  // by the UserPromptSubmit hook (zero API cost).
  const skillDir = getSkillDir();
  fs.rmSync(skillDir, { recursive: true, force: true });
  fs.mkdirSync(skillDir, { recursive: true });

  const skillContent = `---
name: remote
description: Toggle remote control sync for this session (on/off/status)
argument-hint: "[on|off|status]"
disable-model-invocation: true
---

This command is handled by a UserPromptSubmit hook.
If you see this text, the hook did not intercept the prompt — run \`claude-remote setup\` to reinstall hooks.
`;

  fs.writeFileSync(path.join(skillDir, "SKILL.md"), skillContent);

  // Install hooks + statusline into settings
  const settingsPath = getClaudeSettingsPath();
  let settings: Record<string, unknown> = {};

  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch { /* start fresh */ }

  // Statusline
  settings.statusLine = {
    type: "command",
    command: getStatuslineCommand(),
  };

  // Build hooks — clean any existing claude-remote hooks first, then add ours
  const hooks = (settings.hooks || {}) as Record<string, unknown[]>;

  // Clean old claude-remote hooks from all event types
  cleanRemoteHooks(hooks);

  const addHook = (event: string, script: string) => {
    if (!hooks[event]) hooks[event] = [];
    hooks[event].push({
      matcher: "",
      hooks: [{ type: "command", command: getHookCommand(script), timeout: 5000 }],
    });
  };

  addHook("UserPromptSubmit", "remote-hook");
  addHook("SessionStart", "session-hook");
  addHook("SessionEnd", "state-hook");
  addHook("Stop", "state-hook");
  addHook("PreCompact", "state-hook");
  addHook("PostCompact", "state-hook");
  addHook("Notification", "state-hook");

  settings.hooks = hooks;

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

function uninstallHooksAndStatusline() {
  // Remove skill
  const skillDir = getSkillDir();
  fs.rmSync(skillDir, { recursive: true, force: true });
  // Remove old /discord skill if it exists (migration from discord-rc)
  const oldSkillDir = path.join(getClaudeDir(), "skills", "discord");
  fs.rmSync(oldSkillDir, { recursive: true, force: true });

  // Remove hooks + statusline from settings
  const settingsPath = getClaudeSettingsPath();
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch {
    return;
  }

  // Remove statusline
  const statusLine = settings.statusLine as Record<string, string> | undefined;
  if (statusLine?.command?.includes("statusline")) {
    delete settings.statusLine;
  }

  // Remove claude-remote hooks
  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  if (hooks) {
    cleanRemoteHooks(hooks);
    if (Object.keys(hooks).length === 0) delete settings.hooks;
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

// ── Shell alias management ──

const ALIAS_MARKER = "# claude-remote-alias";

type ShellType = "powershell" | "pwsh" | "gitbash" | "cmd";

interface AliasTarget {
  shell: ShellType;
  profilePath: string;
  aliasLine: string;
  description: string;
}

function getAliasTargets(): AliasTarget[] {
  const targets: AliasTarget[] = [];
  const home = os.homedir();

  // PowerShell 5
  try {
    const psProfile = execSync('powershell -NoProfile -Command "echo $PROFILE"', { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }).trim();
    if (psProfile) {
      targets.push({
        shell: "powershell",
        profilePath: psProfile,
        aliasLine: `function claude { claude-remote @args } ${ALIAS_MARKER}`,
        description: "PowerShell 5",
      });
    }
  } catch { /* not available */ }

  // PowerShell 7 / pwsh
  try {
    const pwshProfile = execSync('pwsh -NoProfile -Command "echo $PROFILE"', { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }).trim();
    if (pwshProfile) {
      targets.push({
        shell: "pwsh",
        profilePath: pwshProfile,
        aliasLine: `function claude { claude-remote @args } ${ALIAS_MARKER}`,
        description: "PowerShell 7",
      });
    }
  } catch { /* not available */ }

  // Git Bash
  targets.push({
    shell: "gitbash",
    profilePath: path.join(home, ".bashrc"),
    aliasLine: `claude() { claude-remote "$@"; } ${ALIAS_MARKER}`,
    description: "Git Bash",
  });

  // CMD shim
  targets.push({
    shell: "cmd",
    profilePath: path.join(home, ".local", "bin", "claude.cmd"),
    aliasLine: "@echo off\nclaude-remote %*",
    description: "CMD",
  });

  return targets;
}

function installAlias(target: AliasTarget): void {
  if (target.shell === "cmd") {
    const shimDir = path.dirname(target.profilePath);
    fs.mkdirSync(shimDir, { recursive: true });
    fs.writeFileSync(target.profilePath, target.aliasLine + "\n");
    ensureCmdShimInPath(shimDir);
    return;
  }

  // PowerShell / Git Bash — append to profile if not already present
  let content = "";
  try {
    content = fs.readFileSync(target.profilePath, "utf-8");
  } catch { /* file doesn't exist yet */ }

  if (content.includes(ALIAS_MARKER)) return;

  fs.mkdirSync(path.dirname(target.profilePath), { recursive: true });
  fs.appendFileSync(target.profilePath, "\n" + target.aliasLine + "\n");
}

function uninstallAlias(target: AliasTarget): void {
  if (target.shell === "cmd") {
    try {
      if (fs.existsSync(target.profilePath)) fs.unlinkSync(target.profilePath);
    } catch { /* best effort */ }
    return;
  }

  try {
    const content = fs.readFileSync(target.profilePath, "utf-8");
    const lines = content.split("\n").filter((line) => !line.includes(ALIAS_MARKER));
    fs.writeFileSync(target.profilePath, lines.join("\n"));
  } catch { /* file doesn't exist */ }
}

function ensureCmdShimInPath(shimDir: string): void {
  try {
    const userPath = execSync(
      'powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable(\'PATH\', \'User\')"',
      { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }
    ).trim();
    if (!userPath.toLowerCase().includes(shimDir.toLowerCase())) {
      execSync(
        `powershell -NoProfile -Command "[Environment]::SetEnvironmentVariable('PATH', '${userPath};${shimDir}', 'User')"`,
        { stdio: "ignore" }
      );
    }
  } catch { /* best effort */ }
}

// ── Discord API helpers ──

const API = "https://discord.com/api/v10";

async function discordFetch(token: string, endpoint: string, options?: RequestInit) {
  const res = await fetch(`${API}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord API ${res.status}: ${text}`);
  }
  return res.json();
}

async function validateToken(token: string): Promise<{ valid: boolean; username?: string; id?: string }> {
  try {
    const data = await discordFetch(token, "/users/@me") as { username: string; id: string };
    return { valid: true, username: data.username, id: data.id };
  } catch {
    return { valid: false };
  }
}

async function fetchGuilds(token: string): Promise<Array<{ id: string; name: string }>> {
  return discordFetch(token, "/users/@me/guilds") as Promise<Array<{ id: string; name: string }>>;
}

async function createCategory(token: string, guildId: string, name: string): Promise<{ id: string; name: string }> {
  return discordFetch(token, `/guilds/${guildId}/channels`, {
    method: "POST",
    body: JSON.stringify({ name, type: 4 }),
  }) as Promise<{ id: string; name: string }>;
}

async function findExistingCategory(token: string, guildId: string, name: string): Promise<{ id: string; name: string } | null> {
  const channels = await discordFetch(token, `/guilds/${guildId}/channels`) as Array<{ id: string; name: string; type: number }>;
  return channels.find((c) => c.type === 4 && c.name.toLowerCase() === name.toLowerCase()) || null;
}

// ── Commands ──

async function setup() {
  p.intro(pc.bgCyan(pc.black(" claude-remote ")));

  const existing = loadConfig();

  if (existing) {
    p.log.info("Existing configuration found. Press Enter to keep current values.");
  }

  // ── Prerequisites note ──

  p.note(
    [
      `1. Go to ${pc.cyan("https://discord.com/developers/applications")}`,
      `2. Create a New Application ${pc.dim("→")} Bot tab ${pc.dim("→")} copy token`,
      `3. Enable ${pc.bold("Message Content Intent")}`,
      `4. OAuth2 ${pc.dim("→")} bot scope ${pc.dim("→")} Send Messages, Manage Channels`,
      `5. Invite the bot to your server`,
    ].join("\n"),
    "Prerequisites"
  );

  // ── Collect credentials ──

  const token = await p.password({
    message: "Paste your Discord Bot Token",
    mask: "•",
    validate(value) {
      if (!value && !existing?.discordBotToken) return "Bot token is required";
    },
  });

  if (p.isCancel(token)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const finalToken = token || existing?.discordBotToken || "";

  // ── Run install tasks on the timeline ──

  let botUsername = "";
  let guildId = "";
  let guilds: Array<{ id: string; name: string }> = [];
  let categoryId = "";

  await tasks([
    {
      title: "Validating bot token",
      task: async (message) => {
        message("Connecting to Discord...");
        const result = await validateToken(finalToken);
        if (!result.valid) {
          throw new Error("Invalid bot token");
        }
        botUsername = result.username!;
        return `Authenticated as ${pc.green(botUsername)}`;
      },
    },
    {
      title: "Fetching servers",
      task: async (message) => {
        message("Loading server list...");
        guilds = await fetchGuilds(finalToken);
        if (guilds.length === 0) {
          throw new Error("Bot is not in any servers. Invite it first.");
        }
        return `Found ${pc.green(String(guilds.length))} server(s)`;
      },
    },
  ]);

  // ── Pick server (interactive — outside tasks) ──

  if (guilds.length === 1) {
    guildId = guilds[0].id;
    p.log.step(`Server: ${pc.green(guilds[0].name)}`);
  } else {
    const selected = await p.select({
      message: "Which server should Claude Remote use?",
      options: guilds.map((g) => ({ value: g.id, label: g.name })),
    });

    if (p.isCancel(selected)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }
    guildId = selected;
  }

  // ── Continue install tasks ──

  const CATEGORY_NAME = "Claude RC";

  await tasks([
    {
      title: `Setting up "${CATEGORY_NAME}" category`,
      task: async (message) => {
        message("Checking for existing category...");
        const existing = await findExistingCategory(finalToken, guildId, CATEGORY_NAME);

        if (existing) {
          categoryId = existing.id;
          return `Found existing category ${pc.green(existing.name)}`;
        }

        message("Creating category...");
        const created = await createCategory(finalToken, guildId, CATEGORY_NAME);
        categoryId = created.id;
        return `Created category ${pc.green(created.name)}`;
      },
    },
    {
      title: "Saving configuration",
      task: async () => {
        saveConfig({ discordBotToken: finalToken, guildId, categoryId, autoRemote: existing?.autoRemote });
        return `Saved to ${pc.dim(CONFIG_FILE)}`;
      },
    },
    {
      title: "Installing /remote skill, hooks & statusline",
      task: async (message) => {
        message("Configuring skill, hooks & statusline...");
        installHooksAndStatusline();
        return "/remote skill, SessionStart hook & statusline installed";
      },
    },
  ]);

  // ── Alias setup ──

  const aliasSetup = await p.confirm({
    message: `Set up ${pc.cyan("claude")} alias? (so you type ${pc.bold("claude")} instead of ${pc.bold("claude-remote")})`,
    initialValue: true,
  });

  if (!p.isCancel(aliasSetup) && aliasSetup) {
    const targets = getAliasTargets();

    await tasks(
      targets.map((target) => ({
        title: `${target.description} alias`,
        task: async () => {
          installAlias(target);
          return `Installed → ${pc.dim(target.profilePath)}`;
        },
      }))
    );

    if (process.platform === "win32" && targets.some((t) => t.shell === "cmd")) {
      p.log.info(`CMD: added ${pc.dim("claude.cmd")} shim to ${pc.dim("~/.local/bin")}`);
    }

    p.log.info(`Restart your terminal for the ${pc.cyan("claude")} alias to take effect.`);
  }

  // ── Auto-remote setup ──

  const autoRemoteSetup = await p.confirm({
    message: `Auto-enable remote on start? (same as ${pc.bold("--remote")} flag, skips /remote on)`,
    initialValue: existing?.autoRemote ?? false,
  });

  const autoRemote = !p.isCancel(autoRemoteSetup) && autoRemoteSetup;

  // Update config with autoRemote setting
  const savedConfig = loadConfig();
  if (savedConfig) {
    savedConfig.autoRemote = autoRemote;
    saveConfig(savedConfig);
  }

  // ── Summary ──

  const guildName = guilds.find((g) => g.id === guildId)?.name || guildId;
  const cmdName = (!p.isCancel(aliasSetup) && aliasSetup) ? "claude" : "claude-remote";

  p.note(
    [
      `${pc.cyan(cmdName)}${" ".repeat(Math.max(1, 20 - cmdName.length))}Start Claude Code with RC support`,
      `${pc.cyan(cmdName + " --remote")}${" ".repeat(Math.max(1, 12 - cmdName.length))}Start with remote auto-enabled`,
      `${pc.cyan("/remote on")}            Enable sync (inside a session)`,
      `${pc.cyan("/remote off")}           Disable sync`,
      "",
      `Bot         ${pc.green(botUsername)}`,
      `Server      ${pc.green(guildName)}`,
      `Category    ${pc.green(CATEGORY_NAME)}`,
      `Auto-remote ${autoRemote ? pc.green("on") : pc.dim("off")}`,
      "",
      pc.dim("Each /remote on creates a new channel under the category."),
    ].join("\n"),
    "Ready to go!"
  );

  p.outro(pc.green("Setup complete!"));
}

async function uninstall() {
  p.intro(pc.bgRed(pc.white(" claude-remote uninstall ")));

  const confirmed = await p.confirm({
    message: "Remove Claude Remote configuration and Claude Code hook?",
    initialValue: false,
  });

  if (p.isCancel(confirmed) || !confirmed) {
    p.cancel("Uninstall cancelled.");
    process.exit(0);
  }

  await tasks([
    {
      title: "Removing /remote skill, hooks & statusline",
      task: async () => {
        uninstallHooksAndStatusline();
        return "Skill, hooks & statusline removed";
      },
    },
    {
      title: "Removing claude alias",
      task: async () => {
        const targets = getAliasTargets();
        let removed = 0;
        for (const target of targets) {
          try {
            uninstallAlias(target);
            removed++;
          } catch { /* best effort */ }
        }
        return removed > 0 ? `Removed from ${removed} shell(s)` : "No aliases found";
      },
    },
    {
      title: "Removing configuration",
      task: async () => {
        fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
        return "Configuration removed";
      },
    },
  ]);

  p.note(
    `You can also run: ${pc.bold("npm uninstall -g @hoangvu12/claude-remote")}`,
    "Optional cleanup"
  );

  p.outro(pc.green("Uninstalled successfully."));
}

// ── Auto-update ──

interface UpdateCache {
  lastCheck: number;
  latestVersion: string;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

function readUpdateCache(): UpdateCache | null {
  try {
    return JSON.parse(fs.readFileSync(UPDATE_CACHE, "utf-8"));
  } catch {
    return null;
  }
}

function writeUpdateCache(cache: UpdateCache) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(UPDATE_CACHE, JSON.stringify(cache));
  } catch { /* best effort */ }
}

/** Detect if running from a local dev checkout (npm link / symlink) */
function isLocalDev(): boolean {
  try {
    const realPath = fs.realpathSync(import.meta.dirname);
    // npm link: the real path won't be inside a global node_modules
    return !realPath.includes("node_modules");
  } catch {
    return false;
  }
}

/**
 * Non-blocking update check: queries npm registry, writes latest version to cache.
 * The statusline reads the cache and shows a notice if newer version exists.
 */
function checkForUpdates() {
  const cache = readUpdateCache();
  const now = Date.now();

  // Skip if checked recently
  if (cache && now - cache.lastCheck < CHECK_INTERVAL) {
    return;
  }

  // Fire and forget — don't await
  fetch(`https://registry.npmjs.org/${PKG_NAME}/latest`, {
    signal: AbortSignal.timeout(5000),
  })
    .then((res) => res.json())
    .then((data: { version?: string }) => {
      const latest = data.version;
      if (!latest) return;

      writeUpdateCache({ lastCheck: now, latestVersion: latest });
    })
    .catch(() => {
      // Network error, offline, etc. — silently ignore
    });
}

/** Self-update: install the latest version from npm */
async function selfUpdate() {
  p.intro(pc.bgCyan(pc.black(" claude-remote update ")));

  const s = p.spinner();
  s.start("Checking for updates...");

  let latest: string;
  try {
    const res = await fetch(`https://registry.npmjs.org/${PKG_NAME}/latest`, {
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json() as { version?: string };
    latest = data.version || "";
    if (!latest) throw new Error("No version found");
  } catch {
    s.stop("Failed to check for updates");
    p.log.error("Could not reach npm registry. Check your internet connection.");
    process.exit(1);
  }

  if (compareVersions(latest, PKG_VERSION) <= 0) {
    s.stop(`Already on latest version ${pc.green(PKG_VERSION)}`);
    p.outro("");
    return;
  }

  s.message(`Installing ${pc.green(latest)}...`);

  try {
    execSync(`npm install -g ${PKG_NAME}@${latest}`, {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 60000,
    });
    writeUpdateCache({ lastCheck: Date.now(), latestVersion: latest });
    s.stop(`Updated ${pc.dim(PKG_VERSION)} → ${pc.green(latest)}`);
    p.outro(pc.green("Restart your terminal to use the new version."));
  } catch (err) {
    s.stop("Update failed");
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("EACCES") || msg.includes("permission")) {
      p.log.error(`Permission denied. Try: ${pc.bold(`sudo npm install -g ${PKG_NAME}@${latest}`)}`);
    } else {
      p.log.error(`Install failed: ${msg}`);
      p.log.info(`You can update manually: ${pc.bold(`npm install -g ${PKG_NAME}@${latest}`)}`);
    }
    process.exit(1);
  }
}

async function run() {
  const config = loadConfig();
  if (!config) {
    p.intro(pc.bgYellow(pc.black(" claude-remote ")));
    p.log.error("Not set up yet. Run " + pc.bold("claude-remote setup") + " first.");
    p.outro("");
    process.exit(1);
  }

  process.env.DISCORD_BOT_TOKEN = config.discordBotToken;
  process.env.DISCORD_GUILD_ID = config.guildId;
  process.env.DISCORD_CATEGORY_ID = config.categoryId;
  if (config.autoRemote) process.env.CLAUDE_REMOTE_AUTO = "1";

  // Ensure hooks & skill are up to date (idempotent, handles post-update registration)
  installHooksAndStatusline();

  // Check for updates in background (non-blocking, skip if locally linked)
  if (!isLocalDev()) checkForUpdates();

  await import("./rc.js");
}

// ── Main ──

const command = process.argv[2];

switch (command) {
  case "setup":
    await setup();
    break;
  case "uninstall":
    await uninstall();
    break;
  case "update":
    await selfUpdate();
    break;
  case "auto": {
    const config = loadConfig();
    if (!config) {
      console.log(pc.red("Not set up yet. Run ") + pc.bold("claude-remote setup") + pc.red(" first."));
      process.exit(1);
    }
    config.autoRemote = !config.autoRemote;
    saveConfig(config);
    console.log(`  Auto-remote: ${config.autoRemote ? pc.green("on") : pc.dim("off")}`);
    break;
  }
  case "config": {
    const key = process.argv[3];
    const value = process.argv[4];
    const config = loadConfig();
    if (!config) {
      console.log(pc.red("Not set up yet. Run ") + pc.bold("claude-remote setup") + pc.red(" first."));
      process.exit(1);
    }
    if (!key) {
      // Show current config (hide token)
      console.log(`  ${pc.dim("autoRemote")}  ${config.autoRemote ? pc.green("on") : pc.dim("off")}`);
      break;
    }
    if (key === "autoRemote" || key === "auto-remote") {
      if (!value) {
        console.log(`autoRemote: ${config.autoRemote ? pc.green("on") : pc.dim("off")}`);
      } else {
        const on = ["true", "on", "1", "yes"].includes(value.toLowerCase());
        config.autoRemote = on;
        saveConfig(config);
        console.log(`autoRemote: ${on ? pc.green("on") : pc.dim("off")}`);
      }
    } else {
      console.log(pc.red(`Unknown config key: ${key}`));
      console.log(`Available keys: ${pc.cyan("autoRemote")}`);
      process.exit(1);
    }
    break;
  }
  case undefined:
  case "start":
    await run();
    break;
  case "help":
  case "--help":
  case "-h":
    console.log(`
  ${pc.bold("claude-remote")} — Remote Control for Claude Code

  ${pc.dim("Commands:")}
    ${pc.cyan("claude-remote")}              Start Claude Code with remote control
    ${pc.cyan("claude-remote --remote")}     Start with Discord sync auto-enabled
    ${pc.cyan("claude-remote setup")}        Configure provider, install hook
    ${pc.cyan("claude-remote auto")}         Toggle auto-remote on/off
    ${pc.cyan("claude-remote update")}       Update to the latest version
    ${pc.cyan("claude-remote uninstall")}    Remove hook and config
    ${pc.cyan("claude-remote help")}         Show this help

  ${pc.dim("Options:")}
    ${pc.cyan("--remote")}                   Auto-enable remote sync (skip /remote on)

  ${pc.dim("Config keys:")}
    ${pc.cyan("autoRemote")}  ${pc.dim("on/off")}       Always auto-enable remote on start
`);
    break;
  default:
    await run();
    break;
}
