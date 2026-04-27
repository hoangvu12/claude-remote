import { Client, GatewayIntentBits, Events, ChannelType, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, Options, type TextChannel, type MessageComponentInteraction } from "discord.js";
import chokidar, { type FSWatcher } from "chokidar";
import fs from "node:fs";
import { readFile, open } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { parseJSONLString, processAssistantBlocks, processUserBlocks, processNonConversation, walkCurrentBranch, getToolInputPreview } from "./jsonl-parser.js";
import { renderBatch, COLOR } from "./discord-renderer.js";
import { resolveJSONLPath, ID_PREFIX, CONFIG_DIR, DAEMON_PIPE_NAME, capSet, truncate, extractToolResultText, extractToolResultImages, mimeToExt, isLocalCommand, safeUnlink, createLineParser } from "./utils.js";
import type { JSONLMessage, ProcessedMessage, ContentBlock, ContentBlockToolUse, ContentBlockText, ContentBlockToolResult, DaemonToClient, ClientToDaemon, PtyWriteMessage } from "./types.js";
import { DiscordProvider } from "./providers/discord.js";
import { createPipeline } from "./create-pipeline.js";
import type { SessionContext } from "./handler.js";
import type { HandlerPipeline } from "./pipeline.js";
import { hasInput, hasThreads } from "./provider.js";
import { toolState } from "./handlers/tool-state.js";
import { closePassiveGroup } from "./handlers/passive-tools.js";
import { closeAllMcpGroups } from "./handlers/mcp-tools.js";
import { ActivityManager } from "./activity.js";
import { setupSlashCommands } from "./slash-commands.js";
import { ensureHooksInstalled } from "./install-hooks.js";

// ── Constants ──

const SESSIONS_FILE = path.join(CONFIG_DIR, "sessions.json");
const RELOAD_EXIT_CODE = 42;
const BATCH_DELAY = 600;
const KEY_DELAY = 150;
const ARROW_DOWN = "\x1b[B";
const ARROW_UP = "\x1b[A";
const ENTER = "\r";
const ESCAPE = "\x1b";
const SPACE = " ";
const TAB = "\t";
const REPLAY_FULL = 5;
const SUMMARY_TEXT_LIMIT = 10;
const MAX_SET_SIZE = 3000;
const QUESTION_TRANSITION_DELAY = 600;

// ── Multi-question types ──

interface PendingAnswer {
  keys: string[];
  label: string;
  customText?: string;
  isMultiSelect?: boolean;
  multiSelectTotalItems?: number;
  multiSelectLastTogglePos?: number;
}

interface AskQuestionState {
  totalQuestions: number;
  answers: Map<number, PendingAnswer>;
  submitMessageId: import("./provider.js").ProviderMessage | null;
}

// ── Session state ──

interface Session {
  sessionKey: string;
  sessionId: string;
  projectDir: string;
  jsonlPath: string;
  channelId: string;
  socket: net.Socket;
  provider: DiscordProvider;
  activity: ActivityManager;
  pipeline: HandlerPipeline;
  ctx: SessionContext;
  watcher: FSWatcher | null;
  lastFileSize: number;
  lastMessageUuid: string | null;
  processedUuids: Set<string>;
  knownUuids: Set<string>;
  pendingBatch: ProcessedMessage[];
  batchTimer: ReturnType<typeof setTimeout> | null;
  flushPromise: Promise<void>;
  askStates: Map<string, AskQuestionState>;
  askOptionCounts: Map<string, number>;
  lastBashOutput: Map<string, string>;
  tempFiles: Set<string>;
  slashCleanup: (() => void) | null;
}

// ── Daemon-level state ──

let discordClient: Client | null = null;
let guildId = "";
let categoryId = "";
const sessions = new Map<string, Session>();
const channelToSessionKey = new Map<string, string>();
let commandsRegistered = false;
let pipeServer: net.Server | null = null;
/**
 * Maps Claude's subagent agent_id → the spawning Task/Agent tool_use_id so
 * SubagentStop can reach the right parent thread. Populated by SubagentStart
 * signals, drained by SubagentStop. Single map across sessions is fine —
 * agent_ids are globally unique within a Claude install.
 */
const subagentParents = new Map<string, string>();

// ── Helpers ──

function sendToClient(session: Session, msg: DaemonToClient) {
  try {
    session.socket.write(JSON.stringify(msg) + "\n");
  } catch { /* socket may be gone */ }
}

function makePtyWriter(session: Session): (msg: Omit<PtyWriteMessage, "sessionKey">) => void {
  return (msg) => sendToClient(session, { ...msg, sessionKey: session.sessionKey });
}

function sendKeySequence(session: Session, keys: string[]): number {
  const write = makePtyWriter(session);
  keys.forEach((key, i) => {
    setTimeout(() => write({ type: "pty-write", text: key, raw: true }), i * KEY_DELAY);
  });
  return keys.length * KEY_DELAY;
}

// ── Session ↔ Channel mapping ──

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

// ── Multi-question helpers (per-session) ──

function initAskState(session: Session, toolUseId: string, questions: NonNullable<ProcessedMessage["questions"]>) {
  questions.forEach((q, idx) => {
    session.askOptionCounts.set(`${toolUseId}:${idx}`, q.options.length + 1);
  });
  if (questions.length <= 1) return;
  session.askStates.set(toolUseId, {
    totalQuestions: questions.length,
    answers: new Map(),
    submitMessageId: null,
  });
}

function storeAskAnswer(session: Session, toolUseId: string, questionIndex: number, answer: PendingAnswer) {
  const state = session.askStates.get(toolUseId);
  if (!state) return;
  state.answers.set(questionIndex, answer);
  showOrUpdateSubmitMessage(session, toolUseId);
}

async function showOrUpdateSubmitMessage(session: Session, toolUseId: string) {
  const state = session.askStates.get(toolUseId);
  if (!state) return;

  const allAnswered = state.answers.size >= state.totalQuestions;
  const summary = Array.from({ length: state.totalQuestions }, (_, i) => {
    const a = state.answers.get(i);
    return a ? `${i + 1}. ${a.label}` : `${i + 1}. *(unanswered)*`;
  }).join("\n");

  const msg: import("./provider.js").OutgoingMessage = {
    embed: {
      title: allAnswered ? "Ready to submit?" : `Answers (${state.answers.size}/${state.totalQuestions})`,
      description: summary,
      color: COLOR.QUESTION,
    },
    actions: allAnswered
      ? [
          { id: `${ID_PREFIX.ASK_SUBMIT}${toolUseId}`, label: "Submit answers", style: "success" as const },
          { id: `${ID_PREFIX.ASK_SUBMIT}${toolUseId}:cancel`, label: "Cancel", style: "danger" as const },
        ]
      : undefined,
  };

  if (state.submitMessageId) {
    try {
      await session.provider.edit(state.submitMessageId, msg);
    } catch {
      state.submitMessageId = await session.provider.send(msg);
    }
  } else {
    state.submitMessageId = await session.provider.send(msg);
  }
}

