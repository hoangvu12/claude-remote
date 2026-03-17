import { Client, GatewayIntentBits, Events, ChannelType, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, type TextChannel, type MessageComponentInteraction } from "discord.js";
import chokidar, { type FSWatcher } from "chokidar";
import fs from "node:fs";
import { readFile, open } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseJSONLString, processAssistantBlocks, processUserBlocks, processNonConversation, walkCurrentBranch, getToolInputPreview } from "./jsonl-parser.js";
import { renderBatch, COLOR } from "./discord-renderer.js";
import { resolveJSONLPath, ID_PREFIX, CONFIG_DIR, capSet, truncate, extractToolResultText } from "./utils.js";
import type { JSONLMessage, ProcessedMessage, ContentBlock, ContentBlockToolUse, ContentBlockText, ContentBlockToolResult, DaemonToParent, SessionInfoMessage } from "./types.js";
import { DiscordProvider } from "./providers/discord.js";
import { createPipeline } from "./create-pipeline.js";
import type { SessionContext } from "./handler.js";
import type { HandlerPipeline } from "./pipeline.js";
import { hasInput, hasThreads } from "./provider.js";
import { toolState } from "./handlers/tool-state.js";
import { closePassiveGroup } from "./handlers/passive-tools.js";
import { ActivityManager } from "./activity.js";
import { setupSlashCommands } from "./slash-commands.js";

// ── State ──

let sessionId = "";
let projectDir = "";
let jsonlPath = "";
let customChannelName: string | undefined;
let watcher: FSWatcher | null = null;
let lastFileSize = 0;
let lastMessageUuid: string | null = null;
const MAX_SET_SIZE = 5000;
let processedUuids = new Set<string>();
let knownUuids = new Set<string>();

let ctx: SessionContext | null = null;
let pipeline: HandlerPipeline | null = null;
let provider: DiscordProvider | null = null;
let activity: ActivityManager | null = null;

// ── Batching ──

const BATCH_DELAY = 600;
let pendingBatch: ProcessedMessage[] = [];
let batchTimer: ReturnType<typeof setTimeout> | null = null;
let flushPromise: Promise<void> = Promise.resolve();

// ── IPC with parent (rc.ts) ──

function sendToParent(msg: DaemonToParent) {
  if (process.send) {
    process.send(msg);
  }
}

let reuseChannelId: string | undefined;

