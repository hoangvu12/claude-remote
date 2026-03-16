import { Client, GatewayIntentBits, Events, ChannelType, EmbedBuilder, type TextChannel, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, type MessageComponentInteraction } from "discord.js";
import chokidar, { type FSWatcher } from "chokidar";
import fs from "node:fs";
import { readFile, open } from "node:fs/promises";
import path from "node:path";
import { parseJSONLString, processAssistantBlocks, processUserBlocks, processNonConversation, isRewind, walkCurrentBranch } from "./jsonl-parser.js";
import { renderMessage, renderBatch } from "./discord-renderer.js";
import { resolveJSONLPath, ID_PREFIX, CONFIG_DIR } from "./utils.js";
import type { JSONLMessage, ProcessedMessage, DaemonToParent, SessionInfoMessage } from "./types.js";

// ── State ──

let sessionId = "";
let projectDir = "";
let jsonlPath = "";
let customChannelName: string | undefined;
let channel: TextChannel | null = null;
let client: Client | null = null;
let watcher: FSWatcher | null = null;
let lastFileSize = 0;
let lastMessageUuid: string | null = null;
const MAX_SET_SIZE = 5000;
let processedUuids = new Set<string>();
let pendingToolUseIds = new Set<string>();
let resolvedToolUseIds = new Set<string>();
let permissionMessages = new Map<string, { message: import("discord.js").Message; toolUseId: string }>();
let discordOriginMessages = new Set<string>(); // messages sent from Discord, to avoid echo

// Rate limiting: 5 messages per 5 seconds
const RATE_WINDOW = 5000;
const RATE_LIMIT = 5;
let messageTimes: number[] = [];

async function rateLimitedSend(ch: TextChannel, payload: import("discord.js").MessageCreateOptions): Promise<import("discord.js").Message | null> {
  const now = Date.now();
  messageTimes = messageTimes.filter((t) => now - t < RATE_WINDOW);

  if (messageTimes.length >= RATE_LIMIT) {
    const waitUntil = messageTimes[0] + RATE_WINDOW;
    await new Promise((r) => setTimeout(r, waitUntil - now + 50));
  }

  try {
    const msg = await ch.send(payload);
    messageTimes.push(Date.now());
    return msg;
  } catch (err) {
    console.error("[daemon] Failed to send Discord message:", err);
    return null;
  }
}

function dedupKey(pm: ProcessedMessage): string {
  return pm.uuid + pm.type + (pm.toolUseId || "");
}

// ── IPC with parent (rc.ts) ──

function sendToParent(msg: DaemonToParent) {
  if (process.send) {
    process.send(msg);
  }
}

process.on("message", (msg: SessionInfoMessage) => {
  if (msg.type === "session-info") {
    sessionId = msg.sessionId;
    projectDir = msg.projectDir;
    customChannelName = msg.channelName;
    jsonlPath = resolveJSONLPath(sessionId, projectDir);
    console.log(`[daemon] Session: ${sessionId}`);
    console.log(`[daemon] JSONL: ${jsonlPath}`);
    start();
  }
});

// ── Main startup ──