function submitAskAnswers(session: Session, toolUseId: string) {
  const state = session.askStates.get(toolUseId);
  if (!state) return;
  const write = makePtyWriter(session);

  let queueIndex = 0;
  const sendNext = () => {
    if (queueIndex >= state.totalQuestions) {
      setTimeout(() => sendKeySequence(session, [ENTER]), QUESTION_TRANSITION_DELAY);
      session.askStates.delete(toolUseId);
      return;
    }
    const answer = state.answers.get(queueIndex);
    queueIndex++;
    if (!answer) { sendNext(); return; }

    let keysDelay: number;
    if (answer.customText != null) {
      // "Other" is always the last option (upstream auto-appends an input-
      // type "__other__" entry). Focus it via ARROW_UP (wraps from first)
      // so the TextInput is focused before we type — otherwise the letters
      // land on the Select component, which ignores non-digits.
      write({ type: "pty-write", text: ARROW_UP, raw: true });
      setTimeout(() => write({ type: "pty-write", text: answer.customText! }), KEY_DELAY);
      setTimeout(() => write({ type: "pty-write", text: ENTER, raw: true }), KEY_DELAY * 2);
      keysDelay = KEY_DELAY * 3;
    } else if (answer.isMultiSelect) {
      const toggleKeys = answer.keys;
      const cursorPos = answer.multiSelectLastTogglePos ?? 0;
      const totalItems = answer.multiSelectTotalItems ?? 1;
      const tabsNeeded = (totalItems - 1 - cursorPos) + 1;
      const submitKeys = [...toggleKeys];
      for (let t = 0; t < tabsNeeded; t++) submitKeys.push(TAB);
      submitKeys.push(ENTER);
      keysDelay = sendKeySequence(session, submitKeys);
    } else {
      keysDelay = sendKeySequence(session, answer.keys);
    }
    setTimeout(sendNext, keysDelay + QUESTION_TRANSITION_DELAY);
  };
  sendNext();
}

// ── JSONL message processing ──

function getProcessedMessages(msg: JSONLMessage): ProcessedMessage[] {
  if (msg.type === "assistant") return processAssistantBlocks(msg);
  if (msg.type === "user") return processUserBlocks(msg);
  const single = processNonConversation(msg);
  return single ? [single] : [];
}

function dedupKey(pm: ProcessedMessage): string {
  return pm.uuid + pm.type + (pm.toolUseId || "");
}

// ── Batch processing (per-session) ──

function enqueueBatch(session: Session, pm: ProcessedMessage) {
  session.pendingBatch.push(pm);
  if (pm.type === "user-prompt" || pm.type === "assistant-text") {
    if (session.batchTimer) { clearTimeout(session.batchTimer); session.batchTimer = null; }
    flushBatch(session);
    return;
  }
  if (session.batchTimer) clearTimeout(session.batchTimer);
  session.batchTimer = setTimeout(() => flushBatch(session), BATCH_DELAY);
}

function flushBatch(session: Session) {
  session.batchTimer = null;
  if (session.pendingBatch.length === 0) return;
  session.flushPromise = session.flushPromise.then(() => _flushBatch(session)).catch((err) => {
    console.error("[daemon] Flush error:", err);
  });
}

async function _flushBatch(session: Session) {
  if (session.pendingBatch.length === 0) return;
  const batch = session.pendingBatch;
  session.pendingBatch = [];

  for (const pm of batch) {
    try {
      if (pm.type === "ask-user-question" && pm.questions && pm.toolUseId) {
        initAskState(session, pm.toolUseId, pm.questions);
      }
      await session.pipeline.process(pm, session.ctx);
    } catch (err) {
      console.error(`[daemon] Error processing ${pm.type}:`, err);
    }
  }
}

// ── JSONL File watcher (per-session) ──

function startWatcher(session: Session) {
  // Claude Code drains JSONL writes every ~100ms during a live turn (and 10ms
  // when remote ingress is on). With awaitWriteFinish.stabilityThreshold>=100
  // chokidar would keep deferring the `change` event until the assistant goes
  // idle, so messages stop reaching Discord mid-turn. We don't need stability
  // protection here — handleFileChange already guards against partial lines
  // by trimming to the last \n before parsing — so disable awaitWriteFinish
  // and use a low-latency poll on Windows where ReadDirectoryChangesW can
  // miss appends to a single file.
  session.watcher = chokidar.watch(session.jsonlPath, {
    persistent: true,
    usePolling: process.platform === "win32",
    interval: 100,
  });
  session.watcher.on("change", (p) => handleFileChange(session, p));
  session.watcher.on("error", (err: unknown) => console.error("[daemon] Watcher error:", err));
  console.log(`[daemon] Watching JSONL: ${session.jsonlPath}`);
}

