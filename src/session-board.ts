import type { DiscordProvider } from "./providers/discord.js";
import type { ProviderMessage, OutgoingMessage } from "./provider.js";
import type { StatuslineSnapshot } from "./utils.js";
import { MODE_LABELS } from "./utils.js";
import { COLOR } from "./discord-renderer.js";
import { formatUSD } from "./cost.js";

/** Title prefix used for pinned-message rediscovery on daemon restart. */
export const BOARD_TITLE = "🔋 Session status";

/** Minimum gap between consecutive board edits — protects against editing on
 *  every Stop when nothing material changed. */
const MIN_EDIT_INTERVAL_MS = 30_000;
/** Bar progress delta below which we skip the edit (still respects time gate). */
const PCT_DELTA_THRESHOLD = 1;

export interface BoardState {
  messageId: ProviderMessage | null;
  /** Cached values from the last successful render — used to skip no-op edits. */
  lastFiveHourPct?: number;
  lastWeeklyPct?: number;
  lastCtxPct?: number;
  lastCost?: number;
  lastEditAt: number;
  /** Whether we've attempted rediscovery from pinned messages. Done lazily on
   *  first update so we don't pay the REST roundtrip when there's nothing new
   *  to render anyway. */
  rediscovered: boolean;
}

export function createBoardState(): BoardState {
  return { messageId: null, lastEditAt: 0, rediscovered: false };
}

function bar(pct: number): string {
  const p = Math.max(0, Math.min(100, pct));
  const filled = Math.round((p / 100) * 5);
  return "▓".repeat(filled) + "░".repeat(5 - filled);
}

/** Render a unix-epoch-seconds value as Discord's relative-timestamp tag.
 *  Upstream `services/claudeAiLimits.ts` types `resets_at` as a number; the
 *  earlier ISO-string assumption was wrong and produced "—". */
function relTs(epochSec: number | undefined): string {
  if (!epochSec || !Number.isFinite(epochSec)) return "—";
  return `<t:${Math.floor(epochSec)}:R>`;
}

function renderBoard(snap: StatuslineSnapshot): OutgoingMessage {
  const lines: string[] = [];

  const model = snap.modelDisplay ?? "Claude";
  const mode = snap.permissionMode ? (MODE_LABELS[snap.permissionMode] ?? snap.permissionMode) : "Default";
  lines.push(`**Model:** ${model} · **Mode:** ${mode}`);

  if (snap.fiveHourPct !== undefined) {
    lines.push(`**5h:** ${bar(snap.fiveHourPct)} ${Math.round(snap.fiveHourPct)}% · resets ${relTs(snap.fiveHourResetsAt)}`);
  }
  if (snap.weeklyPct !== undefined) {
    lines.push(`**Week:** ${bar(snap.weeklyPct)} ${Math.round(snap.weeklyPct)}% · resets ${relTs(snap.weeklyResetsAt)}`);
  }

  const cost = snap.totalCostUsd !== undefined ? formatUSD(snap.totalCostUsd) : "—";
  const ctx = snap.usedPercentage !== undefined ? `${Math.round(snap.usedPercentage)}%` : "—";
  lines.push(`**Spent:** ${cost} · **Ctx:** ${ctx}`);
  lines.push(`-# Updated <t:${Math.floor(snap.ts / 1000)}:R>`);

  return {
    embed: {
      title: BOARD_TITLE,
      description: lines.join("\n"),
      color: COLOR.BLURPLE,
    },
  };
}

function snapshotEmpty(snap: StatuslineSnapshot): boolean {
  return snap.totalCostUsd === undefined
    && snap.usedPercentage === undefined
    && snap.fiveHourPct === undefined
    && snap.weeklyPct === undefined;
}

function materiallyChanged(state: BoardState, snap: StatuslineSnapshot): boolean {
  const fhDelta = Math.abs((snap.fiveHourPct ?? 0) - (state.lastFiveHourPct ?? 0));
  const wkDelta = Math.abs((snap.weeklyPct ?? 0) - (state.lastWeeklyPct ?? 0));
  const ctxDelta = Math.abs((snap.usedPercentage ?? 0) - (state.lastCtxPct ?? 0));
  if (fhDelta >= PCT_DELTA_THRESHOLD) return true;
  if (wkDelta >= PCT_DELTA_THRESHOLD) return true;
  if (ctxDelta >= PCT_DELTA_THRESHOLD) return true;
  if (snap.totalCostUsd !== undefined && snap.totalCostUsd !== state.lastCost) return true;
  return false;
}

export async function maybeUpdateBoard(
  provider: DiscordProvider,
  state: BoardState,
  snap: StatuslineSnapshot,
): Promise<void> {
  if (snapshotEmpty(snap)) return;

  if (!state.rediscovered && !state.messageId) {
    state.rediscovered = true;
    state.messageId = await provider.findPinnedBoard(BOARD_TITLE);
  }

  const isFirst = !state.messageId;
  const tooSoon = Date.now() - state.lastEditAt < MIN_EDIT_INTERVAL_MS;
  if (!isFirst && tooSoon && !materiallyChanged(state, snap)) return;

  const msg = renderBoard(snap);
  if (state.messageId) {
    try {
      await provider.edit(state.messageId, msg);
    } catch {
      state.messageId = null;
    }
  }
  if (!state.messageId) {
    const sent = await provider.send(msg);
    if (sent) {
      state.messageId = sent;
      try { await provider.pin(sent); } catch { /* missing perms or 50-pin cap */ }
    }
  }

  state.lastFiveHourPct = snap.fiveHourPct;
  state.lastWeeklyPct = snap.weeklyPct;
  state.lastCtxPct = snap.usedPercentage;
  state.lastCost = snap.totalCostUsd;
  state.lastEditAt = Date.now();
}
