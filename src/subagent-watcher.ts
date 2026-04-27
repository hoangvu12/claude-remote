/**
 * Per-subagent JSONL watcher.
 *
 * When SubagentStart fires we tail the subagent's own transcript
 * (`<claudeDir>/projects/<cwd>/<parentSessionId>/subagents/agent-<agentId>.jsonl`)
 * and stream a condensed view into the parent Task tool's existing Discord
 * thread. SubagentStop closes the watcher.
 *
 * This is intentionally NOT routed through the main pipeline — that targets a
 * channel, owns activity state, and runs the full handler chain. Subagent
 * activity is supporting context, not a top-level conversation, so the
 * renderer here is deliberately spartan: assistant text, tool calls, errors.
 */

import chokidar, { type FSWatcher } from "chokidar";
import { open } from "node:fs/promises";
import { resolveSubagentJSONLPath, truncate } from "./utils.js";
import type { JSONLMessage, ContentBlock, ContentBlockText, ContentBlockToolUse, ContentBlockToolResult } from "./types.js";
import type { ProviderThread, OutputProvider } from "./provider.js";
import { hasThreads } from "./provider.js";
import { toolState } from "./handlers/tool-state.js";

interface SubagentWatcher {
  watcher: FSWatcher;
  jsonlPath: string;
  parentToolUseId: string;
  /** Owning daemon session — lets us drop all watchers when a session closes. */
  sessionKey: string;
  /** Byte offset already consumed — same pattern as the main JSONL watcher. */
  offset: number;
  /** UUIDs we've already rendered (for safety against duplicate file events). */
  rendered: Set<string>;
}

const watchers = new Map<string, SubagentWatcher>();

/**
 * Build a single-line summary for a tool_use block. Cheap by design — no
 * diffing, no syntax highlighting; the parent thread already shows the full
 * Task call's output, this is just live-progress.
 */
function previewToolUse(block: ContentBlockToolUse): string {
  const name = block.name;
  const input = (block.input || {}) as Record<string, unknown>;
  if (name === "Bash") return truncate(`\`${String(input.command ?? "")}\``, 200);
  if (name === "Read" || name === "Edit" || name === "Write") return `\`${String(input.file_path ?? "")}\``;
  if (name === "Grep") return `\`${String(input.pattern ?? "")}\`${input.path ? ` in \`${String(input.path)}\`` : ""}`;
  if (name === "Glob") return `\`${String(input.pattern ?? "")}\``;
  if (name === "Agent" || name === "Task") return truncate(String(input.description ?? ""), 200);
  // MCP and unknown: show the first stringy field as a hint
  const firstString = Object.values(input).find((v) => typeof v === "string") as string | undefined;
  return firstString ? truncate(`\`${firstString}\``, 200) : "";
}

function extractText(content: ContentBlock[] | string): string {
  if (typeof content === "string") return content;
  return content.filter((b): b is ContentBlockText => b.type === "text").map((b) => b.text).join("\n");
}

/**
 * Render a parsed subagent message as a list of strings to post into the
 * parent thread (one Discord message per string). Returns [] for messages
 * that should be skipped entirely.
 */
function renderEntry(msg: JSONLMessage): string[] {
  if (msg.type !== "assistant" && msg.type !== "user") return [];
  const content = msg.message?.content;
  if (!content) return [];
  const blocks = Array.isArray(content) ? content : [{ type: "text", text: content } as ContentBlockText];

  const out: string[] = [];
  for (const block of blocks) {
    if (block.type === "text" && msg.type === "assistant") {
      const text = (block as ContentBlockText).text.trim();
      if (text) out.push(`🤖 ${truncate(text, 1900)}`);
    } else if (block.type === "tool_use") {
      const tu = block as ContentBlockToolUse;
      const preview = previewToolUse(tu);
      out.push(`🔧 **${tu.name}**${preview ? ` ${preview}` : ""}`);
    } else if (block.type === "tool_result") {
      const tr = block as ContentBlockToolResult;
      if (tr.is_error) {
        const text = extractText(tr.content);
        out.push(`❌ ${truncate(text || "(tool error)", 1900)}`);
      }
    }
  }
  return out;
}