async function handleFileChange(session: Session, filePath: string) {
  const { ctx, activity } = session;

  try {
    const fd = await open(filePath, "r");
    const stat = await fd.stat();
    const newSize = stat.size;

    if (newSize < session.lastFileSize) {
      console.log(`[daemon] File shrank (${session.lastFileSize} → ${newSize}), resetting offset`);
      session.lastFileSize = newSize;
      await fd.close();
      return;
    }
    if (newSize === session.lastFileSize) { await fd.close(); return; }

    const buf = Buffer.alloc(newSize - session.lastFileSize);
    await fd.read(buf, 0, buf.length, session.lastFileSize);
    await fd.close();

    const lastNL = buf.lastIndexOf(0x0A);
    if (lastNL === -1) return;
    const completeBytes = lastNL + 1;
    session.lastFileSize += completeBytes;

    const newLines = buf.subarray(0, completeBytes).toString("utf-8").split("\n").filter(Boolean);
    let rewindHandled = false;

    for (const line of newLines) {
      let msg: JSONLMessage;
      try { msg = JSON.parse(line) as JSONLMessage; } catch { continue; }

      if (msg.type === "user" && msg.permissionMode) {
        ctx.permissionMode = msg.permissionMode;
      }

      if (msg.type === "assistant" && msg.message?.model === "<synthetic>") {
        session.knownUuids.add(msg.uuid);
        session.lastMessageUuid = msg.uuid;
        continue;
      }

      if (msg.type === "user" && msg.message && Array.isArray(msg.message.content)) {
        const isInterrupt = (msg.message.content as ContentBlock[]).some(
          (b) => b.type === "text" && (b as ContentBlockText).text.startsWith("[Request interrupted by user"),
        );
        if (isInterrupt && activity) {
          if (session.batchTimer) { clearTimeout(session.batchTimer); session.batchTimer = null; }
          session.pendingBatch = [];
          activity.stopOverrideUntil = Date.now() + 3000;
          activity.transitionToIdle(3500);
          await ctx.provider.send({ text: "⏹️ **Interrupted** from CLI" });
          session.knownUuids.add(msg.uuid);
          session.lastMessageUuid = msg.uuid;
          continue;
        }
      }

      if (activity?.busy) activity.resetIdleTimer();

      if (activity && Date.now() >= activity.stopOverrideUntil) {
        // API-error rendering is now driven by the StopFailure hook
        // (handleStateSignal "stop-failure"), which carries the structured
        // error code + detail. The legacy `msg.isApiErrorMessage` cast lives
        // on for transcripts written before the hook was installed; the
        // synthetic-model branch above already swallows those, so no extra
        // handling is needed here.
        if (msg.type === "assistant" && msg.message && Array.isArray(msg.message.content)) {
          const blocks = msg.message.content as ContentBlock[];
          const hasToolUse = blocks.some((b) => b.type === "tool_use");
          if (hasToolUse) {
            activity.update("working");
          } else if (blocks.some((b) => b.type === "text")) {
            if (msg.message!.stop_reason === "max_tokens") {
              await ctx.provider.send({
                embed: { description: "⚠️ **Response hit token limit** — output was truncated", color: COLOR.ERROR_RED },
              });
            }
            activity.transitionToIdle();
          }
        } else if (msg.type === "user" && msg.message && !activity.busy) {
          const content = msg.message.content;
          const firstText = Array.isArray(content)
            ? (content as ContentBlock[]).find((b) => b.type === "text") as ContentBlockText | undefined
            : undefined;
          const text = typeof content === "string" ? content : firstText?.text || "";
          if (!isLocalCommand(text)) {
            activity.busy = true;
            activity.resetIdleTimer();
            activity.update("thinking");
          }
        }
      }

      if (msg.type === "system") {
        if (msg.subtype === "api_error") {
          const cause = (msg as unknown as Record<string, unknown>).cause as Record<string, unknown> | undefined;
          const detail = cause?.message ? String(cause.message) : cause?.code ? String(cause.code) : "unknown error";
          await ctx.provider.send({
            embed: { description: `⚠️ **API error**: ${detail}`, color: COLOR.ERROR_RED },
          });
          if (activity) activity.transitionToIdle();
        } else if (msg.subtype === "compact_boundary") {
          await ctx.provider.send({ text: "🗜️ **Context compacted**" });
        }
        session.knownUuids.add(msg.uuid);
        session.lastMessageUuid = msg.uuid;
        continue;
      }

      if (msg.type === "rate_limit_event") {
        const info = (msg as unknown as Record<string, unknown>).rate_limit_info as
          { status?: string; resetsAt?: number; utilization?: number } | undefined;
        if (info?.status === "rejected") {
          const resetsIn = info.resetsAt ? Math.max(0, Math.ceil((info.resetsAt - Date.now()) / 1000)) : null;
          const detail = resetsIn != null ? ` Resets in ${resetsIn}s` : "";
          await ctx.provider.send({
            embed: { description: `🚫 **Rate limited**${detail}`, color: COLOR.ERROR_RED },
          });
        } else if (info?.status === "allowed_warning") {
          const pct = info.utilization != null ? ` (${Math.round(info.utilization * 100)}% used)` : "";
          await ctx.provider.send({
            embed: { description: `⚠️ **Approaching rate limit**${pct}`, color: 0xf5a623 },
          });
        }
        continue;
      }

      if (msg.type === "auth_status") {
        const authMsg = msg as unknown as { isAuthenticating?: boolean; error?: string };
        if (authMsg.error) {
          await ctx.provider.send({
            embed: { description: `🔑 **Auth error**: ${authMsg.error}`, color: COLOR.ERROR_RED },
          });
        }
        continue;
      }

      if (msg.type === "result") {
        const result = msg as unknown as { subtype?: string; errors?: string[]; stop_reason?: string | null };
        if (result.subtype && result.subtype !== "success") {
          const labels: Record<string, string> = {
            error_max_turns: "Max turns reached",
            error_during_execution: "Error during execution",
            error_max_budget_usd: "Budget limit reached",
            error_max_structured_output_retries: "Structured output failed",
          };
          const label = labels[result.subtype] || result.subtype;
          const detail = result.errors?.length ? `: ${result.errors[0]}` : "";
          await ctx.provider.send({
            embed: { description: `🛑 **${label}**${truncate(detail, 200)}`, color: COLOR.ERROR_RED },
          });
        }
        if (activity) activity.transitionToIdle();
        continue;
      }

      if (msg.type === "progress" && msg.parentToolUseID) {
        const progressType = msg.data?.type as string | undefined;
        if (progressType === "agent_progress") {
          await forwardAgentProgress(session, msg);
        } else if (progressType === "bash_progress") {
          await forwardBashProgress(session, msg);
        } else if (progressType === "mcp_progress") {
          await forwardMcpProgress(session, msg);
        }
      }

      if (
        !rewindHandled &&
        !msg.isSidechain &&
        !msg.parentToolUseID &&
        (msg.type === "assistant" || msg.type === "user") &&
        msg.parentUuid &&
        session.lastMessageUuid &&
        !session.knownUuids.has(msg.parentUuid)
      ) {
        rewindHandled = true;
        if (session.batchTimer) { clearTimeout(session.batchTimer); session.batchTimer = null; }
        session.pendingBatch = [];
        await ctx.provider.send({ text: "⏪ Conversation rewound" });
        session.processedUuids.clear();
        ctx.resolvedToolUseIds.clear();
        session.knownUuids.clear();
      }

      session.knownUuids.add(msg.uuid);

      if (msg.type === "user" && msg.message && Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if (block.type === "tool_result") {
            ctx.resolvedToolUseIds.add(block.tool_use_id);
            session.lastBashOutput.delete(block.tool_use_id);
          }
        }
      }

      for (const pm of getProcessedMessages(msg)) {
        const key = dedupKey(pm);
        if (session.processedUuids.has(key)) continue;
        session.processedUuids.add(key);
        if (pm.type === "user-prompt" && ctx.originMessages.has(pm.content.trim())) {
          ctx.originMessages.delete(pm.content.trim());
          continue;
        }
        enqueueBatch(session, pm);
      }

      session.lastMessageUuid = msg.uuid;
    }

    capSet(session.processedUuids, MAX_SET_SIZE);
    capSet(ctx.resolvedToolUseIds, MAX_SET_SIZE);
    capSet(session.knownUuids, MAX_SET_SIZE);
    capSet(toolState.taskToolUseIds, MAX_SET_SIZE);
  } catch (err) {
    console.error("[daemon] Error reading JSONL changes:", err);
  }
}

// ── Progress forwarding (per-session) ──

function getProgressThread(session: Session, parentToolUseID: string) {
  const entry = toolState.toolUseThreads.get(parentToolUseID);
  if (!entry?.thread || !hasThreads(session.ctx.provider)) return null;
  return {
    entry: entry as import("./handlers/tool-state.js").ToolEntry & { thread: import("./provider.js").ProviderThread },
    provider: session.ctx.provider as import("./provider.js").OutputProvider & import("./provider.js").ThreadCapable,
  };
}

