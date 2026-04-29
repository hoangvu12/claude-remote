import {
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ChannelType,
  Events,
  type Client,
  type ChatInputCommandInteraction,
  type TextChannel,
  type ButtonInteraction,
} from "discord.js";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { DiscordProvider } from "./providers/discord.js";
import type { SessionContext } from "./handler.js";
import type { PtyWriteMessage } from "./types.js";
import { ActivityManager, STATUS_LABELS, type ActivityState } from "./activity.js";
import { modeShiftTabCount, getModeCycle, isModeReachable, MODE_LABELS, ID_PREFIX, SESSIONS_FILE, encodeProjectPath, getClaudeDir, truncate, plural, readLaunchedProjects, recordLaunchedProject, scanClaudeProjectCwds } from "./utils.js";
import { COLOR } from "./discord-renderer.js";

const RESUME_PICK_PREFIX = "resume-pick:";

// Pending /cleanup previews keyed by interaction id, expire after CLEANUP_TTL.
// Held server-side because Discord customId caps at 100 chars (snowflakes are
// ~19 each, so we couldn't fit a meaningful list inline).
interface PendingCleanup {
  channelIds: string[];
  invokerUserId: string;
  expiresAt: number;
}
const pendingCleanups = new Map<string, PendingCleanup>();
const CLEANUP_TTL = 5 * 60 * 1000;
const CLEANUP_PREVIEW_LIMIT = 15;
const CLEANUP_PROGRESS_EVERY = 3;

export interface SlashCommandDeps {
  getCtx: () => SessionContext | null;
  activity: ActivityManager;
  sendToClient: (msg: Omit<PtyWriteMessage, "sessionKey">) => void;
  /**
   * Restart the rc.ts Claude child.
   * - undefined → resume the current session (default /restart behavior)
   * - null      → start fresh, no --resume (used by /new)
   * - string    → resume that specific session id (used by /resume picker)
   */
  restart: (resumeSessionId?: string | null) => void;
  provider: DiscordProvider;
  projectDir: string;
  sessionId: string;
  channelId: string;
  /** Discord category that holds all session channels — `/cleanup` scopes to it. */
  categoryId: string;
  /** True if the channel currently has a live session attached. Cleanup
   *  must skip these so we don't yank the channel out from under a running
   *  daemon. */
  isChannelActive: (channelId: string) => boolean;
}

