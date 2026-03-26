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

const IDLE_TIMEOUT = 120_000;

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
      console.log("[activity] Idle timeout — no JSONL activity for 2m, assuming idle");
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
    const next = this.queue.shift()!;
    this.busy = true;
    this.resetIdleTimer();
    this.ctx.originMessages.add(next.text.trim());
    this.sendToClient({ type: "pty-write", text: next.text });
    if (next.text.includes("\n")) {
      setTimeout(() => this.sendToClient({ type: "pty-write", text: "\r", raw: true }), 200);
    }
    this.update("thinking");
    this.provider.send({
      embed: {
        description: `📤 Sending queued message #${next.id} (${this.queue.length} remaining)\n>>> ${next.text.slice(0, 200)}`,
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