async function forwardAgentProgress(session: Session, msg: JSONLMessage) {
  const result = getProgressThread(session, msg.parentToolUseID!);
  if (!result) return;
  const { entry: parentEntry, provider } = result;

  const innerMsg = msg.data!.message as { type: string; message?: { role: string; content: ContentBlock[] | string } } | undefined;
  if (!innerMsg?.message) return;

  const content = innerMsg.message.content;
  if (innerMsg.type === "assistant" && Array.isArray(content)) {
    for (const block of content as ContentBlock[]) {
      if (block.type === "tool_use") {
        const tb = block as ContentBlockToolUse;
        const preview = getToolInputPreview(tb.name, tb.input);
        await provider.sendToThread(parentEntry.thread, {
          embed: { description: `🔧 **${tb.name}** ${preview}`, color: COLOR.TOOL },
        });
      } else if (block.type === "text" && (block as ContentBlockText).text.trim()) {
        await provider.sendToThread(parentEntry.thread, {
          text: truncate((block as ContentBlockText).text.trim(), 1900),
        });
      }
    }
  } else if (innerMsg.type === "user" && Array.isArray(content)) {
    for (const block of content as ContentBlock[]) {
      if (block.type === "tool_result") {
        const tb = block as ContentBlockToolResult;
        const resultText = extractToolResultText(tb.content).trim();
        const images = extractToolResultImages(tb.content as Parameters<typeof extractToolResultImages>[0]);
        const isError = !!tb.is_error;
        const icon = isError ? "❌" : "✅";
        if (resultText && resultText !== "undefined") {
          await provider.sendToThread(parentEntry.thread, {
            text: `${icon}\n\`\`\`\n${truncate(resultText, 1800)}\n\`\`\``,
          });
        } else {
          await provider.sendToThread(parentEntry.thread, {
            text: `${icon} *(no output)*`,
          });
        }
        if (images.length > 0) {
          for (let i = 0; i < images.length; i++) {
            const img = images[i];
            const ext = mimeToExt(img.mediaType);
            const buf = Buffer.from(img.data, "base64");
            if (buf.length > 8 * 1024 * 1024) continue;
            await provider.sendToThread(parentEntry.thread, {
              files: [{ name: `image-${i + 1}.${ext}`, data: buf }],
            });
          }
        }
      }
    }
  }
}

async function forwardBashProgress(session: Session, msg: JSONLMessage) {
  const result = getProgressThread(session, msg.parentToolUseID!);
  if (!result) return;
  const data = msg.data as { output?: string; elapsedTimeSeconds?: number } | undefined;
  if (!data?.output?.trim()) return;
  const prev = session.lastBashOutput.get(msg.parentToolUseID!);
  if (prev === data.output) return;
  session.lastBashOutput.set(msg.parentToolUseID!, data.output);
  await result.provider.sendToThread(result.entry.thread, {
    text: `\`\`\`\n${truncate(data.output.trim(), 1800)}\n\`\`\``,
  });
}

async function forwardMcpProgress(session: Session, msg: JSONLMessage) {
  const result = getProgressThread(session, msg.parentToolUseID!);
  if (!result) return;
  const data = msg.data as { status?: string; serverName?: string; toolName?: string; elapsedTimeMs?: number } | undefined;
  if (!data?.status) return;
  if (data.status === "completed" && data.elapsedTimeMs != null) {
    const secs = (data.elapsedTimeMs / 1000).toFixed(1);
    await result.provider.sendToThread(result.entry.thread, {
      text: `✅ MCP \`${data.serverName}\` completed in ${secs}s`,
    });
  }
}

// ── Replay history (per-session) ──

async function replayHistory(session: Session) {
  const { ctx, provider } = session;
  await provider.cleanupThreads();

  try {
    const raw = await readFile(session.jsonlPath, "utf-8");
    session.lastFileSize = Buffer.byteLength(raw, "utf-8");
    const allMessages = parseJSONLString(raw);
    const branch = walkCurrentBranch(allMessages);

    for (const msg of branch) {
      if (msg.type === "user" && msg.permissionMode) {
        ctx.permissionMode = msg.permissionMode;
      }
    }

    const allProcessed: ProcessedMessage[] = [];
    for (const msg of branch) {
      session.knownUuids.add(msg.uuid);
      for (const pm of getProcessedMessages(msg)) {
        session.processedUuids.add(dedupKey(pm));
        allProcessed.push(pm);
      }
      session.lastMessageUuid = msg.uuid;
    }

    if (allProcessed.length === 0) return;

    const splitAt = Math.max(0, allProcessed.length - REPLAY_FULL);
    const older = allProcessed.slice(0, splitAt);
    const recent = allProcessed.slice(splitAt);

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
        } else if (pm.type === "tool-use-group") {
          toolCount += pm.toolUseIds?.length ?? 1;
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
        embed: { title: "📜 Conversation history", description: lines.join("\n").slice(0, 4000), color: 0x2c2f33 },
      });
    }

    const answeredToolUseIds = new Set(
      allProcessed.filter((p) => p.type === "tool-result" || p.type === "tool-result-error")
        .map((p) => p.toolUseId).filter(Boolean),
    );
    for (const pm of recent) {
      if (pm.type === "ask-user-question" && pm.questions
          && pm.toolUseId && !answeredToolUseIds.has(pm.toolUseId)) {
        initAskState(session, pm.toolUseId, pm.questions);
      }
    }

    for (const msg of renderBatch(recent)) {
      await provider.send(msg);
    }
    console.log(`[daemon] Replayed: ${older.length} summarized, ${recent.length} full`);
  } catch (err) {
    console.log("[daemon] No existing JSONL to replay (or error):", err);
  }
}

// ── Wire up Discord input/interactions for a session ──