/** Read newly-appended bytes since the last offset and dispatch entries. */
async function consumeNewLines(state: SubagentWatcher, thread: ProviderThread, provider: OutputProvider) {
  if (!hasThreads(provider)) return;
  let fd;
  try {
    fd = await open(state.jsonlPath, "r");
  } catch {
    // File hasn't been created yet (chokidar fired on the parent dir) — wait
    // for the next event.
    return;
  }
  try {
    const stat = await fd.stat();
    if (stat.size <= state.offset) return;
    const buf = Buffer.alloc(stat.size - state.offset);
    await fd.read(buf, 0, buf.length, state.offset);
    const lastNL = buf.lastIndexOf(0x0A);
    if (lastNL === -1) return;
    state.offset += lastNL + 1;
    const lines = buf.subarray(0, lastNL + 1).toString("utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      let entry: JSONLMessage;
      try { entry = JSON.parse(line) as JSONLMessage; } catch { continue; }
      if (state.rendered.has(entry.uuid)) continue;
      state.rendered.add(entry.uuid);
      for (const text of renderEntry(entry)) {
        try { await provider.sendToThread(thread, { text }); } catch { /* thread gone or rate-limited */ }
      }
    }
  } finally {
    await fd.close().catch(() => {});
  }
}

export function startSubagentWatcher(opts: {
  parentSessionId: string;
  projectDir: string;
  agentId: string;
  parentToolUseId: string;
  sessionKey: string;
  provider: OutputProvider;
}): void {
  const { parentSessionId, projectDir, agentId, parentToolUseId, sessionKey, provider } = opts;
  if (!hasThreads(provider)) return;
  if (watchers.has(agentId)) return;

  const jsonlPath = resolveSubagentJSONLPath(parentSessionId, projectDir, agentId);
  const watcher = chokidar.watch(jsonlPath, {
    persistent: true,
    usePolling: process.platform === "win32",
    interval: 100,
  });

  const state: SubagentWatcher = {
    watcher,
    jsonlPath,
    parentToolUseId,
    sessionKey,
    offset: 0,
    rendered: new Set(),
  };
  watchers.set(agentId, state);

  const dispatch = () => {
    const parentEntry = toolState.toolUseThreads.get(parentToolUseId);
    if (!parentEntry?.thread) return;
    consumeNewLines(state, parentEntry.thread, provider).catch((err) => {
      console.error(`[daemon] Subagent watcher error (${agentId}):`, err);
    });
  };

  watcher.on("add", dispatch);
  watcher.on("change", dispatch);
  watcher.on("error", (err: unknown) => console.error(`[daemon] Subagent watcher error (${agentId}):`, err));
  console.log(`[daemon] Watching subagent JSONL: ${jsonlPath}`);
}

export async function stopSubagentWatcher(agentId: string): Promise<void> {
  const state = watchers.get(agentId);
  if (!state) return;
  watchers.delete(agentId);
  try { await state.watcher.close(); } catch { /* already gone */ }
}

export async function stopAllSubagentWatchersForSession(sessionKey: string): Promise<void> {
  const ids: string[] = [];
  for (const [agentId, state] of watchers) {
    if (state.sessionKey === sessionKey) ids.push(agentId);
  }
  for (const id of ids) await stopSubagentWatcher(id);
}

/** Drain any final writes (e.g. the closing assistant message that lands a
 *  beat after SubagentStop) before tearing down the watcher. Best-effort. */
export async function flushAndStopSubagentWatcher(agentId: string, provider: OutputProvider): Promise<void> {
  const state = watchers.get(agentId);
  if (!state) return;
  const parentEntry = toolState.toolUseThreads.get(state.parentToolUseId);
  if (parentEntry?.thread) {
    try { await consumeNewLines(state, parentEntry.thread, provider); } catch { /* best effort */ }
  }
  await stopSubagentWatcher(agentId);
}