async function start() {
  const token = process.env.DISCORD_BOT_TOKEN;
  const categoryId = process.env.DISCORD_CATEGORY_ID;
  const guildId = process.env.DISCORD_GUILD_ID;

  if (!token || !categoryId || !guildId) {
    console.error("[daemon] Missing DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, or DISCORD_CATEGORY_ID");
    process.exit(1);
  }

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.on(Events.Error, (err) => console.error("[daemon] Discord error:", err));

  await client.login(token);
  console.log("[daemon] Discord bot logged in");

  const guild = await client.guilds.fetch(guildId);
  if (!guild) {
    console.error("[daemon] Bot is not in the configured guild");
    process.exit(1);
  }

  // Try to reuse an existing channel for this session
  const savedChannelId = loadSessionChannel(sessionId);
  if (savedChannelId) {
    try {
      const existing = await guild.channels.fetch(savedChannelId);
      if (existing && existing.type === ChannelType.GuildText) {
        channel = existing as TextChannel;
        console.log(`[daemon] Reusing channel: #${channel.name}`);
        await rateLimitedSend(channel, { content: "🟢 **Discord sync reconnected**" });
      }
    } catch {
      // Channel was deleted, will create a new one
    }
  }

  // Create a new channel if we couldn't reuse
  if (!channel) {
    let channelName: string;
    if (customChannelName) {
      channelName = customChannelName.slice(0, 100);
    } else {
      const folderName = path.basename(projectDir);
      const timestamp = new Date().toLocaleString("en-US", {
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
      }).toLowerCase().replace(/[,\s]+/g, "-");
      channelName = `${folderName}-${timestamp}`.slice(0, 100);
    }

    try {
      channel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: categoryId,
        topic: `Claude Code session · ${projectDir} · ${sessionId.slice(0, 8)}`,
      }) as TextChannel;
    } catch (err) {
      console.error("[daemon] Failed to create channel:", err);
      process.exit(1);
    }

    console.log(`[daemon] Created channel: #${channel.name}`);
    await rateLimitedSend(channel, { content: `🟢 **Discord sync enabled**\n📁 \`${projectDir}\`\n🆔 \`${sessionId.slice(0, 8)}\`` });
  }

  saveSessionChannel(sessionId, channel.id);

  sendToParent({ type: "daemon-ready", channelId: channel.id });

  await replayHistory();
  startWatcher();

  client.on(Events.MessageCreate, handleDiscordMessage);
  client.on(Events.InteractionCreate, handleInteraction);
}

// ── Replay existing history ──

const REPLAY_FULL = 5;
const SUMMARY_TEXT_LIMIT = 10;

async function replayHistory() {
  if (!channel) return;

  try {
    const raw = await readFile(jsonlPath, "utf-8");
    lastFileSize = Buffer.byteLength(raw, "utf-8");

    const allMessages = parseJSONLString(raw);
    const branch = walkCurrentBranch(allMessages);

    // Process all for dedup tracking
    const allProcessed: ProcessedMessage[] = [];
    for (const msg of branch) {
      for (const pm of getProcessedMessages(msg)) {
        processedUuids.add(dedupKey(pm));
        allProcessed.push(pm);
      }
      lastMessageUuid = msg.uuid;
    }

    if (allProcessed.length === 0) return;

    const splitAt = Math.max(0, allProcessed.length - REPLAY_FULL);
    const older = allProcessed.slice(0, splitAt);
    const recent = allProcessed.slice(splitAt);

    // Build a single summary message for older history
    if (older.length > 0) {
      const textMessages: string[] = [];
      let toolCount = 0;

      for (const pm of older) {
        if (pm.type === "user-prompt") {
          textMessages.push(`**You**: ${pm.content.slice(0, 80)}${pm.content.length > 80 ? "…" : ""}`);
        } else if (pm.type === "assistant-text") {
          textMessages.push(`**Claude**: ${pm.content.slice(0, 100)}${pm.content.length > 100 ? "…" : ""}`);
        } else if (pm.type === "tool-use" || pm.type === "tool-result" || pm.type === "tool-result-error") {
          toolCount++;
        }
      }

      const lines: string[] = [];
      const shown = textMessages.slice(-SUMMARY_TEXT_LIMIT);
      const skippedText = textMessages.length - shown.length;

      if (skippedText > 0 || toolCount > 0) {
        const parts: string[] = [];
        if (skippedText > 0) parts.push(`${skippedText} earlier messages`);
        if (toolCount > 0) parts.push(`${toolCount} tool calls`);
        lines.push(`*… ${parts.join(", ")} not shown*\n`);
      }

      lines.push(...shown);

      const embed = new EmbedBuilder()
        .setTitle("📜 Conversation history")
        .setDescription(lines.join("\n").slice(0, 4000))
        .setColor(0x2c2f33);
      await rateLimitedSend(channel, { embeds: [embed] });
    }

    // Send recent messages in full (batched)
    for (const payload of renderBatch(recent)) {
      await rateLimitedSend(channel, payload);
    }

    console.log(`[daemon] Replayed: ${older.length} summarized, ${recent.length} full`);
  } catch (err) {
    console.log("[daemon] No existing JSONL to replay (or error):", err);
  }
}

// ── JSONL Watcher ──