function wireDiscordInput(session: Session) {
  const { provider, activity, ctx } = session;
  const write = makePtyWriter(session);

  if (hasInput(provider)) {
    provider.onUserMessage(async (text, attachments) => {
      console.log(`[daemon] Discord input [${session.sessionKey}]: ${text}${attachments ? ` (+${attachments.length} images)` : ""}`);

      let finalText = text;
      if (attachments?.length) {
        const paths: string[] = [];
        for (const att of attachments) {
          try {
            const resp = await fetch(att.url);
            const buf = Buffer.from(await resp.arrayBuffer());
            const ext = att.filename.split(".").pop() || "png";
            const tmpPath = path.join(os.tmpdir(), `claude-remote-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
            fs.writeFileSync(tmpPath, buf);
            // Surface zero-byte / unreadable downloads in the log — Claude Code's
            // tryReadImageFromPath silently returns null on a 0-byte file and
            // the image attachment is dropped without warning.
            const size = fs.statSync(tmpPath).size;
            console.log(`[daemon] Saved image ${att.filename} → ${tmpPath} (${size} bytes)`);
            if (size === 0) {
              console.error(`[daemon] WARNING: ${tmpPath} is empty — Claude will drop this attachment`);
            }
            session.tempFiles.add(tmpPath);
            paths.push(tmpPath);
          } catch (err) {
            console.error("[daemon] Failed to download attachment:", err);
          }
        }
        if (paths.length > 0) {
          // Each path on its own line with native separators so Claude Code's
          // paste handler (imagePaste.ts) recognizes them as absolute image
          // paths and attaches the real image instead of treating the whole
          // line as a failed path. On Windows, stripBackslashEscapes is a
          // no-op — don't replace backslashes with forward slashes.
          const pathList = paths.join("\n");
          finalText = finalText
            ? `${finalText}\n${pathList}`
            : `Please look at this image:\n${pathList}`;
        }
      }

      if (!finalText) return;

      if (activity.busy) {
        const msg = activity.enqueue(finalText);
        provider.send({
          embed: { description: `📥 Queued #${msg.id} (${activity.queue.length} in queue)\n>>> ${text.slice(0, 200)}`, color: COLOR.BLURPLE },
        });
        activity.update(activity.state, discordClient!);
        return;
      }
      activity.busy = true;
      activity.resetIdleTimer();
      ctx.originMessages.add(finalText);
      write({ type: "pty-write", text: finalText });
      activity.update("thinking", discordClient!);
    });

    provider.onInteraction((interaction) => {
      const id = interaction.customId;

      if (id.startsWith(ID_PREFIX.ALLOW)) {
        const toolUseId = id.slice(ID_PREFIX.ALLOW.length);
        ctx.resolvedToolUseIds.add(toolUseId);
        // Prefer the PermissionRequest hook channel when a subprocess is
        // waiting — that returns a structured allow decision and bypasses the
        // dialog entirely. Fall through to ENTER only when no hook is active
        // (older Claude, hook misregistered, or click beat the hook).
        if (!resolvePermissionViaHook(toolUseId, { behavior: "allow" })) {
          sendKeySequence(session, [ENTER]);
        }
        provider.respond(interaction, { text: "✅ Allowed" });
        return;
      }

      if (id.startsWith(ID_PREFIX.DENY)) {
        const toolUseId = id.slice(ID_PREFIX.DENY.length);
        ctx.resolvedToolUseIds.add(toolUseId);
        // Hook channel returns a deterministic deny; the keyboard-sim fallback
        // sends Escape which triggers PermissionPrompt's handleCancel → onReject
        // (equivalent to "No" regardless of how many options the dialog shows).
        // Arrow-down+Enter was index 1, which in the 3-option dialog
        // ([Yes, Yes-dont-ask-again, No] when showAlwaysAllowOptions=true) picks
        // "Yes, don't ask again" — the opposite of Deny.
        if (!resolvePermissionViaHook(toolUseId, { behavior: "deny", message: "Denied via Discord" })) {
          sendKeySequence(session, [ESCAPE]);
        }
        provider.respond(interaction, { text: "❌ Denied" });
        return;
      }

      if (id.startsWith(ID_PREFIX.PLAN_FEEDBACK)) {
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
        write({ type: "pty-write", text: optionNum, raw: true });
        provider.respond(interaction, {
          embed: { description: `📐 ${labels[optionNum] || "Plan approved"}`, color: 0x43b581 },
        });
        return;
      }

      if (interaction.type === "button" && id.startsWith(ID_PREFIX.ASK_SUBMIT)) {
        const isCancel = id.endsWith(":cancel");
        const toolUseId = isCancel
          ? id.slice(ID_PREFIX.ASK_SUBMIT.length, -":cancel".length)
          : id.slice(ID_PREFIX.ASK_SUBMIT.length);
        if (isCancel) {
          write({ type: "pty-write", text: "\x1b", raw: true });
          session.askStates.delete(toolUseId);
          provider.respond(interaction, { text: "❌ Cancelled" });
        } else {
          const state = session.askStates.get(toolUseId);
          if (state && state.answers.size >= state.totalQuestions) {
            submitAskAnswers(session, toolUseId);
            provider.respond(interaction, { text: "✅ Submitting answers..." });
          } else {
            provider.respond(interaction, { text: "⚠️ Not all questions answered yet" });
          }
        }
        return;
      }

      if (interaction.type === "button" && id.startsWith(ID_PREFIX.ASK) && interaction.values?.[0]) {
        const parts = id.split(":");
        const toolUseId = parts[1];
        const questionIndex = parseInt(parts[2], 10);
        const optionIndex = parseInt(parts[3], 10);
        const label = parts.slice(4).join(":");
        const keys: string[] = [];
        for (let i = 0; i < optionIndex; i++) keys.push(ARROW_DOWN);
        keys.push(ENTER);

        const state = session.askStates.get(toolUseId);
        if (state) {
          const existed = state.answers.has(questionIndex);
          storeAskAnswer(session, toolUseId, questionIndex, { keys, label });
          provider.respond(interaction, {
            text: existed
              ? `Changed to: **${label}** (${state.answers.size}/${state.totalQuestions})`
              : `Selected: **${label}** (${state.answers.size}/${state.totalQuestions})`,
          });
        } else {
          sendKeySequence(session, keys);
          provider.respond(interaction, { text: `Selected: **${label}**` });
        }
        return;
      }

      if (interaction.type === "select" && interaction.values?.length) {
        const menuParts = interaction.customId.split(":");
        const toolUseId = menuParts[1];
        const questionIndex = parseInt(menuParts[2], 10);
        const indices = interaction.values
          .map((v) => parseInt(v.split(":")[0], 10))
          .sort((a, b) => a - b);
        const keys: string[] = [];
        let pos = 0;
        for (const idx of indices) {
          for (let i = pos; i < idx; i++) keys.push(ARROW_DOWN);
          keys.push(SPACE);
          pos = idx;
        }
        const label = interaction.text || "selected";
        const totalItems = (interaction.values.length > 0
          ? Math.max(...interaction.values.map((v) => parseInt(v.split(":")[0], 10))) + 2
          : 2);
        const optionCount = session.askOptionCounts.get(`${toolUseId}:${questionIndex}`) ?? totalItems;

        const state = session.askStates.get(toolUseId);
        if (state) {
          const existed = state.answers.has(questionIndex);
          storeAskAnswer(session, toolUseId, questionIndex, {
            keys, label, isMultiSelect: true,
            multiSelectTotalItems: optionCount,
            multiSelectLastTogglePos: indices[indices.length - 1],
          });
          provider.respond(interaction, {
            text: existed
              ? `Changed to: **${label}** (${state.answers.size}/${state.totalQuestions})`
              : `Selected: **${label}** (${state.answers.size}/${state.totalQuestions})`,
          });
        } else {
          const tabsNeeded = (optionCount - 1 - (indices[indices.length - 1] ?? 0)) + 1;
          for (let t = 0; t < tabsNeeded; t++) keys.push(TAB);
          keys.push(ENTER);
          sendKeySequence(session, keys);
          provider.respond(interaction, { text: `Selected: **${label}**` });
        }
        return;
      }

      if (interaction.type === "modal-submit") {
        if (id.startsWith(ID_PREFIX.QUEUE_EDIT) || id.startsWith(`${ID_PREFIX.MODAL}${ID_PREFIX.QUEUE_EDIT}`)) {
          const prefix = id.startsWith(ID_PREFIX.QUEUE_EDIT) ? ID_PREFIX.QUEUE_EDIT : `${ID_PREFIX.MODAL}${ID_PREFIX.QUEUE_EDIT}`;
          const queueId = parseInt(id.slice(prefix.length));
          const item = activity.findInQueue(queueId);
          if (item && interaction.text) {
            item.text = interaction.text;
            provider.respond(interaction, { text: `✏️ Queue #${queueId} updated` });
          }
          return;
        }

        if (id.includes(ID_PREFIX.PLAN_FEEDBACK)) {
          const feedback = interaction.text?.trim();
          if (feedback) {
            // "No, keep planning" is always the last option in the plan-
            // approval dialog. Its digit isn't fixed — buildPlanApprovalOptions
            // conditionally adds/removes slots based on showClearContext,
            // showUltraplan, auto-mode, and bypass-permissions. ARROW_UP
            // wraps from the first option to the last (Select wraps when
            // onUpFromFirstItem isn't set, which it isn't for plan mode),
            // reliably focusing the input option regardless of layout.
            write({ type: "pty-write", text: ARROW_UP, raw: true });
            setTimeout(() => write({ type: "pty-write", text: feedback }), KEY_DELAY);
            setTimeout(() => write({ type: "pty-write", text: ENTER, raw: true }), KEY_DELAY * 2);
            provider.respond(interaction, {
              embed: { description: `📐 Keep planning: ${feedback}`, color: 0xf5a623 },
            });
          } else {
            write({ type: "pty-write", text: ESCAPE, raw: true });
            provider.respond(interaction, {
              embed: { description: "📐 Staying in plan mode", color: 0xf5a623 },
            });
          }
          return;
        }

        if (interaction.text && id.includes(ID_PREFIX.ASK_OTHER)) {
          const otherParts = id.split(":");
          const toolUseId = otherParts[2];
          const questionIndex = parseInt(otherParts[3], 10);
          const text = interaction.text;

          const state = session.askStates.get(toolUseId);
          if (state && !isNaN(questionIndex)) {
            const existed = state.answers.has(questionIndex);
            storeAskAnswer(session, toolUseId, questionIndex, { keys: [], label: text, customText: text });
            provider.respond(interaction, {
              text: existed
                ? `Changed to: **${text}** (${state.answers.size}/${state.totalQuestions})`
                : `Answered: **${text}** (${state.answers.size}/${state.totalQuestions})`,
            });
          } else {
            // Single-question "Other": focus the auto-added last input option
            // via ARROW_UP (wraps from first), then type, then Enter.
            write({ type: "pty-write", text: ARROW_UP, raw: true });
            setTimeout(() => write({ type: "pty-write", text }), KEY_DELAY);
            setTimeout(() => write({ type: "pty-write", text: ENTER, raw: true }), KEY_DELAY * 2);
            provider.respond(interaction, { text: `Answered: **${text}**` });
          }
          return;
        }

        if (interaction.text) {
          write({ type: "pty-write", text: interaction.text });
          provider.respond(interaction, { text: `Answered: **${interaction.text}**` });
        }
      }
    });
  }
}

// ── Session lifecycle ──

async function createSession(msg: ClientToDaemon & { type: "session-info" }, socket: net.Socket): Promise<void> {
  if (!discordClient) return;

  const { sessionKey, sessionId, projectDir } = msg;
  const jsonlPath = msg.transcriptPath || resolveJSONLPath(sessionId, projectDir);
  const reuseChannelId = msg.reuseChannelId;
  const initialPermissionMode = msg.initialPermissionMode || "default";
  const customChannelName = msg.channelName;
  const sessionSource = msg.sessionSource;

  console.log(`[daemon] Creating session ${sessionKey} (session ${sessionId}, source=${sessionSource || "unknown"})`);

  const guild = await discordClient.guilds.fetch(guildId);

  // Resolve or create channel
  let channel: TextChannel | null = null;
  let isContextClear = false;
  const savedChannelId = reuseChannelId || loadSessionChannel(sessionId);
  if (savedChannelId) {
    try {
      const existing = await guild.channels.fetch(savedChannelId);
      if (existing && existing.type === ChannelType.GuildText) {
        channel = existing as TextChannel;
        isContextClear = !!reuseChannelId;
      }
    } catch { /* channel deleted */ }
  }

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
    channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: categoryId,
      topic: `Claude Code session · ${projectDir} · ${sessionId.slice(0, 8)}`,
    }) as TextChannel;
    console.log(`[daemon] Created channel: #${channel.name}`);
  }

  saveSessionChannel(sessionId, channel.id);

  // Evict old session on the same channel
  const oldSessionKey = channelToSessionKey.get(channel.id);
  if (oldSessionKey && oldSessionKey !== sessionKey) {
    const oldSession = sessions.get(oldSessionKey);
    if (oldSession) {
      console.log(`[daemon] Evicting old session ${oldSessionKey} from channel #${channel.name}`);
      await cleanupSession(oldSessionKey);
    }
  }
  channelToSessionKey.set(channel.id, sessionKey);

  // Create session object — writer callbacks use lazy `sessions.get` so
  // sendToClient/makePtyWriter work correctly after session is registered
  const provider = new DiscordProvider(discordClient, channel);
  const write = makePtyWriter({ sessionKey, socket } as Session);
  const activity = new ActivityManager(provider, write);
  const pipeline = createPipeline();

  const ctx: SessionContext = {
    sessionId,
    projectDir,
    provider,
    permissionMode: initialPermissionMode,
    bypassAvailable: initialPermissionMode === "bypassPermissions",
    sessionSource,
    resolvedToolUseIds: new Set<string>(),
    originMessages: new Set<string>(),
    sendToPty: (text: string) => write({ type: "pty-write", text }),
  };

  const session: Session = {
    sessionKey, sessionId, projectDir, jsonlPath,
    channelId: channel.id, socket, provider, activity, pipeline, ctx,
    watcher: null, lastFileSize: 0, lastMessageUuid: null,
    processedUuids: new Set(), knownUuids: new Set(),
    pendingBatch: [], batchTimer: null, flushPromise: Promise.resolve(),
    askStates: new Map(), askOptionCounts: new Map(),
    lastBashOutput: new Map(), tempFiles: new Set(),
    slashCleanup: null,
  };

  sessions.set(sessionKey, session);

  activity.setContext(ctx);
  activity.onIdle(() => {
    session.flushPromise = session.flushPromise.then(async () => {
      await closePassiveGroup(ctx);
      await closeAllMcpGroups(ctx);
    }).catch(() => {});
  });

  pipeline.init(ctx);

  // Setup slash commands (register only once)
  session.slashCleanup = await setupSlashCommands(discordClient, guildId, {
    getCtx: () => session.ctx,
    activity,
    sendToClient: write,
    restart: () => sendToClient(session, { type: "restart", sessionKey }),
    provider,
    projectDir,
    sessionId,
    channelId: channel.id,
  }, commandsRegistered);
  commandsRegistered = true;

  wireDiscordInput(session);

  if (sessionSource === "resume" && !isContextClear) {
    await provider.send({ text: `↩️ **Resumed session** \`${sessionId.slice(0, 8)}\`` });
  } else if (isContextClear || sessionSource === "clear") {
    await provider.send({ text: "🧹 **Context cleared** — new conversation started" });
  } else if (sessionSource === "compact") {
    await provider.send({ text: "🗜️ **New context window** — post-compact" });
  } else if (!savedChannelId) {
    await provider.send({ text: `🟢 **Discord sync enabled**\n📁 \`${projectDir}\`\n🆔 \`${sessionId.slice(0, 8)}\`` });
  } else {
    await provider.send({ text: "🟢 **Discord sync reconnected**" });
  }

  sendToClient(session, { type: "daemon-ready", sessionKey, channelId: channel.id });
  activity.update("idle", discordClient);

  await replayHistory(session);
  startWatcher(session);
}