process.on("message", (msg: SessionInfoMessage) => {
  if (msg.type === "session-info") {
    sessionId = msg.sessionId;
    projectDir = msg.projectDir;
    customChannelName = msg.channelName;
    reuseChannelId = msg.reuseChannelId;
    jsonlPath = msg.transcriptPath || resolveJSONLPath(sessionId, projectDir);
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

  const client = new Client({
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

  // Try to reuse an existing channel — prefer reuseChannelId (from /clear), then session mapping
  let channel: TextChannel | null = null;
  let isContextClear = false;
  const savedChannelId = reuseChannelId || loadSessionChannel(sessionId);
  if (savedChannelId) {
    try {
      const existing = await guild.channels.fetch(savedChannelId);
      if (existing && existing.type === ChannelType.GuildText) {
        channel = existing as TextChannel;
        isContextClear = !!reuseChannelId;
        console.log(`[daemon] Reusing channel: #${channel.name}${isContextClear ? " (context cleared)" : ""}`);
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
  }

  saveSessionChannel(sessionId, channel.id);

  // Create provider and activity manager
  provider = new DiscordProvider(client, channel);
  activity = new ActivityManager(provider, sendToParent);

  if (isContextClear) {
    await provider.send({ text: "🧹 **Context cleared** — new conversation started" });
  } else if (!savedChannelId) {
    await provider.send({ text: `🟢 **Discord sync enabled**\n📁 \`${projectDir}\`\n🆔 \`${sessionId.slice(0, 8)}\`` });
  } else {
    await provider.send({ text: "🟢 **Discord sync reconnected**" });
  }

  ctx = {
    sessionId,
    projectDir,
    provider,
    permissionMode: null,
    resolvedToolUseIds: new Set<string>(),
    originMessages: new Set<string>(),
    sendToPty: (text: string) => sendToParent({ type: "pty-write", text }),
  };

  activity.setContext(ctx);
  activity.onIdle(() => {
    // Schedule on flushPromise so it runs AFTER any pending batch processing
    flushPromise = flushPromise.then(() => closePassiveGroup(ctx!)).catch(() => {});
  });

  // Register slash commands
  await setupSlashCommands(client, guildId, {
    getCtx: () => ctx,
    activity,
    sendToParent,
    provider,
    projectDir,
    sessionId,
  });

  pipeline = createPipeline();
  pipeline.init(ctx);

  // Wire up Discord input → PTY
  if (hasInput(provider)) {
    provider.onUserMessage((text) => {
      console.log(`[daemon] Discord input: ${text}`);
      if (activity!.busy) {
        const msg = activity!.enqueue(text);
        provider!.send({
          embed: {
            description: `📥 Queued #${msg.id} (${activity!.queue.length} in queue)\n>>> ${text.slice(0, 200)}`,
            color: COLOR.BLURPLE,
          },
        });
        activity!.update(activity!.state, client);
        return;
      }
      activity!.busy = true;
      activity!.resetIdleTimer();
      ctx!.originMessages.add(text);
      sendToParent({ type: "pty-write", text });
      activity!.update("thinking", client);
    });

    provider.onInteraction((interaction) => {
      const id = interaction.customId;

      if (id.startsWith(ID_PREFIX.ALLOW)) {
        const toolUseId = id.slice(ID_PREFIX.ALLOW.length);
        ctx!.resolvedToolUseIds.add(toolUseId);
        sendToParent({ type: "pty-write", text: "y", raw: true });
        provider!.respond(interaction, { text: "✅ Allowed" });
        return;
      }

      if (id.startsWith(ID_PREFIX.DENY)) {
        const toolUseId = id.slice(ID_PREFIX.DENY.length);
        ctx!.resolvedToolUseIds.add(toolUseId);
        sendToParent({ type: "pty-write", text: "n", raw: true });
        provider!.respond(interaction, { text: "❌ Denied" });
        return;
      }

      if (id.startsWith(ID_PREFIX.PLAN_FEEDBACK)) {
        // "Keep planning" — show a modal for feedback text
        const ref = interaction.ref as MessageComponentInteraction;
        const modal = new ModalBuilder()
          .setCustomId(`${ID_PREFIX.MODAL}${id}`)
          .setTitle("Keep planning");
        const textInput = new TextInputBuilder()
          .setCustomId("text")
          .setLabel("What should Claude change about the plan?")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setPlaceholder("Leave empty to just stay in plan mode");
        modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(textInput));
        ref.showModal(modal).catch(() => {});
        return;
      }

      if (id.startsWith(ID_PREFIX.PLAN)) {
        const optionNum = id.slice(ID_PREFIX.PLAN.length);
        const labels: Record<string, string> = {
          "1": "Clear context & implement",
          "2": "Implement (keep context)",
          "3": "Manually approve edits",
        };

        sendToParent({ type: "pty-write", text: optionNum, raw: true });
        provider!.respond(interaction, {
          embed: {
            description: `📐 ${labels[optionNum] || "Plan approved"}`,
            color: 0x43b581,
          },
        });
        return;
      }

      if (interaction.type === "button" && id.startsWith(ID_PREFIX.ASK) && interaction.values?.[0]) {
        sendToParent({ type: "pty-write", text: interaction.values[0] });
        provider!.respond(interaction, { text: `Selected: **${interaction.values[0]}**` });
        return;
      }

      if (interaction.type === "select" && interaction.text) {
        sendToParent({ type: "pty-write", text: interaction.text });
        provider!.respond(interaction, { text: `Selected: **${interaction.text}**` });
        return;
      }

      if (interaction.type === "modal-submit") {
        if (id.startsWith(ID_PREFIX.QUEUE_EDIT) || id.startsWith(`${ID_PREFIX.MODAL}${ID_PREFIX.QUEUE_EDIT}`)) {
          const prefix = id.startsWith(ID_PREFIX.QUEUE_EDIT) ? ID_PREFIX.QUEUE_EDIT : `${ID_PREFIX.MODAL}${ID_PREFIX.QUEUE_EDIT}`;
          const queueId = parseInt(id.slice(prefix.length));
          const item = activity!.findInQueue(queueId);
          if (item && interaction.text) {
            item.text = interaction.text;
            provider!.respond(interaction, { text: `✏️ Queue #${queueId} updated` });
          }
          return;
        }

        if (id.includes(ID_PREFIX.PLAN_FEEDBACK)) {
          const feedback = interaction.text?.trim();
          if (feedback) {
            sendToParent({ type: "pty-write", text: "4", raw: true });
            setTimeout(() => {
              sendToParent({ type: "pty-write", text: feedback, raw: true });
              setTimeout(() => sendToParent({ type: "pty-write", text: "\r", raw: true }), 100);
            }, 100);
            provider!.respond(interaction, {
              embed: { description: `📐 Keep planning: ${feedback}`, color: 0xf5a623 },
            });
          } else {
            sendToParent({ type: "pty-write", text: "\x1b", raw: true });
            provider!.respond(interaction, {
              embed: { description: "📐 Staying in plan mode", color: 0xf5a623 },
            });
          }
          return;
        }

        if (interaction.text) {
          sendToParent({ type: "pty-write", text: interaction.text });
          provider!.respond(interaction, { text: `Answered: **${interaction.text}**` });
        }
      }
    });
  }

  sendToParent({ type: "daemon-ready", channelId: channel.id });

  activity.update("idle", client);
  await replayHistory();
  startWatcher();
}

// ── Replay existing history ──

const REPLAY_FULL = 5;
const SUMMARY_TEXT_LIMIT = 10;

async function replayHistory() {
  if (!ctx || !provider) return;

  await provider.cleanupThreads();

  try {
    const raw = await readFile(jsonlPath, "utf-8");
    lastFileSize = Buffer.byteLength(raw, "utf-8");

    const allMessages = parseJSONLString(raw);
    const branch = walkCurrentBranch(allMessages);

    // Track permissionMode from history
    for (const msg of branch) {
      if (msg.type === "user" && msg.permissionMode) {
        ctx.permissionMode = msg.permissionMode;
      }
    }

    // Process all for dedup tracking
    const allProcessed: ProcessedMessage[] = [];
    for (const msg of branch) {
      knownUuids.add(msg.uuid);
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

      await provider.send({
        embed: {
          title: "📜 Conversation history",
          description: lines.join("\n").slice(0, 4000),
          color: 0x2c2f33,
        },
      });
    }

    // Send recent messages in full (batched — tool results skipped, threads not created for replay)
    for (const msg of renderBatch(recent)) {
      await provider.send(msg);
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

function dedupKey(pm: ProcessedMessage): string {
  return pm.uuid + pm.type + (pm.toolUseId || "");
}

function enqueueBatch(pm: ProcessedMessage) {
  pendingBatch.push(pm);

  if (pm.type === "user-prompt" || pm.type === "assistant-text") {
    if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
    flushBatch();
    return;
  }

  if (batchTimer) clearTimeout(batchTimer);
  batchTimer = setTimeout(flushBatch, BATCH_DELAY);
}

async function flushBatch() {
  batchTimer = null;
  if (!ctx || pendingBatch.length === 0) return;
  flushPromise = flushPromise.then(_flushBatch).catch((err) => {
    console.error("[daemon] Flush error:", err);
  });
}

async function _flushBatch() {
  if (!ctx || !pipeline || pendingBatch.length === 0) return;

  const batch = pendingBatch;
  pendingBatch = [];

  for (const pm of batch) {
    try {
      await pipeline.process(pm, ctx);
    } catch (err) {
      console.error(`[daemon] Error processing ${pm.type}:`, err);
    }
  }
}

async function handleFileChange(filePath: string) {
  if (!ctx) return;

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
    let rewindHandled = false; // prevent cascading rewind detection within a batch

    for (const line of newLines) {
      let msg: JSONLMessage;
      try {
        msg = JSON.parse(line) as JSONLMessage;
      } catch {
        continue;
      }

      if (msg.type === "user" && msg.permissionMode) {
        ctx.permissionMode = msg.permissionMode;
      }

      // Any JSONL event while busy resets the idle safety timer
      if (activity?.busy) activity.resetIdleTimer();

      // Activity tracking from JSONL events (skip if recently stopped)
      if (activity && Date.now() >= activity.stopOverrideUntil) {
        if (msg.type === "assistant" && msg.message && Array.isArray(msg.message.content)) {
          const blocks = msg.message.content as ContentBlock[];
          const hasToolUse = blocks.some((b) => b.type === "tool_use");
          if (hasToolUse) {
            activity.update("working");
          } else if (blocks.some((b) => b.type === "text")) {
            // Text-only assistant message = turn complete
            activity.busy = false;
            activity.update("idle"); // onIdle callback closes passive group
            setTimeout(() => activity!.tryDequeue(), 500);
          }
        } else if (msg.type === "user" && msg.message && !activity.busy) {
          activity.busy = true;
          activity.resetIdleTimer();
          activity.update("thinking");
        }
      }

      // Agent sub-agent progress → forward to parent tool's thread
      if (msg.type === "progress" && msg.data?.type === "agent_progress" && msg.parentToolUseID) {
        await forwardAgentProgress(msg);
      }

      // Rewind detection (only once per batch to avoid cascading)
      // Only trigger on main-chain user/assistant messages — subagent progress
      // and sidechain messages produce parentUuids outside knownUuids normally
      if (
        !rewindHandled &&
        !msg.isSidechain &&
        !msg.parentToolUseID &&
        (msg.type === "assistant" || msg.type === "user") &&
        msg.parentUuid &&
        lastMessageUuid &&
        !knownUuids.has(msg.parentUuid)
      ) {
        rewindHandled = true;
        if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
        pendingBatch = [];
        await ctx.provider.send({ text: "⏪ Conversation rewound" });
        processedUuids.clear();
        ctx.resolvedToolUseIds.clear();
        knownUuids.clear();
      }

      knownUuids.add(msg.uuid);

      // Track tool_result arrivals
      if (msg.type === "user" && msg.message && Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if (block.type === "tool_result") {
            ctx.resolvedToolUseIds.add(block.tool_use_id);
          }
        }
      }

      for (const pm of getProcessedMessages(msg)) {
        const key = dedupKey(pm);
        if (processedUuids.has(key)) continue;
        processedUuids.add(key);

        if (pm.type === "user-prompt" && ctx.originMessages.has(pm.content.trim())) {
          ctx.originMessages.delete(pm.content.trim());
          continue;
        }

        enqueueBatch(pm);
      }

      lastMessageUuid = msg.uuid;
    }

    // Cap sets to prevent unbounded growth (in-place to preserve references)
    capSet(processedUuids, MAX_SET_SIZE);
    capSet(ctx.resolvedToolUseIds, MAX_SET_SIZE);
    capSet(knownUuids, MAX_SET_SIZE);
    capSet(toolState.taskToolUseIds, MAX_SET_SIZE);
  } catch (err) {
    console.error("[daemon] Error reading JSONL changes:", err);
  }
}

/** Forward sub-agent progress to the parent tool's thread */
async function forwardAgentProgress(msg: JSONLMessage) {
  if (!ctx) return;
  const parentEntry = toolState.toolUseThreads.get(msg.parentToolUseID!);
  if (!parentEntry?.thread || !hasThreads(ctx.provider)) return;

  const innerMsg = msg.data!.message as { type: string; message?: { role: string; content: ContentBlock[] | string } } | undefined;
  if (!innerMsg?.message) return;

  const content = innerMsg.message.content;
  if (innerMsg.type === "assistant" && Array.isArray(content)) {
    for (const block of content as ContentBlock[]) {
      if (block.type === "tool_use") {
        const tb = block as ContentBlockToolUse;
        const preview = getToolInputPreview(tb.name, tb.input);
        await ctx.provider.sendToThread(parentEntry.thread, {
          embed: { description: `🔧 **${tb.name}** ${preview}`, color: COLOR.TOOL },
        });
      } else if (block.type === "text" && (block as ContentBlockText).text.trim()) {
        await ctx.provider.sendToThread(parentEntry.thread, {
          text: truncate((block as ContentBlockText).text.trim(), 1900),
        });
      }
    }
  } else if (innerMsg.type === "user" && Array.isArray(content)) {
    for (const block of content as ContentBlock[]) {
      if (block.type === "tool_result") {
        const tb = block as ContentBlockToolResult;
        const resultText = extractToolResultText(tb.content).trim();
        const isError = !!tb.is_error;
        const icon = isError ? "❌" : "✅";
        if (resultText && resultText !== "undefined") {
          await ctx.provider.sendToThread(parentEntry.thread, {
            text: `${icon}\n\`\`\`\n${truncate(resultText, 1800)}\n\`\`\``,
          });
        } else {
          await ctx.provider.sendToThread(parentEntry.thread, {
            text: `${icon} *(no output)*`,
          });
        }
      }
    }
  }
}

function getProcessedMessages(msg: JSONLMessage): ProcessedMessage[] {
  if (msg.type === "assistant") return processAssistantBlocks(msg);
  if (msg.type === "user") return processUserBlocks(msg);
  const single = processNonConversation(msg);
  return single ? [single] : [];
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

// ── Hot-reload ──

const RELOAD_EXIT_CODE = 42;

chokidar.watch(path.resolve(import.meta.dirname, "daemon.js"), { ignoreInitial: true }).on("change", () => {
  console.log("[daemon] Code changed, exiting for reload...");
  if (provider) {
    provider.send({ text: "🔄 **Reloading...**" }).catch(() => {}).finally(() => process.exit(RELOAD_EXIT_CODE));
  } else {
    process.exit(RELOAD_EXIT_CODE);
  }
});

// ── Cleanup ──

process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);
process.on("disconnect", cleanup);

async function cleanup() {
  if (activity) activity.destroy();
  if (pipeline) pipeline.destroy();
  if (watcher) await watcher.close();
  if (provider) {
    try { await provider.send({ text: "🔴 **Discord sync disabled**" }); } catch { /* may be gone */ }
    await provider.destroy();
  }
  process.exit(0);
}