function startWatcher() {
  watcher = chokidar.watch(jsonlPath, {
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });

  watcher.on("change", handleFileChange);
  watcher.on("error", (err: unknown) => console.error("[daemon] Watcher error:", err));
  console.log("[daemon] Watching JSONL for changes");
}

// Debounce buffer — collect messages over a short window then send as batch
const BATCH_DELAY = 600;
let pendingBatch: ProcessedMessage[] = [];
let batchTimer: ReturnType<typeof setTimeout> | null = null;

async function flushBatch() {
  batchTimer = null;
  if (!channel || pendingBatch.length === 0) return;

  const batch = pendingBatch;
  pendingBatch = [];

  for (const payload of renderBatch(batch)) {
    await rateLimitedSend(channel, payload);
  }
}

function enqueueBatch(pm: ProcessedMessage) {
  pendingBatch.push(pm);

  // Flush immediately for user prompts and assistant text (conversation flow)
  if (pm.type === "user-prompt" || pm.type === "assistant-text") {
    if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
    flushBatch();
    return;
  }

  // Debounce tool calls to group them
  if (batchTimer) clearTimeout(batchTimer);
  batchTimer = setTimeout(flushBatch, BATCH_DELAY);
}

async function handleFileChange(filePath: string) {
  if (!channel) return;

  try {
    const fd = await open(filePath, "r");
    const stat = await fd.stat();
    const newSize = stat.size;

    if (newSize <= lastFileSize) {
      await fd.close();
      return;
    }

    const buf = Buffer.alloc(newSize - lastFileSize);
    await fd.read(buf, 0, buf.length, lastFileSize);
    await fd.close();
    lastFileSize = newSize;

    const newLines = buf.toString("utf-8").split("\n").filter(Boolean);

    for (const line of newLines) {
      let msg: JSONLMessage;
      try {
        msg = JSON.parse(line) as JSONLMessage;
      } catch {
        continue;
      }

      if (isRewind(msg, lastMessageUuid)) {
        if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
        pendingBatch = [];
        await rateLimitedSend(channel, { content: "⏪ Conversation rewound" });
        processedUuids.clear();
        pendingToolUseIds.clear();
        resolvedToolUseIds.clear();
      }

      // Track tool_result arrivals to resolve pending permission prompts
      if (msg.type === "user" && msg.message && Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if (block.type === "tool_result") {
            resolvedToolUseIds.add(block.tool_use_id);
            pendingToolUseIds.delete(block.tool_use_id);
            const permMsg = permissionMessages.get(block.tool_use_id);
            if (permMsg) {
              try { await permMsg.message.edit({ components: [] }); } catch { /* already edited */ }
              permissionMessages.delete(block.tool_use_id);
            }
          }
        }
      }

      for (const pm of getProcessedMessages(msg)) {
        const key = dedupKey(pm);
        if (processedUuids.has(key)) continue;
        processedUuids.add(key);

        // Skip messages that originated from Discord (avoid echo)
        if (pm.type === "user-prompt" && discordOriginMessages.has(pm.content.trim())) {
          discordOriginMessages.delete(pm.content.trim());
          continue;
        }

        // Track tool-use for permission timeout
        if (pm.type === "tool-use" && pm.toolUseId) {
          const toolUseId = pm.toolUseId;
          const toolName = pm.toolName || "Unknown";
          const content = pm.content;
          const uuid = pm.uuid;
          setTimeout(async () => {
            if (resolvedToolUseIds.has(toolUseId)) return;
            pendingToolUseIds.add(toolUseId);
            for (const pp of renderMessage({
              type: "permission-prompt", content, uuid, toolName, toolUseId,
            })) {
              const sent = await rateLimitedSend(channel!, pp);
              if (sent) permissionMessages.set(toolUseId, { message: sent, toolUseId });
            }
          }, 2500);
        }

        enqueueBatch(pm);
      }

      lastMessageUuid = msg.uuid;
    }

    // Cap sets to prevent unbounded growth
    if (processedUuids.size > MAX_SET_SIZE) processedUuids = new Set([...processedUuids].slice(-MAX_SET_SIZE / 2));
    if (resolvedToolUseIds.size > MAX_SET_SIZE) resolvedToolUseIds = new Set([...resolvedToolUseIds].slice(-MAX_SET_SIZE / 2));
  } catch (err) {
    console.error("[daemon] Error reading JSONL changes:", err);
  }
}