async function cleanupSession(sessionKey: string) {
  const session = sessions.get(sessionKey);
  if (!session) return;

  console.log(`[daemon] Cleaning up session ${sessionKey}`);

  if (session.batchTimer) { clearTimeout(session.batchTimer); session.batchTimer = null; }
  if (session.slashCleanup) session.slashCleanup();
  session.activity.destroy();
  session.pipeline.destroy();
  if (session.watcher) await session.watcher.close();

  for (const f of session.tempFiles) safeUnlink(f);

  try { await session.provider.send({ text: "🔴 **Discord sync disabled**" }); } catch { /* gone */ }
  await session.provider.destroy();

  channelToSessionKey.delete(session.channelId);
  sessions.delete(sessionKey);
}

// ── Pipe connection handler ──

function handleConnection(socket: net.Socket) {
  // Tracks which sessionKey owns this socket for cleanup-on-close. Permission-
  // request connections don't carry a sessionKey (they come from short-lived
  // hook subprocesses, not rc.ts), so we leave connSessionKey null for them
  // — closing them must NOT trigger session cleanup.
  let connSessionKey: string | null = null;

  socket.on("data", createLineParser((line) => {
    let msg: ClientToDaemon;
    try { msg = JSON.parse(line); } catch { return; }
    if ("sessionKey" in msg && msg.sessionKey) connSessionKey = msg.sessionKey;
    handleClientMessage(msg, socket);
  }));

  socket.on("close", () => {
    // Permission-request socket close: drop any pending hook responder bound
    // to this socket so a stale entry can't be used after the hook subprocess
    // dies (e.g. timed out, killed). Not strictly required for correctness —
    // the responder would just never get a response — but keeps the map tidy.
    for (const [toolUseId, pending] of pendingPermissions) {
      if (pending.socket === socket) {
        clearTimeout(pending.timer);
        pendingPermissions.delete(toolUseId);
      }
    }
    if (connSessionKey) {
      const session = sessions.get(connSessionKey);
      if (session && session.socket === socket) {
        cleanupSession(connSessionKey);
      }
    }
  });

  socket.on("error", () => {
    // handled by close
  });
}

