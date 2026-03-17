import type { ProcessedMessage } from "./types.js";
import type { OutputProvider } from "./provider.js";

export type HandlerResult = "consumed" | "pass";

/** Shared session state passed to every handler */
export interface SessionContext {
  sessionId: string;
  projectDir: string;
  provider: OutputProvider;
  permissionMode: string;
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
