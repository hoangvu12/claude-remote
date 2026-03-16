import { Client, GatewayIntentBits, Events, ChannelType, EmbedBuilder, type TextChannel, type ThreadChannel, type Message, type MessageCreateOptions, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, type MessageComponentInteraction } from "discord.js";
import chokidar, { type FSWatcher } from "chokidar";
import fs from "node:fs";
import { readFile, open } from "node:fs/promises";
import path from "node:path";
import { parseJSONLString, processAssistantBlocks, processUserBlocks, processNonConversation, walkCurrentBranch } from "./jsonl-parser.js";
import { renderMessage, renderBatch, renderToolResultThreadMessages, renderPermissionPrompt } from "./discord-renderer.js";
import { resolveJSONLPath, truncate, ID_PREFIX, CONFIG_DIR } from "./utils.js";
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
let resolvedToolUseIds = new Set<string>();
let discordOriginMessages = new Set<string>();
let knownUuids = new Set<string>(); // all UUIDs we've seen — for rewind detection
let currentPermissionMode: string | null = null;
let thinkingMessage: Message | null = null;

// Thread tracking: toolUseId → { thread, toolInfo }
const toolUseThreads = new Map<string, {
  thread: ThreadChannel;
  toolName: string;
  content: string;
}>();

// Rate limiting: 5 messages per 5 seconds
const RATE_WINDOW = 5000;
const RATE_LIMIT = 5;
let messageTimes: number[] = [];