async function handleStateSignal(session: Session, msg: Extract<ClientToDaemon, { type: "state-signal" }>) {
  const { activity, ctx } = session;
  switch (msg.event) {
    case "stop":
      // Turn finished. If the hook payload carries a closing message we could
      // surface it, but the transcript already has the assistant text — so the
      // signal is purely a state transition.
      activity.transitionToIdle();
      break;
    case "stop-failure": {
      // Replaces the brittle `isApiErrorMessage` JSONL field check. StopFailure
      // fires when the assistant turn ends because the API returned an error;
      // the hook payload carries the structured error code + human detail.
      const code = msg.errorCode || "unknown";
      const detail = msg.errorDetails ? truncate(msg.errorDetails, 300) : "";
      const labels: Record<string, string> = {
        authentication_failed: "Authentication failed",
        billing_error: "Billing error",
        rate_limit: "Rate limited",
        invalid_request: "Invalid request",
        server_error: "Server error",
        unknown: "API error",
      };
      const headline = labels[code] || `API error (${code})`;
      const body = detail ? `: ${detail}` : "";
      await ctx.provider.send({
        embed: { description: `⚠️ **${headline}**${body}`, color: COLOR.ERROR_RED },
      });
      activity.transitionToIdle();
      break;
    }
    case "post-compact":
      if (msg.trigger === "manual") activity.transitionToIdle();
      // Auto compact boundary is already rendered from the JSONL compact_boundary
      // event; we just use the state change signal here.
      break;
    case "pre-compact": {
      const scope = msg.trigger === "manual" ? "manual" : "auto";
      const hint = msg.customInstructions ? `\n> ${truncate(msg.customInstructions, 300)}` : "";
      await ctx.provider.send({
        embed: {
          description: `🗜️ **Compacting context** (${scope})${hint}`,
          color: 0xf5a623,
        },
      });
      break;
    }
    case "session-end": {
      // Clean exits aren't crashes; announce and clear activity but keep the
      // channel mapping so a subsequent `claude --resume` lands in the same thread.
      const reason = msg.reason || "other";
      const reasonLabels: Record<string, string> = {
        logout: "Signed out",
        prompt_input_exit: "User exited",
        clear: "Context cleared",
        resume: "Resumed elsewhere",
        bypass_permissions_disabled: "Bypass permissions disabled",
        other: "Session ended",
      };
      await ctx.provider.send({
        embed: { description: `👋 **${reasonLabels[reason] || reason}**`, color: COLOR.BLURPLE },
      });
      activity.busy = false;
      activity.update("idle");
      break;
    }
    case "notification": {
      const nt = msg.notificationType || "notification";
      // These are surfaced by the permission/elicitation UIs themselves via
      // tool_use blocks, so we only emit a line for channel-visible signals
      // that have no other representation.
      if (nt === "auth_success") {
        await ctx.provider.send({ text: "🔑 Authenticated" });
      } else if (nt === "worker_permission_prompt") {
        const body = msg.message ? `: ${truncate(msg.message, 200)}` : "";
        await ctx.provider.send({
          embed: { description: `👷 **Worker permission requested**${body}`, color: 0xf5a623 },
        });
      }
      // permission_prompt / elicitation_dialog are already covered by the
      // tool-use rendering path; we skip them to avoid double-posts.
      break;
    }
    case "tool-start": {
      // Activity flips to "working" the moment Claude starts the tool, instead
      // of waiting on chokidar's ~250ms write-finish window. Idempotent — the
      // JSONL handler will redundantly call this when the tool_use block lands.
      activity.update("working");
      activity.busy = true;
      activity.resetIdleTimer();
      break;
    }
    case "tool-end":
    case "tool-failure": {
      // Tool finished — stop progress timer and mark resolved instantly so the
      // tool-use handler's escalation window (300ms) skips redundant rendering
      // when the result is already in. The JSONL tool_result render still
      // runs ~250ms later and is the canonical source for content/output.
      if (msg.toolUseId) {
        ctx.resolvedToolUseIds.add(msg.toolUseId);
        if (msg.durationMs != null) {
          const entry = toolState.toolUseThreads.get(msg.toolUseId);
          if (entry) entry.durationMs = msg.durationMs;
        }
        await toolState.cleanupProgress(msg.toolUseId, ctx.provider);
      }
      activity.resetIdleTimer();
      break;
    }
    case "subagent-start": {
      // Track agent_id → parent Task tool_use_id so subagent-end can find the
      // right thread to post into. Falls through to a no-op for orphan starts
      // (parent_tool_use_id missing) — JSONL-driven render still works.
      if (msg.agentId && msg.parentToolUseId) {
        subagentParents.set(msg.agentId, msg.parentToolUseId);
      }
      break;
    }
    case "subagent-end":
    case "subagent-failure": {
      const isError = msg.event === "subagent-failure";
      const parentId = msg.parentToolUseId
        || (msg.agentId ? subagentParents.get(msg.agentId) : undefined);
      if (msg.agentId) subagentParents.delete(msg.agentId);
      if (!parentId) break;

      const parentEntry = toolState.toolUseThreads.get(parentId);
      if (!parentEntry?.thread || !hasThreads(ctx.provider)) break;

      const dur = msg.durationMs != null ? ` in ${(msg.durationMs / 1000).toFixed(1)}s` : "";
      const icon = isError ? "❌" : "✅";
      try {
        await ctx.provider.sendToThread(parentEntry.thread, {
          text: `${icon} Subagent finished${dur}`,
        });
      } catch { /* best effort */ }
      break;
    }
  }
}

