import { ActivityType, type Client } from "discord.js";
import type { DiscordProvider } from "./providers/discord.js";
import type { SessionContext } from "./handler.js";
import type { PtyWriteMessage } from "./types.js";
import { COLOR } from "./discord-renderer.js";

export type ActivityState = "idle" | "thinking" | "working";

export interface QueuedMessage {
  id: number;
  text: string;
  addedAt: number;
}

/**
 * Fallback idle timer — covers the cases Stop/StopFailure don't fire:
 *   - Esc-aborted turns (aborted_streaming, aborted_tools) — query.ts:1051,1515
 *   - max_turns / prompt_too_long / hook_stopped — query.ts:1711, no Stop path
 *   - refusal / model_error — short-circuits before handleStopHooks
 *
 * Reset on any activity-bearing signal (UserPromptSubmit, tool-start,
 * tool-end, tool-failure, JSONL write). 90s is long enough to outlast a
 * real tool run that's quietly streaming output but short enough that an
 * Esc-cancelled turn doesn't leave the queue stuck for 10 minutes (the
 * old value was effectively "never").
 */
const IDLE_TIMEOUT = 90_000;

const PRESENCE_LABELS: Record<ActivityState, string> = {
  idle: "Waiting for input",
  thinking: "Thinking...",
  working: "Working...",
};

export const STATUS_LABELS: Record<ActivityState, { icon: string; label: string }> = {
  idle: { icon: "🟢", label: "Idle" },
  thinking: { icon: "💭", label: "Thinking" },
  working: { icon: "🔧", label: "Working" },
};

export class ActivityManager {
  state: ActivityState = "idle";
  busy = false;
  queue: QueuedMessage[] = [];
  stopOverrideUntil = 0;

  private nextId = 1;
  private typingInterval: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private prevPresenceKey = "";
  private ctx: SessionContext | null = null;
  private onIdleCb?: () => void;

  constructor(
    private provider: DiscordProvider,
    private sendToClient: (msg: Omit<PtyWriteMessage, "sessionKey">) => void,
  ) {}

  /** Register a callback that fires whenever activity transitions to idle */
  onIdle(cb: () => void) { this.onIdleCb = cb; }

  setContext(ctx: SessionContext) {
    this.ctx = ctx;
  }

  update(state: ActivityState, client?: Client) {
    this.state = state;
    const cl = client || this.provider.getClient();
    if (!cl?.user) return;

    // Change detection: skip Discord API call if nothing changed
    const key = `${state}:${this.queue.length}`;
    if (key !== this.prevPresenceKey) {
      this.prevPresenceKey = key;
      const suffix = this.queue.length > 0 ? ` (${this.queue.length} queued)` : "";
      cl.user.setPresence({
        activities: [{ name: "custom", type: ActivityType.Custom, state: PRESENCE_LABELS[state] + suffix }],
        status: state === "idle" ? "online" : "dnd",
      });
    }

    if (state === "idle") {
      this.stopTyping();
      this.onIdleCb?.();
    } else {
      this.startTyping();
    }
  }

  /** Transition to idle and schedule dequeue. No-op if already idle. */
  transitionToIdle(dequeueDelay = 500) {
    if (!this.busy) return;
    this.busy = false;
    this.update("idle");
    setTimeout(() => this.tryDequeue(), dequeueDelay);
  }

  resetIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!this.busy) return;
    this.idleTimer = setTimeout(() => {
      if (!this.busy) return;
      console.log("[activity] Idle timeout — no activity for 90s, assuming idle (likely Esc-aborted turn or hook miss)");
      this.transitionToIdle(0);
    }, IDLE_TIMEOUT);
  }

  enqueue(text: string): QueuedMessage {
    const msg: QueuedMessage = { id: this.nextId++, text, addedAt: Date.now() };
    this.queue.push(msg);
    return msg;
  }

  tryDequeue() {
    if (this.busy || this.queue.length === 0 || !this.ctx) return;
    // Drain ALL queued messages at once — mirrors upstream's queueProcessor
    // dequeueAllMatching, which submits everything in the same mode as one
    // turn. One PTY paste, one Discord embed, one API round-trip — saves
    // 3-5× latency over per-message dispatch.
    const drained = this.queue.splice(0);
    const combined = drained.map((m) => m.text).join("\n\n");
    this.busy = true;
    this.resetIdleTimer();
    this.ctx.originMessages.add(combined.trim());
    this.sendToClient({ type: "pty-write", text: combined });
    this.update("thinking");

    const ids = drained.map((m) => `#${m.id}`).join(", ");
    const preview = drained[0].text.slice(0, 200);
    const more = drained.length > 1 ? ` *(+${drained.length - 1} more)*` : "";
    this.provider.send({
      embed: {
        description: drained.length === 1
          ? `📤 Sending queued message ${ids}\n>>> ${preview}`
          : `📤 Sending ${drained.length} queued messages [${ids}]\n>>> ${preview}${more}`,
        color: COLOR.BLURPLE,
      },
    });
  }

  clearQueue(): number {
    const count = this.queue.length;
    this.queue = [];
    return count;
  }

  removeFromQueue(id: number): boolean {
    const idx = this.queue.findIndex((m) => m.id === id);
    if (idx === -1) return false;
    this.queue.splice(idx, 1);
    return true;
  }

  findInQueue(id: number): QueuedMessage | undefined {
    return this.queue.find((m) => m.id === id);
  }

  destroy() {
    this.stopTyping();
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    this.prevPresenceKey = "";
  }

  private startTyping() {
    if (this.typingInterval) return;
    this.provider.getChannel().sendTyping().catch(() => {});
    this.typingInterval = setInterval(() => {
      this.provider.getChannel().sendTyping().catch(() => {});
    }, 3000);
  }

  private stopTyping() {
    if (!this.typingInterval) return;
    clearInterval(this.typingInterval);
    this.typingInterval = null;
  }
}