async function rateLimitedSend(ch: TextChannel | ThreadChannel, payload: MessageCreateOptions): Promise<Message | null> {
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

async function showThinking() {
  if (!channel || thinkingMessage) return;
  thinkingMessage = await rateLimitedSend(channel, { content: "💭 **Thinking…**" });
}

async function clearThinking() {
  if (!thinkingMessage) return;
  try { await thinkingMessage.delete(); } catch { /* already gone */ }
  thinkingMessage = null;
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
    // Use transcript path from hook if available, otherwise fall back to resolving it
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

  // Clean up old threads from previous connections
  try {
    const activeThreads = await channel.threads.fetchActive();
    for (const [, thread] of activeThreads.threads) {
      try { await thread.delete(); } catch { /* may already be gone */ }
    }
  } catch { /* no threads to clean */ }

  try {
    const raw = await readFile(jsonlPath, "utf-8");
    lastFileSize = Buffer.byteLength(raw, "utf-8");

    const allMessages = parseJSONLString(raw);
    const branch = walkCurrentBranch(allMessages);

    // Track permissionMode from history
    for (const msg of branch) {
      if (msg.type === "user" && msg.permissionMode) {
        currentPermissionMode = msg.permissionMode;
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

      const embed = new EmbedBuilder()
        .setTitle("📜 Conversation history")
        .setDescription(lines.join("\n").slice(0, 4000))
        .setColor(0x2c2f33);
      await rateLimitedSend(channel, { embeds: [embed] });
    }

    // Send recent messages in full (batched — tool results skipped, threads not created for replay)
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

// Tools that get collapsed into "Read 3 files" / "Searched 2 patterns, read 1 file"
const PASSIVE_TOOLS = new Set(["Read", "Grep", "Glob"]);

function isPassiveToolUse(pm: ProcessedMessage): boolean {
  return pm.type === "tool-use" && !!pm.toolUseId && PASSIVE_TOOLS.has(pm.toolName || "");
}

// Track the current open passive tool group for retroactive merging
let activePassiveGroup: {
  thread: ThreadChannel;
  counts: Map<string, number>;
  toolUseIds: string[];
} | null = null;

// No time window — group stays open until a non-passive message closes it

function passiveGroupSummary(counts: Map<string, number>): string {
  const labels: Record<string, string> = { Read: "file", Grep: "pattern", Glob: "pattern" };
  const parts = [...counts.entries()].map(([name, count]) => {
    const noun = labels[name] || "call";
    return `${name} ${count} ${noun}${count > 1 ? "s" : ""}`;
  });
  return parts.join(", ");
}

async function closePassiveGroup() {
  if (!activePassiveGroup) return;
  const g = activePassiveGroup;
  activePassiveGroup = null;

  // Rename with ✅ and archive
  try {
    const summary = passiveGroupSummary(g.counts);
    await g.thread.setName(truncate(`${summary} ✅`, 100));
  } catch { /* rate limited */ }
  try { await g.thread.setArchived(true); } catch { /* best effort */ }
}

let flushPromise: Promise<void> = Promise.resolve();

async function flushBatch() {
  batchTimer = null;
  if (!channel || pendingBatch.length === 0) return;
  // Serialize flushes to prevent out-of-order messages
  flushPromise = flushPromise.then(_flushBatch);
}

async function _flushBatch() {
  if (!channel || pendingBatch.length === 0) return;

  const batch = pendingBatch;
  pendingBatch = [];

  for (const pm of batch) {
    // Show thinking indicator after user prompt
    if (pm.type === "user-prompt") {
      for (const payload of renderMessage(pm)) {
        await rateLimitedSend(channel!, payload);
      }
      await showThinking();
      continue;
    }

    // Clear thinking on first assistant response
    if (pm.type === "assistant-text" || pm.type === "tool-use") {
      await clearThinking();
    }

    // Passive tool-use: merge into active group or start new one
    if (isPassiveToolUse(pm)) {
      await handlePassiveToolUse(pm);
      continue;
    }

    // Tool results for the active passive group don't close it
    if ((pm.type === "tool-result" || pm.type === "tool-result-error") && pm.toolUseId) {
      await handleToolResult(pm);
      continue;
    }

    // Any other non-passive message closes the current passive group
    await closePassiveGroup();

    // Edit/Write: show inline in channel, no thread
    if (pm.type === "tool-use" && pm.toolUseId && (pm.toolName === "Edit" || pm.toolName === "Write")) {
      const msgs = formatToolInput(pm);
      for (const msg of msgs) {
        await rateLimitedSend(channel!, msg);
      }
      // Mark as resolved so result doesn't create a thread
      resolvedToolUseIds.add(pm.toolUseId);
      continue;
    }

    if (pm.type === "tool-use" && pm.toolUseId) {
      await handleToolUse(pm);
    } else {
      for (const payload of renderMessage(pm)) {
        await rateLimitedSend(channel!, payload);
      }
    }
  }
}

/**
 * Tokenize a line into words and separators for word-level diffing.
 * E.g. "foo(bar, baz)" → ["foo", "(", "bar", ", ", "baz", ")"]
 */
function tokenize(line: string): string[] {
  return line.match(/\w+|\s+|[^\w\s]+/g) || [];
}

/**
 * Simple LCS on token arrays — returns the set of matched indices in each array.
 */
function lcsTokens(a: string[], b: string[]): [Set<number>, Set<number>] {
  const m = a.length, n = b.length;
  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  // Backtrack to find matched indices
  const matchedA = new Set<number>();
  const matchedB = new Set<number>();
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { matchedA.add(i); matchedB.add(j); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return [matchedA, matchedB];
}

/**
 * Word-level diff highlighting between two lines.
 * Returns ANSI-formatted strings with only changed tokens highlighted.
 */
function highlightLineDiff(oldLine: string, newLine: string): [string, string] {
  const oldToks = tokenize(oldLine);
  const newToks = tokenize(newLine);
  const [matchedOld, matchedNew] = lcsTokens(oldToks, newToks);

  // If most tokens changed (>60%), skip highlighting
  let oldChanged = 0, oldTotal = 0, newChanged = 0, newTotal = 0;
  for (let i = 0; i < oldToks.length; i++) {
    if (oldToks[i].trim()) { oldTotal++; if (!matchedOld.has(i)) oldChanged++; }
  }
  for (let i = 0; i < newToks.length; i++) {
    if (newToks[i].trim()) { newTotal++; if (!matchedNew.has(i)) newChanged++; }
  }
  if (oldTotal > 0 && oldChanged / oldTotal > 0.6) return [oldLine, newLine];
  if (newTotal > 0 && newChanged / newTotal > 0.6) return [oldLine, newLine];

  // Build highlighted strings — only changed (unmatched) tokens get bold+underline
  let oldHl = "";
  for (let i = 0; i < oldToks.length; i++) {
    if (matchedOld.has(i)) oldHl += oldToks[i];
    else oldHl += `\u001b[1;4;31m${oldToks[i]}\u001b[0m\u001b[31m`;
  }
  let newHl = "";
  for (let i = 0; i < newToks.length; i++) {
    if (matchedNew.has(i)) newHl += newToks[i];
    else newHl += `\u001b[1;4;32m${newToks[i]}\u001b[0m\u001b[32m`;
  }

  return [oldHl, newHl];
}

function formatToolInput(pm: ProcessedMessage): MessageCreateOptions[] {
  const input = pm.toolInput;
  const name = pm.toolName;

  if (name === "Edit" && input) {
    const filePath = String(input.file_path || "");
    const oldStr = String(input.old_string || "");
    const newStr = String(input.new_string || "");
    const lines: string[] = [`**Edit** \`${filePath}\``];
    if (oldStr || newStr) {
      lines.push("```ansi");
      const oldLines = oldStr.split("\n");
      const newLines = newStr.split("\n");
      // Find common prefix/suffix lines
      let commonStart = 0;
      while (commonStart < oldLines.length && commonStart < newLines.length && oldLines[commonStart] === newLines[commonStart]) {
        commonStart++;
      }
      let commonEnd = 0;
      while (commonEnd < oldLines.length - commonStart && commonEnd < newLines.length - commonStart && oldLines[oldLines.length - 1 - commonEnd] === newLines[newLines.length - 1 - commonEnd]) {
        commonEnd++;
      }
      const removedLines = oldLines.slice(commonStart, oldLines.length - commonEnd);
      const addedLines = newLines.slice(commonStart, newLines.length - commonEnd);
      // Context before
      for (let i = 0; i < commonStart; i++) lines.push(`  ${oldLines[i]}`);
      // Changed lines with word-level highlighting
      for (let i = 0; i < Math.max(removedLines.length, addedLines.length); i++) {
        const oldL = i < removedLines.length ? removedLines[i] : null;
        const newL = i < addedLines.length ? addedLines[i] : null;
        if (oldL !== null && newL !== null) {
          // Pair exists — highlight the changed tokens
          const [oldHl, newHl] = highlightLineDiff(oldL, newL);
          lines.push(`\u001b[31m- ${oldHl}\u001b[0m`);
          lines.push(`\u001b[32m+ ${newHl}\u001b[0m`);
        } else if (oldL !== null) {
          lines.push(`\u001b[31m- ${oldL}\u001b[0m`);
        } else if (newL !== null) {
          lines.push(`\u001b[32m+ ${newL}\u001b[0m`);
        }
      }
      // Context after
      for (let i = oldLines.length - commonEnd; i < oldLines.length; i++) lines.push(`  ${oldLines[i]}`);
      lines.push("```");
    }
    const content = lines.join("\n").slice(0, 1900);
    return [{ content }];
  }

  if (name === "Write" && input) {
    const filePath = String(input.file_path || "");
    const fileContent = String(input.content || "");
    const preview = fileContent.slice(0, 1500);
    return [{ content: `**Write** \`${filePath}\`\n\`\`\`\n${preview}${fileContent.length > 1500 ? "\n…" : ""}\n\`\`\`` }];
  }

  if (name === "Read" && input) {
    const filePath = String(input.file_path || "");
    const parts = [`**Read** \`${filePath}\``];
    if (input.offset) parts.push(`lines ${input.offset}–${Number(input.offset) + Number(input.limit || 2000)}`);
    return [{ content: parts.join(" ") }];
  }

  if (name === "Bash" && input) {
    return [{ content: `**Bash**\n\`\`\`bash\n${String(input.command || "").slice(0, 1800)}\n\`\`\`` }];
  }

  if (name === "Agent" && input) {
    const desc = String(input.description || "");
    const prompt = String(input.prompt || "").slice(0, 1500);
    return [{ content: `**Agent** ${desc}\n\`\`\`\n${prompt}${String(input.prompt || "").length > 1500 ? "\n…" : ""}\n\`\`\`` }];
  }

  if (name === "Grep" && input) {
    const parts = [`**Grep** \`${input.pattern}\``];
    if (input.path) parts.push(`in \`${input.path}\``);
    if (input.glob) parts.push(`(${input.glob})`);
    return [{ content: parts.join(" ") }];
  }

  if (name === "Glob" && input) {
    return [{ content: `**Glob** \`${input.pattern}\`` }];
  }

  return [{ content: `**${name}** ${pm.content}` }];
}

async function createToolThread(name: string): Promise<ThreadChannel> {
  return channel!.threads.create({
    name: truncate(`⏳ ${name}`, 100),
    autoArchiveDuration: 60,
  });
}

async function handlePassiveToolUse(pm: ProcessedMessage) {
  if (!channel || !pm.toolUseId) return;

  const name = pm.toolName || "Unknown";

  // Can we merge into the existing group?
  if (activePassiveGroup) {
    const g = activePassiveGroup;
    g.counts.set(name, (g.counts.get(name) || 0) + 1);
    g.toolUseIds.push(pm.toolUseId);

    const summary = passiveGroupSummary(g.counts);

    // Update thread name with loading indicator
    try { await g.thread.setName(truncate(`⏳ ${summary}`, 100)); } catch { /* best effort */ }

    // Map this tool to the shared thread
    toolUseThreads.set(pm.toolUseId, {
      thread: g.thread,
      toolName: name,
      content: summary,
    });

    // Post input in thread
    for (const msg of formatToolInput(pm)) {
      await rateLimitedSend(g.thread, msg);
    }
    return;
  }

  // Start a new group — standalone thread (not attached to a message)
  const counts = new Map<string, number>([[name, 1]]);
  const summary = passiveGroupSummary(counts);

  try {
    const thread = await createToolThread(summary);

    toolUseThreads.set(pm.toolUseId, {
      thread,
      toolName: name,
      content: summary,
    });

    activePassiveGroup = {
      thread,
      counts,
      toolUseIds: [pm.toolUseId],
    };

    for (const msg of formatToolInput(pm)) {
      await rateLimitedSend(thread, msg);
    }
  } catch (err) {
    console.error("[daemon] Failed to create passive tool thread:", err);
  }
}

async function handleToolUse(pm: ProcessedMessage) {
  if (!channel || !pm.toolUseId) return;

  try {
    const cleanContent = pm.content.replace(/`/g, "");
    const thread = await createToolThread(`${pm.toolName} — ${cleanContent}`);

    toolUseThreads.set(pm.toolUseId, {
      thread,
      toolName: pm.toolName || "Unknown",
      content: cleanContent,
    });

    // Post formatted tool input in thread
    const threadInput = formatToolInput(pm);
    for (const msg of threadInput) {
      await rateLimitedSend(thread, msg);
    }

    // Permission prompt (only if not in bypass mode)
    if (currentPermissionMode !== "bypassPermissions") {
      const toolUseId = pm.toolUseId;
      setTimeout(async () => {
        if (resolvedToolUseIds.has(toolUseId)) return;
        const entry = toolUseThreads.get(toolUseId);
        if (!entry) return;
        await rateLimitedSend(entry.thread, renderPermissionPrompt(toolUseId, entry.toolName, entry.content));
      }, 5000);
    }
  } catch (err) {
    console.error("[daemon] Failed to create thread:", err);
  }
}

async function handleToolResult(pm: ProcessedMessage) {
  if (!pm.toolUseId) return;

  resolvedToolUseIds.add(pm.toolUseId);
  const isError = pm.type === "tool-result-error";
  const entry = toolUseThreads.get(pm.toolUseId);

  if (entry) {
    // Post result in thread
    const threadMessages = renderToolResultThreadMessages(pm.content, isError);
    for (const msg of threadMessages) {
      await rateLimitedSend(entry.thread, msg);
    }

    toolUseThreads.delete(pm.toolUseId);

    // If this tool belongs to the active passive group, don't archive/edit yet
    // closePassiveGroup() handles that when the group ends
    if (activePassiveGroup && activePassiveGroup.thread.id === entry.thread.id) {
      return;
    }

    // For non-grouped tools: check if other calls share this thread
    const sameThread = [...toolUseThreads.values()].some(
      (e) => e.thread.id === entry.thread.id
    );

    if (!sameThread) {
      try {
        const icon = isError ? "❌" : "✅";
        await entry.thread.setName(truncate(`${entry.toolName} — ${entry.content} ${icon}`, 100));
      } catch { /* rate limited */ }
      try { await entry.thread.setArchived(true); } catch { /* best effort */ }
    }
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

      // Track permission mode from user messages
      if (msg.type === "user" && msg.permissionMode) {
        currentPermissionMode = msg.permissionMode;
      }

      // Rewind detection: only trigger if parentUuid is truly unknown
      // (not just different from lastMessageUuid — parallel tool calls share a parent)
      if (
        !msg.isSidechain &&
        msg.parentUuid &&
        lastMessageUuid &&
        !knownUuids.has(msg.parentUuid)
      ) {
        if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
        pendingBatch = [];
        await rateLimitedSend(channel, { content: "⏪ Conversation rewound" });
        processedUuids.clear();
        resolvedToolUseIds.clear();
        knownUuids.clear();
      }

      knownUuids.add(msg.uuid);

      // Track tool_result arrivals
      if (msg.type === "user" && msg.message && Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if (block.type === "tool_result") {
            resolvedToolUseIds.add(block.tool_use_id);
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

        enqueueBatch(pm);
      }

      lastMessageUuid = msg.uuid;
    }

    // Cap sets to prevent unbounded growth
    if (processedUuids.size > MAX_SET_SIZE) processedUuids = new Set([...processedUuids].slice(-MAX_SET_SIZE / 2));
    if (resolvedToolUseIds.size > MAX_SET_SIZE) resolvedToolUseIds = new Set([...resolvedToolUseIds].slice(-MAX_SET_SIZE / 2));
    if (knownUuids.size > MAX_SET_SIZE) knownUuids = new Set([...knownUuids].slice(-MAX_SET_SIZE / 2));
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

async function handleDiscordMessage(message: Message) {
  if (!channel || !client) return;
  if (message.author.bot) return;
  if (message.channel.id !== channel.id) return;

  const text = message.content.trim();
  if (!text) return;

  console.log(`[daemon] Discord input: ${text}`);
  discordOriginMessages.add(text);
  sendToParent({ type: "pty-write", text });
  await showThinking();
}

// ── Interaction handler ──

async function handleInteraction(interaction: import("discord.js").Interaction) {
  if (!interaction.isMessageComponent() && !interaction.isModalSubmit()) return;

  if (interaction.isButton()) {
    const id = interaction.customId;

    if (id.startsWith(ID_PREFIX.ALLOW)) {
      const toolUseId = id.slice(ID_PREFIX.ALLOW.length);
      resolvedToolUseIds.add(toolUseId);
      sendToParent({ type: "pty-write", text: "y" });
      await interaction.update({ content: "✅ Allowed", components: [] });
      return;
    }

    if (id.startsWith(ID_PREFIX.DENY)) {
      const toolUseId = id.slice(ID_PREFIX.DENY.length);
      resolvedToolUseIds.add(toolUseId);
      sendToParent({ type: "pty-write", text: "n" });
      await interaction.update({ content: "❌ Denied", components: [] });
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

// ── Hot-reload: daemon watches its own dist files and exits for restart ──

const RELOAD_EXIT_CODE = 42;

chokidar.watch(path.resolve(import.meta.dirname, "daemon.js"), { ignoreInitial: true }).on("change", () => {
  console.log("[daemon] Code changed, exiting for reload...");
  if (channel) {
    channel.send("🔄 **Reloading...**").catch(() => {}).finally(() => process.exit(RELOAD_EXIT_CODE));
  } else {
    process.exit(RELOAD_EXIT_CODE);
  }
});

// ── Cleanup ──

process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);
process.on("disconnect", cleanup);

async function cleanup() {
  if (watcher) await watcher.close();
  if (channel) {
    try { await channel.send("🔴 **Discord sync disabled**"); } catch { /* channel may be gone */ }
  }
  if (client) client.destroy();
  process.exit(0);
}