async function handleClientMessage(msg: ClientToDaemon, socket: net.Socket) {
  if (msg.type === "session-info") {
    // If this session already exists (reconnect), clean up old one first
    const existing = sessions.get(msg.sessionKey);
    if (existing) {
      await cleanupSession(msg.sessionKey);
    }
    try {
      await createSession(msg, socket);
    } catch (err) {
      console.error("[daemon] Failed to create session:", err);
    }
  } else if (msg.type === "state-signal") {
    const session = sessions.get(msg.sessionKey);
    if (!session) return;
    await handleStateSignal(session, msg);
  } else if (msg.type === "session-disconnect") {
    await cleanupSession(msg.sessionKey);
  } else if (msg.type === "permission-request") {
    handlePermissionRequest(msg, socket);
  }
}

// ── PermissionRequest hook responders ──
//
// Each pending entry is a hook subprocess (permission-hook.ts) waiting for an
// Allow/Deny click. When the user clicks, we write the decision JSON back on
// the held socket — Claude then applies that decision instead of waiting on
// the in-terminal dialog. If the user clicks BEFORE the hook arrives, we fall
// back to the legacy keyboard-simulation path; the hook, when it eventually
// arrives, gets `passthrough` so it doesn't double-resolve.

interface PendingPermission {
  socket: net.Socket;
  timer: ReturnType<typeof setTimeout>;
}
const pendingPermissions = new Map<string, PendingPermission>();
const HOOK_RESPONSE_WINDOW_MS = 4 * 60 * 1000;

function handlePermissionRequest(
  msg: Extract<ClientToDaemon, { type: "permission-request" }>,
  socket: net.Socket,
) {
  const writeBack = (payload: { behavior: "allow" | "deny" | "passthrough"; updatedInput?: Record<string, unknown>; message?: string }) => {
    try { socket.write(JSON.stringify(payload) + "\n"); socket.end(); } catch { /* gone */ }
  };

  const session = [...sessions.values()].find((s) => s.sessionId === msg.sessionId);
  if (!session) {
    writeBack({ behavior: "passthrough" });
    return;
  }
  // User already clicked → keyboard sim is in flight, hook lost the race.
  if (session.ctx.resolvedToolUseIds.has(msg.toolUseId)) {
    writeBack({ behavior: "passthrough" });
    return;
  }
  // Replace any stale registration for this toolUseId (shouldn't happen but
  // guard against a hook subprocess that retried).
  const existing = pendingPermissions.get(msg.toolUseId);
  if (existing) {
    clearTimeout(existing.timer);
    try { existing.socket.write(JSON.stringify({ behavior: "passthrough" }) + "\n"); existing.socket.end(); } catch { /* gone */ }
  }
  const timer = setTimeout(() => {
    const p = pendingPermissions.get(msg.toolUseId);
    if (!p || p.socket !== socket) return;
    pendingPermissions.delete(msg.toolUseId);
    writeBack({ behavior: "passthrough" });
  }, HOOK_RESPONSE_WINDOW_MS);
  pendingPermissions.set(msg.toolUseId, { socket, timer });
}

/**
 * Returns true if a pending hook responder claimed the click — caller should
 * skip the legacy keyboard-simulation fallback.
 */
function resolvePermissionViaHook(
  toolUseId: string,
  decision: { behavior: "allow"; updatedInput?: Record<string, unknown> } | { behavior: "deny"; message?: string },
): boolean {
  const pending = pendingPermissions.get(toolUseId);
  if (!pending) return false;
  pendingPermissions.delete(toolUseId);
  clearTimeout(pending.timer);
  try {
    pending.socket.write(JSON.stringify(decision) + "\n");
    pending.socket.end();
  } catch { /* socket gone — keyboard sim would have been a no-op too */ }
  return true;
}

// ── Main startup ──

async function main() {
  const token = process.env.DISCORD_BOT_TOKEN;
  categoryId = process.env.DISCORD_CATEGORY_ID || "";
  guildId = process.env.DISCORD_GUILD_ID || "";

  if (!token || !categoryId || !guildId) {
    console.error("[daemon] Missing DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, or DISCORD_CATEGORY_ID");
    process.exit(1);
  }

  // Auto-heal: patch any missing claude-remote hooks into ~/.claude/settings.json
  // on every boot. Lets users skip `claude-remote setup` after upgrading to a
  // version that adds new hook events — without touching unrelated settings.
  try {
    const added = ensureHooksInstalled();
    if (added.length > 0) {
      console.log(`[daemon] Auto-installed missing hook(s): ${added.join(", ")}`);
    }
  } catch (err) {
    console.warn("[daemon] Hook auto-heal failed (non-fatal):", err);
  }

  // Single Discord client for all sessions
  discordClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    makeCache: Options.cacheWithLimits({
      MessageManager: 10,
      GuildMemberManager: 0,
      GuildBanManager: 0,
      ReactionManager: 0,
      ReactionUserManager: 0,
      PresenceManager: 0,
      VoiceStateManager: 0,
      GuildEmojiManager: 0,
      GuildStickerManager: 0,
      GuildInviteManager: 0,
      GuildScheduledEventManager: 0,
      ThreadMemberManager: 0,
      AutoModerationRuleManager: 0,
    }),
    sweepers: {
      ...Options.DefaultSweeperSettings,
      messages: { interval: 300, lifetime: 600 },
    },
  });

  discordClient.on(Events.Error, (err) => console.error("[daemon] Discord error:", err));
  await discordClient.login(token);
  console.log("[daemon] Discord bot logged in");

  // Verify guild access
  const guild = await discordClient.guilds.fetch(guildId);
  if (!guild) {
    console.error("[daemon] Bot is not in the configured guild");
    process.exit(1);
  }

  // Start pipe server
  pipeServer = net.createServer(handleConnection);
  pipeServer.on("error", (err) => {
    console.error("[daemon] Pipe server error:", err);
    process.exit(1);
  });
  pipeServer.listen(DAEMON_PIPE_NAME, () => {
    console.log(`[daemon] Listening on ${DAEMON_PIPE_NAME}`);
    // Write PID file so rc.ts can verify daemon is running
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(path.join(CONFIG_DIR, "daemon.pid"), String(process.pid));
  });
}

// ── Hot-reload ──

const DAEMON_JS_PATH = path.resolve(import.meta.dirname, "daemon.js");
fs.watchFile(DAEMON_JS_PATH, { interval: 1000 }, (curr, prev) => {
  if (curr.mtimeMs === prev.mtimeMs) return;
  console.log("[daemon] Code changed, exiting for reload...");
  // Notify all sessions
  const promises: Promise<void>[] = [];
  for (const session of sessions.values()) {
    promises.push(session.provider.send({ text: "🔄 **Reloading...**" }).then(() => {}).catch(() => {}));
  }
  Promise.all(promises).finally(() => process.exit(RELOAD_EXIT_CODE));
});

// ── Cleanup ──

async function cleanup() {
  fs.unwatchFile(DAEMON_JS_PATH);
  const cleanupPromises = Array.from(sessions.keys()).map((k) => cleanupSession(k));
  await Promise.all(cleanupPromises);
  if (pipeServer) pipeServer.close();
  if (discordClient) discordClient.destroy();
  safeUnlink(path.join(CONFIG_DIR, "daemon.pid"));
  process.exit(0);
}

process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);

// ── Start ──

main().catch((err) => {
  console.error("[daemon] Fatal error:", err);
  process.exit(1);
});