function getProcessedMessages(msg: JSONLMessage): ProcessedMessage[] {
  if (msg.type === "assistant") return processAssistantBlocks(msg);
  if (msg.type === "user") return processUserBlocks(msg);
  const single = processNonConversation(msg);
  return single ? [single] : [];
}

// ── Discord message handler ──

async function handleDiscordMessage(message: import("discord.js").Message) {
  if (!channel || !client) return;
  if (message.author.bot) return;
  if (message.channel.id !== channel.id) return;

  const text = message.content.trim();
  if (!text) return;

  console.log(`[daemon] Discord input: ${text}`);
  discordOriginMessages.add(text);
  sendToParent({ type: "pty-write", text });
}

// ── Interaction handler ──

async function handleInteraction(interaction: import("discord.js").Interaction) {
  if (!interaction.isMessageComponent() && !interaction.isModalSubmit()) return;

  if (interaction.isButton()) {
    const id = interaction.customId;

    if (id.startsWith(ID_PREFIX.ALLOW)) {
      const toolUseId = id.slice(ID_PREFIX.ALLOW.length);
      pendingToolUseIds.delete(toolUseId);
      resolvedToolUseIds.add(toolUseId);
      sendToParent({ type: "pty-write", text: "y" });
      await interaction.update({ content: "✅ Allowed", components: [] });
      permissionMessages.delete(toolUseId);
      return;
    }

    if (id.startsWith(ID_PREFIX.DENY)) {
      const toolUseId = id.slice(ID_PREFIX.DENY.length);
      pendingToolUseIds.delete(toolUseId);
      resolvedToolUseIds.add(toolUseId);
      sendToParent({ type: "pty-write", text: "n" });
      await interaction.update({ content: "❌ Denied", components: [] });
      permissionMessages.delete(toolUseId);
      return;
    }

    if (id.startsWith(ID_PREFIX.ASK)) {
      const parts = id.split(":");
      const selectedLabel = parts[3];
      sendToParent({ type: "pty-write", text: selectedLabel });
      await interaction.update({ content: `Selected: **${selectedLabel}**`, components: [] });
      return;
    }

    if (id.startsWith(ID_PREFIX.ASK_OTHER)) {
      const parts = id.split(":");
      const header = parts[2] || "Answer";

      const modal = new ModalBuilder()
        .setCustomId(`${ID_PREFIX.MODAL}${id}`)
        .setTitle("Custom answer");

      const textInput = new TextInputBuilder()
        .setCustomId("text")
        .setLabel(header)
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(textInput));
      await (interaction as MessageComponentInteraction).showModal(modal);
      return;
    }
  }

  if (interaction.isStringSelectMenu()) {
    if (interaction.customId.startsWith(ID_PREFIX.ASK)) {
      const selected = interaction.values.join(", ");
      sendToParent({ type: "pty-write", text: selected });
      await interaction.update({ content: `Selected: **${selected}**`, components: [] });
      return;
    }
  }

  if (interaction.isModalSubmit()) {
    const text = interaction.fields.getTextInputValue("text");
    if (text) {
      sendToParent({ type: "pty-write", text });
      await interaction.reply({ content: `Answered: **${text}**`, ephemeral: true });
    }
  }
}

// ── Session ↔ Channel mapping ──

const SESSIONS_FILE = path.join(CONFIG_DIR, "sessions.json");

function loadSessionChannel(sid: string): string | null {
  try {
    const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf-8")) as Record<string, string>;
    return data[sid] || null;
  } catch {
    return null;
  }
}

function saveSessionChannel(sid: string, channelId: string): void {
  try {
    let data: Record<string, string> = {};
    try {
      data = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf-8"));
    } catch { /* fresh file */ }
    data[sid] = channelId;
    fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true });
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2) + "\n");
  } catch { /* best effort */ }
}

// ── Cleanup ──

process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);
process.on("disconnect", cleanup);

async function cleanup() {
  console.log("[daemon] Cleaning up...");
  if (watcher) await watcher.close();
  if (channel) {
    try { await channel.send("🔴 **Discord sync disabled**"); } catch { /* channel may be gone */ }
  }
  if (client) client.destroy();
  process.exit(0);
}