/** Returns a cleanup function that removes the InteractionCreate listener */
export async function setupSlashCommands(
  client: Client,
  guildId: string,
  deps: SlashCommandDeps,
  skipRegistration = false,
): Promise<() => void> {
  const commands = [
    new SlashCommandBuilder()
      .setName("mode")
      .setDescription("Switch Claude Code permission mode")
      .addStringOption((opt) =>
        opt.setName("mode")
          .setDescription("Target permission mode")
          .setRequired(true)
          .addChoices(
            { name: "Default", value: "default" },
            { name: "Accept Edits", value: "acceptEdits" },
            { name: "Plan Mode", value: "plan" },
            { name: "Bypass Permissions", value: "bypassPermissions" },
          )
      ),
    new SlashCommandBuilder()
      .setName("clear")
      .setDescription("Clear Claude Code context (starts new conversation)"),
    new SlashCommandBuilder()
      .setName("status")
      .setDescription("Show current session info"),
    new SlashCommandBuilder()
      .setName("compact")
      .setDescription("Trigger context compaction")
      .addStringOption((opt) =>
        opt.setName("instructions")
          .setDescription("Optional instructions for compaction")
          .setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName("model")
      .setDescription("Switch Claude model")
      .addStringOption((opt) =>
        opt.setName("model")
          .setDescription("Target model")
          .setRequired(true)
          .addChoices(
            { name: "Sonnet", value: "sonnet" },
            { name: "Sonnet 1M", value: "sonnet[1m]" },
            { name: "Opus", value: "opus" },
            { name: "Opus 1M", value: "opus[1m]" },
            { name: "Opus Plan (opus for plan, sonnet for execution)", value: "opusplan" },
            { name: "Haiku", value: "haiku" },
            { name: "Best (auto-select)", value: "best" },
          )
      ),
    new SlashCommandBuilder()
      .setName("stop")
      .setDescription("Interrupt Claude (like pressing Escape)"),
    new SlashCommandBuilder()
      .setName("restart")
      .setDescription("Restart the Claude CLI and resume the same conversation"),
    new SlashCommandBuilder()
      .setName("new")
      .setDescription("Restart the Claude CLI in a fresh, empty conversation"),
    new SlashCommandBuilder()
      .setName("key")
      .setDescription("Send raw keypresses to Claude CLI")
      .addStringOption((opt) =>
        opt.setName("keys")
          .setDescription("Space-separated keys: enter, up, down, left, right, space, tab, escape, backspace, or literal text")
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("queue")
      .setDescription("Manage message queue")
      .addSubcommand((sub) => sub.setName("view").setDescription("View queued messages"))
      .addSubcommand((sub) => sub.setName("clear").setDescription("Clear all queued messages"))
      .addSubcommand((sub) =>
        sub.setName("remove").setDescription("Remove a queued message")
          .addIntegerOption((opt) => opt.setName("id").setDescription("Queue ID to remove").setRequired(true))
      )
      .addSubcommand((sub) =>
        sub.setName("edit").setDescription("Edit a queued message")
          .addIntegerOption((opt) => opt.setName("id").setDescription("Queue ID to edit").setRequired(true))
      ),
    new SlashCommandBuilder()
      .setName("cost")
      .setDescription("Show cost and duration for this session"),
    new SlashCommandBuilder()
      .setName("rewind")
      .setDescription("Rewind the conversation (like Ctrl+G in the TTY)"),
    new SlashCommandBuilder()
      .setName("resume")
      .setDescription("Resume a previous conversation (restarts Claude with --resume)")
      .addStringOption((opt) =>
        opt.setName("id")
          .setDescription("Session id (blank = show picker of recent sessions)")
          .setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName("plan")
      .setDescription("Enter plan mode with an optional prompt")
      .addStringOption((opt) =>
        opt.setName("prompt")
          .setDescription("What to plan (optional)")
          .setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName("memory")
      .setDescription("Append text to project CLAUDE.md")
      .addStringOption((opt) =>
        opt.setName("text")
          .setDescription("Text to append (as a memory note)")
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("export")
      .setDescription("Export the current conversation")
      .addStringOption((opt) =>
        opt.setName("filename")
          .setDescription("Optional output filename")
          .setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName("mcp")
      .setDescription("Toggle or list MCP servers")
      .addStringOption((opt) =>
        opt.setName("args")
          .setDescription("e.g. 'enable slack' or 'disable slack'. Empty = list.")
          .setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName("doctor")
      .setDescription("Run Claude Code diagnostics"),
    new SlashCommandBuilder()
      .setName("hooks")
      .setDescription("Show installed hook configuration"),
    new SlashCommandBuilder()
      .setName("kill-agents")
      .setDescription("Kill all running background subagents"),
    new SlashCommandBuilder()
      .setName("cleanup")
      .setDescription("Delete inactive session channels older than N days")
      .addIntegerOption((opt) =>
        opt.setName("days")
          .setDescription("Channels with no activity for at least this many days")
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(365)
      ),
    new SlashCommandBuilder()
      .setName("launch")
      .setDescription("Open a new Windows Terminal tab with claude-remote in a project")
      .addStringOption((opt) =>
        opt.setName("path")
          .setDescription("Project path — autocompletes from recently launched projects")
          .setRequired(true)
          .setAutocomplete(true)
      ),
  ];

  // Record this session's project so /launch autocomplete can suggest it later.
  recordLaunchedProject(deps.projectDir);

  if (!skipRegistration) {
    try {
      await client.application!.commands.set(commands, guildId);
      await client.application!.commands.set([]);
      console.log("[daemon] Slash commands registered");
    } catch (err) {
      console.error("[daemon] Failed to register slash commands:", err);
    }
  }

  const handler = async (interaction: import("discord.js").Interaction) => {
    if (interaction.channelId !== deps.channelId) return;

    if (interaction.isAutocomplete() && interaction.commandName === "launch") {
      const focused = interaction.options.getFocused(true);
      if (focused.name !== "path") return;
      const query = focused.value.toLowerCase();

      // Merge: explicitly-launched projects (with their lastUsed) + Claude's
      // own ~/.claude/projects/* (sorted by JSONL mtime). Registry's lastUsed
      // wins on collision so just-launched paths surface to the top.
      const merged = new Map<string, number>();
      for (const s of scanClaudeProjectCwds()) merged.set(s.path, s.mtimeMs);
      for (const r of readLaunchedProjects()) {
        merged.set(r.path, Math.max(merged.get(r.path) ?? 0, r.lastUsed));
      }

      const choices = Array.from(merged.entries())
        .filter(([p]) => {
          if (!query) return true;
          return p.toLowerCase().includes(query) || path.basename(p).toLowerCase().includes(query);
        })
        .sort((a, b) => b[1] - a[1])
        .slice(0, 25)
        .map(([p]) => ({
          name: truncate(`${path.basename(p)} — ${p}`, 100),
          value: truncate(p, 100),
        }));

      try {
        await interaction.respond(choices);
      } catch { /* interaction may have expired */ }
      return;
    }

    if (interaction.isButton()) {
      if (interaction.customId.startsWith(ID_PREFIX.CLEANUP_CONFIRM)) {
        await handleCleanupConfirm(interaction, deps);
        return;
      }
      if (interaction.customId.startsWith(ID_PREFIX.CLEANUP_CANCEL)) {
        await handleCleanupCancel(interaction);
        return;
      }
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith(RESUME_PICK_PREFIX)) {
      const target = interaction.values[0];
      if (!target) {
        await interaction.update({ content: "⚠️ No selection received.", components: [] });
        return;
      }
      deps.restart(target);
      deps.activity.busy = false;
      deps.activity.update("idle", client);
      await interaction.update({
        content: `↩️ Resuming \`${target.slice(0, 8)}\`...`,
        components: [],
      });
      return;
    }

    if (!interaction.isChatInputCommand()) return;
    const cmd = interaction as ChatInputCommandInteraction;
    const { activity, sendToClient, getCtx } = deps;

    switch (cmd.commandName) {
      case "mode": {
        const target = cmd.options.getString("mode", true);
        const ctx = getCtx();
        const current = ctx?.permissionMode || "default";
        // bypassPermissions is only reachable when the user launched Claude
        // with `--dangerously-skip-permissions` (upstream permissionSetup.ts).
        // We approximate via ctx.bypassAvailable, set at session-register.
        const bypassAvailable = ctx?.bypassAvailable ?? (current === "bypassPermissions");
        const cycle = getModeCycle(bypassAvailable);
        if (target === current) {
          await cmd.reply({ content: `Already in **${MODE_LABELS[target]}**`, ephemeral: true });
          return;
        }
        if (!isModeReachable(target, cycle)) {
          await cmd.reply({
            content: `⚠️ **${MODE_LABELS[target] || target}** isn't reachable in this session. Relaunch Claude with \`--dangerously-skip-permissions\` to enable bypass mode.`,
            ephemeral: true,
          });
          return;
        }
        const presses = modeShiftTabCount(current, target, cycle);
        const SHIFT_TAB = "\x1b[Z";
        for (let i = 0; i < presses; i++) {
          if (i > 0) await new Promise((r) => setTimeout(r, 500));
          sendToClient({ type: "pty-write", text: SHIFT_TAB, raw: true });
        }
        // Optimistically update tracked mode — JSONL won't reflect the change
        // until the next user message attaches a permissionMode field.
        if (ctx) ctx.permissionMode = target;
        await cmd.reply({ content: `🔄 Switching to **${MODE_LABELS[target]}** (${presses} cycle${presses > 1 ? "s" : ""})`, ephemeral: true });
        break;
      }
      case "clear":
        sendToClient({ type: "pty-write", text: "/clear", raw: false });
        activity.busy = false;
        activity.update("idle", client);
        await cmd.reply({ content: "🧹 Clearing context...", ephemeral: true });
        break;
      case "status": {
        const currentMode = getCtx()?.permissionMode || "default";
        const info = STATUS_LABELS[activity.state];
        await cmd.reply({
          content: [
            `📁 **Project**: \`${deps.projectDir}\``,
            `🆔 **Session**: \`${deps.sessionId.slice(0, 8)}\``,
            `🔒 **Mode**: ${MODE_LABELS[currentMode] || currentMode}`,
            `${info.icon} **Activity**: ${info.label}`,
            activity.queue.length > 0 ? `📥 **Queue**: ${activity.queue.length} message${activity.queue.length !== 1 ? "s" : ""}` : "",
          ].filter(Boolean).join("\n"),
          ephemeral: true,
        });
        break;
      }
      case "compact": {
        const instructions = cmd.options.getString("instructions");
        const text = instructions ? `/compact ${instructions}` : "/compact";
        sendToClient({ type: "pty-write", text, raw: false });
        activity.busy = false;
        activity.update("idle", client);
        await cmd.reply({ content: "📦 Compacting context...", ephemeral: true });
        break;
      }
      case "model": {
        const model = cmd.options.getString("model", true);
        sendToClient({ type: "pty-write", text: `/model ${model}`, raw: false });
        await cmd.reply({ content: `🤖 Switching to \`${model}\`...`, ephemeral: true });
        break;
      }
      case "stop":
        // Escape alone is the upstream `chat:cancel` action — cancels tools,
        // thinking, and input. Sending Ctrl+C after it used to set the
        // "Press Ctrl-C again to exit" pending state on an idle prompt,
        // which could confusingly double-trigger exit on a follow-up Ctrl+C.
        sendToClient({ type: "pty-write", text: "\x1b", raw: true });
        activity.busy = false;
        activity.stopOverrideUntil = Date.now() + 3000;
        activity.update("idle", client);
        await cmd.reply({ content: "⏹️ Interrupted", ephemeral: true });
        setTimeout(() => activity.tryDequeue(), 3500);
        break;
      case "restart":
        deps.restart();
        activity.busy = false;
        activity.update("idle", client);
        await cmd.reply({ content: "🔄 Restarting Claude (resuming current conversation)...", ephemeral: true });
        break;
      case "new":
        deps.restart(null);
        activity.busy = false;
        activity.update("idle", client);
        await cmd.reply({ content: "🆕 Starting a fresh conversation...", ephemeral: true });
        break;
      case "key": {
        const input = cmd.options.getString("keys", true);
        const { keys, display } = parseKeyInput(input);
        const KEY_SEND_DELAY = 100;
        keys.forEach((key, i) => {
          setTimeout(() => sendToClient({ type: "pty-write", text: key, raw: true }), i * KEY_SEND_DELAY);
        });
        await cmd.reply({ content: `⌨️ Sent: ${display}`, ephemeral: true });
        break;
      }
      case "queue":
        await handleQueueCommand(cmd, deps);
        break;
      case "cost":
        sendToClient({ type: "pty-write", text: "/cost", raw: false });
        await cmd.reply({ content: "💰 Requesting cost report...", ephemeral: true });
        break;
      case "rewind":
        // Upstream binding is Ctrl+G — send it directly so this works even
        // if the user has `/rewind` the slash-command disabled.
        sendToClient({ type: "pty-write", text: "\x07", raw: true });
        await cmd.reply({ content: "⏪ Rewinding...", ephemeral: true });
        break;
      case "resume": {
        const id = cmd.options.getString("id") || "";
        if (id.trim()) {
          deps.restart(id.trim());
          activity.busy = false;
          activity.update("idle", client);
          await cmd.reply({ content: `↩️ Resuming \`${id.trim().slice(0, 8)}\`...`, ephemeral: true });
          break;
        }
        const sessions = await listRecentSessions(deps.projectDir, 25);
        if (sessions.length === 0) {
          await cmd.reply({
            content: "📭 No previous conversations found for this project.",
            ephemeral: true,
          });
          break;
        }
        const select = new StringSelectMenuBuilder()
          .setCustomId(`${RESUME_PICK_PREFIX}${cmd.id}`)
          .setPlaceholder("Pick a conversation to resume")
          .addOptions(sessions.map((s) => ({
            label: truncate(s.label, 100),
            description: truncate(s.preview, 100) || undefined,
            value: s.sessionId,
          })));
        await cmd.reply({
          content: `↩️ ${sessions.length} recent conversation${sessions.length === 1 ? "" : "s"}:`,
          components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
          ephemeral: true,
        });
        break;
      }
      case "plan": {
        const prompt = cmd.options.getString("prompt") || "";
        const payload = prompt.trim() ? `/plan ${prompt.trim()}` : "/plan";
        sendToClient({ type: "pty-write", text: payload, raw: false });
        activity.busy = true;
        activity.update("thinking", client);
        await cmd.reply({ content: "📐 Entering plan mode...", ephemeral: true });
        break;
      }
      case "memory": {
        const text = cmd.options.getString("text", true);
        // Use # prefix — the standard "quick memory" shortcut in Claude Code
        // that appends to CLAUDE.md without going through the memory editor UI.
        sendToClient({ type: "pty-write", text: `# ${text}`, raw: false });
        await cmd.reply({ content: "🧠 Saved to CLAUDE.md", ephemeral: true });
        break;
      }
      case "export": {
        const filename = cmd.options.getString("filename") || "";
        const payload = filename.trim() ? `/export ${filename.trim()}` : "/export";
        sendToClient({ type: "pty-write", text: payload, raw: false });
        await cmd.reply({ content: "📤 Exporting conversation...", ephemeral: true });
        break;
      }
      case "mcp": {
        const args = cmd.options.getString("args") || "";
        const payload = args.trim() ? `/mcp ${args.trim()}` : "/mcp";
        sendToClient({ type: "pty-write", text: payload, raw: false });
        await cmd.reply({ content: "🔌 MCP command sent", ephemeral: true });
        break;
      }
      case "doctor":
        sendToClient({ type: "pty-write", text: "/doctor", raw: false });
        await cmd.reply({ content: "🩺 Running diagnostics...", ephemeral: true });
        break;
      case "hooks":
        sendToClient({ type: "pty-write", text: "/hooks", raw: false });
        await cmd.reply({ content: "🪝 Showing hooks config...", ephemeral: true });
        break;
      case "kill-agents":
        // Upstream `chat:killAgents` is Ctrl+X Ctrl+K — spaced so Ink sees the chord.
        sendToClient({ type: "pty-write", text: "\x18", raw: true });
        setTimeout(() => sendToClient({ type: "pty-write", text: "\x0b", raw: true }), 100);
        await cmd.reply({ content: "🗡️ Kill-agents chord sent", ephemeral: true });
        break;
      case "cleanup":
        await handleCleanupPreview(cmd, deps);
        break;
      case "launch":
        await handleLaunch(cmd);
        break;
    }
  };

  client.on(Events.InteractionCreate, handler);
  return () => client.removeListener(Events.InteractionCreate, handler);
}

// ── /launch ──
//
// Spawns `wt.exe -w 0 nt -d <path> --title <basename> claude-remote --remote`
// detached. `-w 0` reuses the most recently used Windows Terminal window if
// one exists, otherwise creates a new one. Validation happens before the
// spawn so we can reply with a clear error in the same channel; the new tab's
// own daemon will open its own session channel once it boots.
async function handleLaunch(cmd: ChatInputCommandInteraction): Promise<void> {
  const raw = cmd.options.getString("path", true).trim();
  if (!raw) {
    await cmd.reply({ content: "❌ Path is required.", ephemeral: true });
    return;
  }
  const resolved = path.resolve(raw);

  let isDir = false;
  try {
    const stat = await fsp.stat(resolved);
    isDir = stat.isDirectory();
  } catch {
    await cmd.reply({ content: `❌ Path not found: \`${resolved}\``, ephemeral: true });
    return;
  }
  if (!isDir) {
    await cmd.reply({ content: `❌ Not a directory: \`${resolved}\``, ephemeral: true });
    return;
  }

  await cmd.deferReply({ ephemeral: true });

  const name = path.basename(resolved) || "claude-remote";
  // Wrap in `cmd /k` because wt.exe's commandline goes through CreateProcess,
  // which doesn't apply PATHEXT — npm-installed `.cmd` shims like
  // `claude-remote.cmd` only resolve through a real shell. /k keeps the tab
  // open so any startup error stays visible instead of vanishing.
  const args = ["-w", "0", "nt", "-d", resolved, "--title", name, "cmd", "/k", "claude-remote", "--remote"];

  try {
    const proc = spawn("wt.exe", args, { detached: true, stdio: "ignore", windowsHide: false });
    proc.on("error", async (err) => {
      try {
        await cmd.editReply({ content: `❌ Failed to launch Windows Terminal: ${err.message}` });
      } catch { /* reply window may have closed */ }
    });
    proc.unref();
    recordLaunchedProject(resolved);
    await cmd.editReply({
      content: [
        `🚀 Launching \`${name}\` in a new tab.`,
        `\`${resolved}\``,
        `A new Discord channel will appear once the session connects.`,
      ].join("\n"),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await cmd.editReply({ content: `❌ Failed to spawn wt.exe: ${msg}` });
  }
}

// ── Recent-sessions picker for /resume ──

interface RecentSession {
  sessionId: string;
  /** Timestamp + first-message preview, used for the menu option label. */
  label: string;
  /** Longer first-user-message preview, used for the option's secondary line. */
  preview: string;
  mtimeMs: number;
}

/**
 * List the N most recent JSONL sessions for `projectDir`, newest first. The
 * label is "{relative-time} · {short-preview}" and the preview is a longer
 * cut of the first user message, parsed from the JSONL file head.
 */
async function listRecentSessions(projectDir: string, limit: number): Promise<RecentSession[]> {
  const projectsDir = path.join(getClaudeDir(), "projects", encodeProjectPath(projectDir));
  let entries: string[];
  try {
    entries = await fsp.readdir(projectsDir);
  } catch {
    return [];
  }

  const candidates = await Promise.all(
    entries
      .filter((f) => f.endsWith(".jsonl"))
      .map(async (f) => {
        const full = path.join(projectsDir, f);
        try {
          const stat = await fsp.stat(full);
          if (stat.size === 0) return null;
          return { full, sessionId: f.slice(0, -".jsonl".length), mtimeMs: stat.mtimeMs };
        } catch {
          return null;
        }
      })
  );

  const sorted = candidates
    .filter((c): c is { full: string; sessionId: string; mtimeMs: number } => c !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit);

  return Promise.all(sorted.map(async (c) => {
    const preview = await readFirstUserMessage(c.full);
    const label = `${formatRelativeTime(c.mtimeMs)} · ${preview || c.sessionId.slice(0, 8)}`;
    return { sessionId: c.sessionId, label, preview, mtimeMs: c.mtimeMs };
  }));
}

/**
 * Read the first user message text from a JSONL transcript without loading the
 * whole file. Reads up to 64 KB from the head, splits on newlines, and walks
 * forward until it finds a `type:"user"` row whose content has a text block
 * not produced by a tool result or local-command tag.
 */
async function readFirstUserMessage(jsonlPath: string): Promise<string> {
  let buf: Buffer;
  try {
    const fd = await fsp.open(jsonlPath, "r");
    try {
      const chunk = Buffer.alloc(64 * 1024);
      const { bytesRead } = await fd.read(chunk, 0, chunk.length, 0);
      buf = chunk.subarray(0, bytesRead);
    } finally {
      await fd.close();
    }
  } catch {
    return "";
  }

  const lines = buf.toString("utf-8").split("\n");
  for (const line of lines) {
    if (!line) continue;
    let msg: { type?: string; message?: { content?: unknown }; isMeta?: boolean };
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.type !== "user" || msg.isMeta) continue;
    const content = msg.message?.content;
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      for (const block of content as Array<{ type?: string; text?: string }>) {
        if (block.type === "text" && block.text) { text = block.text; break; }
      }
    }
    if (!text) continue;
    // Skip Claude Code's local-command synthetic user rows (e.g. /clear output).
    if (text.startsWith("<local-command-stdout>") || text.startsWith("<command-")) continue;
    return text.replace(/\s+/g, " ").trim().slice(0, 200);
  }
  return "";
}

function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(ms).toLocaleDateString();
}

// ── Key parsing for /key command ──

const KEY_MAP: Record<string, string> = {
  // Navigation
  enter: "\r",
  return: "\r",
  space: " ",
  tab: "\t",
  "shift+tab": "\x1b[Z",
  escape: "\x1b",
  esc: "\x1b",
  backspace: "\x7f",
  delete: "\x1b[3~",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  home: "\x1b[H",
  end: "\x1b[F",
  pageup: "\x1b[5~",
  pagedown: "\x1b[6~",
  insert: "\x1b[2~",
  // Ctrl combinations
  "ctrl+a": "\x01",
  "ctrl+b": "\x02",
  "ctrl+c": "\x03",
  "ctrl+d": "\x04",
  "ctrl+e": "\x05",
  "ctrl+f": "\x06",
  "ctrl+g": "\x07",
  "ctrl+h": "\x7f",
  "ctrl+k": "\x0b",
  "ctrl+l": "\x0c",
  "ctrl+n": "\x0e",
  "ctrl+o": "\x0f",
  "ctrl+p": "\x10",
  "ctrl+r": "\x12",
  "ctrl+t": "\x14",
  "ctrl+u": "\x15",
  "ctrl+w": "\x17",
  // ctrl+z deliberately omitted — SIGTSTP suspends the Claude child on POSIX
  // terminals (WSL/macOS) and leaves the bridge appearing hung. Users who
  // really need it can still send the raw byte via literal text.
  // Function keys
  f1: "\x1bOP",
  f2: "\x1bOQ",
  f3: "\x1bOR",
  f4: "\x1bOS",
  f5: "\x1b[15~",
  f6: "\x1b[17~",
  f7: "\x1b[18~",
  f8: "\x1b[19~",
  f9: "\x1b[20~",
  f10: "\x1b[21~",
  f11: "\x1b[23~",
  f12: "\x1b[24~",
};

const KEY_LABELS: Record<string, string> = {
  enter: "Enter", return: "Enter", space: "Space", tab: "Tab",
  "shift+tab": "Shift+Tab", escape: "Esc", esc: "Esc",
  backspace: "Backspace", delete: "Del", insert: "Ins",
  up: "↑", down: "↓", right: "→", left: "←",
  home: "Home", end: "End", pageup: "PgUp", pagedown: "PgDn",
  "ctrl+a": "Ctrl+A", "ctrl+b": "Ctrl+B", "ctrl+c": "Ctrl+C",
  "ctrl+d": "Ctrl+D", "ctrl+e": "Ctrl+E", "ctrl+f": "Ctrl+F",
  "ctrl+g": "Ctrl+G", "ctrl+h": "Ctrl+H", "ctrl+k": "Ctrl+K",
  "ctrl+l": "Ctrl+L", "ctrl+n": "Ctrl+N", "ctrl+o": "Ctrl+O",
  "ctrl+p": "Ctrl+P", "ctrl+r": "Ctrl+R", "ctrl+t": "Ctrl+T",
  "ctrl+u": "Ctrl+U", "ctrl+w": "Ctrl+W",
  f1: "F1", f2: "F2", f3: "F3", f4: "F4", f5: "F5", f6: "F6",
  f7: "F7", f8: "F8", f9: "F9", f10: "F10", f11: "F11", f12: "F12",
};

function parseKeyInput(input: string): { keys: string[]; display: string } {
  const tokens = input.trim().split(/\s+/);
  const keys: string[] = [];
  const labels: string[] = [];

  for (const token of tokens) {
    const lower = token.toLowerCase();
    // Check for repeat syntax: "enter*3" → enter enter enter
    const repeatMatch = lower.match(/^(.+)\*(\d+)$/);
    if (repeatMatch) {
      const [, name, countStr] = repeatMatch;
      const count = Math.min(parseInt(countStr, 10), 20);
      const seq = KEY_MAP[name];
      if (seq) {
        for (let i = 0; i < count; i++) keys.push(seq);
        labels.push(`${KEY_LABELS[name] || name} x${count}`);
        continue;
      }
    }

    if (KEY_MAP[lower]) {
      keys.push(KEY_MAP[lower]);
      labels.push(KEY_LABELS[lower] || lower);
    } else {
      // Literal text — send each character
      for (const ch of token) keys.push(ch);
      labels.push(`"${token}"`);
    }
  }

  return { keys, display: labels.join(" ") };
}

async function handleQueueCommand(cmd: ChatInputCommandInteraction, deps: SlashCommandDeps) {
  const { activity } = deps;
  const sub = cmd.options.getSubcommand();

  switch (sub) {
    case "view":
      if (activity.queue.length === 0) {
        await cmd.reply({ content: "📭 Queue is empty", ephemeral: true });
      } else {
        const lines = activity.queue.map((m) =>
          `**#${m.id}** — ${m.text.slice(0, 100)}${m.text.length > 100 ? "…" : ""}`
        );
        await cmd.reply({
          embeds: [{
            title: `📥 Message Queue (${activity.queue.length})`,
            description: lines.join("\n").slice(0, 4000),
            color: COLOR.BLURPLE,
          }],
          ephemeral: true,
        });
      }
      break;
    case "clear": {
      const count = activity.clearQueue();
      activity.update(activity.state);
      await cmd.reply({ content: `🗑️ Cleared ${count} queued message${count !== 1 ? "s" : ""}`, ephemeral: true });
      break;
    }
    case "remove": {
      const id = cmd.options.getInteger("id", true);
      if (activity.removeFromQueue(id)) {
        activity.update(activity.state);
        await cmd.reply({ content: `🗑️ Removed #${id} (${activity.queue.length} remaining)`, ephemeral: true });
      } else {
        await cmd.reply({ content: `❌ Queue #${id} not found`, ephemeral: true });
      }
      break;
    }
    case "edit": {
      const id = cmd.options.getInteger("id", true);
      const item = activity.findInQueue(id);
      if (!item) {
        await cmd.reply({ content: `❌ Queue #${id} not found`, ephemeral: true });
        return;
      }
      const modal = new ModalBuilder()
        .setCustomId(`${ID_PREFIX.QUEUE_EDIT}${id}`)
        .setTitle(`Edit queued message #${id}`);
      const textInput = new TextInputBuilder()
        .setCustomId("text")
        .setLabel("Message")
        .setStyle(TextInputStyle.Paragraph)
        .setValue(item.text)
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(textInput));
      await cmd.showModal(modal);
      break;
    }
  }
}

// ── /cleanup ──

const DISCORD_EPOCH = 1420070400000n;

function snowflakeTimestamp(snowflake: string): number {
  return Number((BigInt(snowflake) >> 22n) + DISCORD_EPOCH);
}

function cleanupEmbed(deleted: number, total: number, failed: number, done: boolean) {
  const failPart = failed ? ` · ${failed} failed` : "";
  return {
    title: done ? "✅ Cleanup complete" : "🧹 Cleaning up…",
    description: `Deleted ${deleted}/${total}${failPart}`,
    color: COLOR.BLURPLE,
  };
}

async function handleCleanupPreview(cmd: ChatInputCommandInteraction, deps: SlashCommandDeps) {
  const days = cmd.options.getInteger("days", true);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  if (!deps.categoryId) {
    await cmd.reply({ content: "⚠️ No category configured — can't scope the cleanup.", ephemeral: true });
    return;
  }

  const guild = cmd.guild;
  if (!guild) return;

  const candidates: Array<{ ch: TextChannel; lastActivity: number }> = [];
  let activeSkip = 0;
  for (const [, ch] of guild.channels.cache) {
    if (ch.type !== ChannelType.GuildText) continue;
    if (ch.parentId !== deps.categoryId) continue;
    if (ch.id === deps.channelId) continue;
    if (deps.isChannelActive(ch.id)) { activeSkip++; continue; }
    const text = ch as TextChannel;
    const lastActivity = text.lastMessageId
      ? snowflakeTimestamp(text.lastMessageId)
      : (text.createdTimestamp ?? Date.now());
    if (lastActivity > cutoff) continue;
    candidates.push({ ch: text, lastActivity });
  }

  if (candidates.length === 0) {
    const note = activeSkip > 0 ? ` (${plural(activeSkip, "active session")} skipped)` : "";
    await cmd.reply({
      content: `🧹 Nothing to clean up — no channels older than ${plural(days, "day")}${note}.`,
      ephemeral: true,
    });
    return;
  }

  candidates.sort((a, b) => a.lastActivity - b.lastActivity);

  const previewLines = candidates.slice(0, CLEANUP_PREVIEW_LIMIT).map(({ ch, lastActivity }) =>
    `• #${ch.name} — ${formatRelativeTime(lastActivity)}`
  );
  if (candidates.length > CLEANUP_PREVIEW_LIMIT) {
    previewLines.push(`*…and ${candidates.length - CLEANUP_PREVIEW_LIMIT} more*`);
  }
  previewLines.push(activeSkip > 0
    ? `\n*Skipped: ${plural(activeSkip, "channel")} with active sessions, plus this one*`
    : `\n*Skipped: this channel*`);

  // Token = original interaction id, fits in customId (~19 chars + prefix).
  const token = cmd.id;
  pendingCleanups.set(token, {
    channelIds: candidates.map((c) => c.ch.id),
    invokerUserId: cmd.user.id,
    expiresAt: Date.now() + CLEANUP_TTL,
  });
  for (const [k, v] of pendingCleanups) {
    if (v.expiresAt < Date.now()) pendingCleanups.delete(k);
  }

  const confirm = new ButtonBuilder()
    .setCustomId(`${ID_PREFIX.CLEANUP_CONFIRM}${token}`)
    .setLabel(`Delete ${plural(candidates.length, "channel")}`)
    .setStyle(ButtonStyle.Danger);
  const cancel = new ButtonBuilder()
    .setCustomId(`${ID_PREFIX.CLEANUP_CANCEL}${token}`)
    .setLabel("Cancel")
    .setStyle(ButtonStyle.Secondary);

  await cmd.reply({
    embeds: [{
      title: `🧹 Cleanup preview — ${plural(candidates.length, "channel")}`,
      description: previewLines.join("\n").slice(0, 4000),
      color: COLOR.BLURPLE,
      footer: { text: `Older than ${plural(days, "day")} · expires in 5 min` },
    }],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(confirm, cancel)],
    ephemeral: true,
  });
}

async function handleCleanupConfirm(interaction: ButtonInteraction, deps: SlashCommandDeps) {
  const token = interaction.customId.slice(ID_PREFIX.CLEANUP_CONFIRM.length);
  const pending = pendingCleanups.get(token);
  if (!pending || pending.expiresAt < Date.now()) {
    pendingCleanups.delete(token);
    await interaction.update({
      content: "⌛ This cleanup request expired. Run `/cleanup` again.",
      embeds: [],
      components: [],
    });
    return;
  }
  if (interaction.user.id !== pending.invokerUserId) {
    await interaction.reply({ content: "⚠️ Only the invoker can confirm this cleanup.", ephemeral: true });
    return;
  }
  pendingCleanups.delete(token);

  // Re-check active sessions at confirm-time — a session may have spun up
  // since the preview was rendered.
  const targets = pending.channelIds.filter((id) => !deps.isChannelActive(id) && id !== deps.channelId);

  await interaction.update({
    embeds: [cleanupEmbed(0, targets.length, 0, false)],
    components: [],
  });

  const guild = interaction.guild;
  if (!guild) return;

  let deletedCount = 0;
  let failed = 0;
  const deleted: string[] = [];
  for (let i = 0; i < targets.length; i++) {
    const id = targets[i];
    // discord.js's REST client serializes deletes through its own rate-limit
    // queue, so a manual `await sleep` between calls would only stack on top
    // of that. The library's queue is the right pacing source.
    const ch = guild.channels.cache.get(id);
    if (ch) {
      try {
        await ch.delete("claude-remote /cleanup");
        deleted.push(id);
        deletedCount++;
      } catch {
        failed++;
      }
    } else {
      // Already gone — count as success.
      deleted.push(id);
      deletedCount++;
    }
    if ((i + 1) % CLEANUP_PROGRESS_EVERY === 0 || i === targets.length - 1) {
      try {
        await interaction.editReply({ embeds: [cleanupEmbed(deletedCount, targets.length, failed, false)] });
      } catch { /* best effort */ }
    }
  }

  await pruneSessionsFile(deleted);

  await interaction.editReply({ embeds: [cleanupEmbed(deletedCount, targets.length, failed, true)] });
}

async function handleCleanupCancel(interaction: ButtonInteraction) {
  const token = interaction.customId.slice(ID_PREFIX.CLEANUP_CANCEL.length);
  pendingCleanups.delete(token);
  await interaction.update({
    content: "❎ Cleanup cancelled.",
    embeds: [],
    components: [],
  });
}

/** Drop entries from sessions.json whose channelId is in `deletedIds`. The
 *  file maps Claude session-id → Discord channel-id; orphans hurt nothing
 *  but it's tidier to clear them out. */
async function pruneSessionsFile(deletedIds: string[]) {
  if (deletedIds.length === 0) return;
  try {
    const raw = await fsp.readFile(SESSIONS_FILE, "utf-8");
    const data = JSON.parse(raw) as Record<string, string>;
    const dead = new Set(deletedIds);
    let changed = false;
    for (const [sid, cid] of Object.entries(data)) {
      if (dead.has(cid)) { delete data[sid]; changed = true; }
    }
    if (changed) {
      await fsp.writeFile(SESSIONS_FILE, JSON.stringify(data, null, 2) + "\n");
    }
  } catch { /* file may not exist or be malformed — best effort */ }
}
