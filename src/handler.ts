import type { ProcessedMessage } from "./types.js";
import type { OutputProvider } from "./provider.js";

export type HandlerResult = "consumed" | "pass";

/** Shared session state passed to every handler */
export interface SessionContext {
  sessionId: string;
  projectDir: string;
  provider: OutputProvider;
  permissionMode: string;
  /**
   * True when `bypassPermissions` is reachable via Shift+Tab cycling — i.e.
   * the user launched with `--dangerously-skip-permissions`. We infer from
   * `initialPermissionMode` at session start.
   */
  bypassAvailable: boolean;
  /** Session source: startup / resume / clear / compact (from SessionStart hook). */
  sessionSource?: "startup" | "resume" | "clear" | "compact";
  resolvedToolUseIds: Set<string>;
  originMessages: Set<string>;
  sendToPty(text: string): void;
}

/** A self-contained feature module that processes specific message types */
export interface MessageHandler {
  name: string;
  types?: ProcessedMessage["type"][];
  handle(pm: ProcessedMessage, ctx: SessionContext): Promise<HandlerResult>;
  init?(ctx: SessionContext): void;
  destroy?(): void;
}
