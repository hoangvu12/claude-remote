#!/usr/bin/env node

import * as p from "@clack/prompts";
import pc from "picocolors";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { CONFIG_DIR } from "./utils.js";
import type { Config } from "./types.js";

const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

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
  return path.join(os.homedir(), ".claude", "settings.json");
}

function getSkillDir(): string {
  return path.join(os.homedir(), ".claude", "skills", "discord");
}

function getStatuslineCommand(): string {
  const scriptPath = path.resolve(import.meta.dirname, "statusline.js");
  return `node "${scriptPath}"`;
}

// ── Skill & statusline management ──

function getHookCommand(scriptName: string): string {
  const scriptPath = path.resolve(import.meta.dirname, `${scriptName}.js`);
  return `node "${scriptPath}"`;
}

function installHooksAndStatusline() {
  // Install /discord skill (uses Haiku for speed)
  const skillDir = getSkillDir();
  fs.mkdirSync(skillDir, { recursive: true });

  const skillContent = `---
name: discord
description: Toggle Discord remote control sync for this session
model: haiku
disable-model-invocation: true
allowed-tools: Bash
---

Run the discord-cmd CLI to toggle/control Discord sync. Pass through any arguments the user provided.

\`\`\`bash
discord-cmd $ARGUMENTS
\`\`\`

Print the output to the user. Do not add any extra commentary.
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

  // Build hooks — clean any existing discord-rc hooks first, then add ours
  const hooks = (settings.hooks || {}) as Record<string, unknown[]>;

  // Clean old discord-rc hooks from all event types
  for (const eventType of ["UserPromptSubmit", "SessionStart"]) {
    if (Array.isArray(hooks[eventType])) {
      hooks[eventType] = hooks[eventType].filter((entry: unknown) => {
        const e = entry as Record<string, unknown>;
        const innerHooks = e.hooks as Array<Record<string, string>> | undefined;
        return !innerHooks?.some((h) => h.command?.includes("discord-hook") || h.command?.includes("session-hook"));
      });
      if (hooks[eventType].length === 0) delete hooks[eventType];
    }
  }

  // Add SessionStart hook — registers session info with rc.ts
  if (!hooks.SessionStart) hooks.SessionStart = [];
  hooks.SessionStart.push({
    matcher: "",
    hooks: [{ type: "command", command: getHookCommand("session-hook"), timeout: 5000 }],
  });

  settings.hooks = hooks;

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

function uninstallHooksAndStatusline() {
  // Remove skill (legacy)
  const skillDir = getSkillDir();
  fs.rmSync(skillDir, { recursive: true, force: true });

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

  // Remove discord-rc hooks
  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  if (hooks) {
    for (const eventType of ["UserPromptSubmit", "SessionStart"]) {
      if (Array.isArray(hooks[eventType])) {
        hooks[eventType] = hooks[eventType].filter((entry: unknown) => {
          const e = entry as Record<string, unknown>;
          const innerHooks = e.hooks as Array<Record<string, string>> | undefined;
          return !innerHooks?.some((h) => h.command?.includes("discord-hook") || h.command?.includes("session-hook"));
        });
        if (hooks[eventType].length === 0) delete hooks[eventType];
      }
    }
    if (Object.keys(hooks).length === 0) delete settings.hooks;
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

// ── Shell alias management ──

const ALIAS_MARKER = "# discord-rc-alias";

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
        aliasLine: `function claude { discord-rc @args } ${ALIAS_MARKER}`,
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
        aliasLine: `function claude { discord-rc @args } ${ALIAS_MARKER}`,
        description: "PowerShell 7",
      });
    }
  } catch { /* not available */ }

  // Git Bash
  targets.push({
    shell: "gitbash",
    profilePath: path.join(home, ".bashrc"),
    aliasLine: `claude() { discord-rc "$@"; } ${ALIAS_MARKER}`,
    description: "Git Bash",
  });

  // CMD shim
  targets.push({
    shell: "cmd",
    profilePath: path.join(home, ".local", "bin", "claude.cmd"),
    aliasLine: "@echo off\ndiscord-rc %*",
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
  p.intro(pc.bgCyan(pc.black(" discord-rc ")));

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

  await p.tasks([
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
      message: "Which server should Discord RC use?",
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

  await p.tasks([
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
        saveConfig({ discordBotToken: finalToken, guildId, categoryId });
        return `Saved to ${pc.dim(CONFIG_FILE)}`;
      },
    },
    {
      title: "Installing /discord skill, hooks & statusline",
      task: async (message) => {
        message("Configuring skill, hooks & statusline...");
        installHooksAndStatusline();
        return "/discord skill, SessionStart hook & statusline installed";
      },
    },
  ]);

  // ── Alias setup ──

  const aliasSetup = await p.confirm({
    message: `Set up ${pc.cyan("claude")} alias? (so you type ${pc.bold("claude")} instead of ${pc.bold("discord-rc")})`,
    initialValue: true,
  });

  if (!p.isCancel(aliasSetup) && aliasSetup) {
    const targets = getAliasTargets();

    await p.tasks(
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

  // ── Summary ──

  const guildName = guilds.find((g) => g.id === guildId)?.name || guildId;
  const cmdName = (!p.isCancel(aliasSetup) && aliasSetup) ? "claude" : "discord-rc";

  p.note(
    [
      `${pc.cyan(cmdName)}${" ".repeat(Math.max(1, 20 - cmdName.length))}Start Claude Code with RC support`,
      `${pc.cyan("/discord on")}           Enable sync (inside a session)`,
      `${pc.cyan("/discord off")}          Disable sync`,
      "",
      `Bot      ${pc.green(botUsername)}`,
      `Server   ${pc.green(guildName)}`,
      `Category ${pc.green(CATEGORY_NAME)}`,
      "",
      pc.dim("Each /discord on creates a new channel under the category."),
    ].join("\n"),
    "Ready to go!"
  );

  p.outro(pc.green("Setup complete!"));
}

async function uninstall() {
  p.intro(pc.bgRed(pc.white(" discord-rc uninstall ")));

  const confirmed = await p.confirm({
    message: "Remove Discord RC configuration and Claude Code hook?",
    initialValue: false,
  });

  if (p.isCancel(confirmed) || !confirmed) {
    p.cancel("Uninstall cancelled.");
    process.exit(0);
  }

  await p.tasks([
    {
      title: "Removing /discord skill, hooks & statusline",
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
    `You can also run: ${pc.bold("npm uninstall -g discord-rc")}`,
    "Optional cleanup"
  );

  p.outro(pc.green("Uninstalled successfully."));
}

async function run() {
  const config = loadConfig();
  if (!config) {
    p.intro(pc.bgYellow(pc.black(" discord-rc ")));
    p.log.error("Not set up yet. Run " + pc.bold("discord-rc setup") + " first.");
    p.outro("");
    process.exit(1);
  }

  process.env.DISCORD_BOT_TOKEN = config.discordBotToken;
  process.env.DISCORD_GUILD_ID = config.guildId;
  process.env.DISCORD_CATEGORY_ID = config.categoryId;

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
  case undefined:
  case "start":
    await run();
    break;
  case "help":
  case "--help":
  case "-h":
    console.log(`
  ${pc.bold("discord-rc")} — Discord Remote Control for Claude Code

  ${pc.dim("Commands:")}
    ${pc.cyan("discord-rc")}              Start Claude Code with RC support
    ${pc.cyan("discord-rc setup")}        Configure bot token, channel, and install hook
    ${pc.cyan("discord-rc uninstall")}    Remove hook and config
    ${pc.cyan("discord-rc help")}         Show this help
`);
    break;
  default:
    await run();
    break;
}
