// ── Output Provider Abstraction ──

/** Opaque message handle returned by the provider */
export interface ProviderMessage {
  id: string;
}

/** Opaque thread/sub-conversation handle */
export interface ProviderThread {
  id: string;
}

/** Platform-agnostic outgoing message */
export interface OutgoingMessage {
  text?: string;
  embed?: {
    title?: string;
    description: string;
    color?: number;
    footer?: string;
    author?: string;
  };
  actions?: Array<{
    id: string;
    label: string;
    style: "primary" | "success" | "danger" | "secondary";
  }>;
  selectMenu?: {
    id: string;
    placeholder: string;
    options: Array<{ label: string; value: string; description?: string }>;
    minValues?: number;
    maxValues?: number;
  };
  files?: Array<{ name: string; data: Buffer }>;
  /** Image URL to display inside the embed (e.g. attachment://image.png) */
  embedImage?: string;
}

/** Interaction from a user (button click, select, modal) */
export interface ProviderInteraction {
  type: "button" | "select" | "modal-submit";
  customId: string;
  values?: string[];
  text?: string;
  /** Provider-specific ref for responding (e.g., Discord interaction object) */
  ref: unknown;
}

/** Core capability — every provider must implement this */
export interface OutputProvider {
  send(msg: OutgoingMessage): Promise<ProviderMessage | null>;
  edit(handle: ProviderMessage, msg: OutgoingMessage): Promise<void>;
  delete(handle: ProviderMessage): Promise<void>;
  pin(handle: ProviderMessage): Promise<void>;
  destroy(): Promise<void>;
}

/** Optional: provider supports threads */
export interface ThreadCapable {
  createThread(name: string): Promise<ProviderThread>;
  sendToThread(thread: ProviderThread, msg: OutgoingMessage): Promise<ProviderMessage | null>;
  renameThread(thread: ProviderThread, name: string): Promise<void>;
  archiveThread(thread: ProviderThread): Promise<void>;
}

export interface UserAttachment {
  url: string;
  filename: string;
  contentType: string | null;
}

/** Optional: provider supports receiving user input */
export interface InputCapable {
  onUserMessage(cb: (text: string, attachments?: UserAttachment[], userId?: string) => void): void;
  onInteraction(cb: (interaction: ProviderInteraction) => void): void;
  respond(interaction: ProviderInteraction, msg: OutgoingMessage): Promise<void>;
}

export function hasThreads(p: OutputProvider): p is OutputProvider & ThreadCapable {
  return "createThread" in p;
}

export function hasInput(p: OutputProvider): p is OutputProvider & InputCapable {
  return "onUserMessage" in p;
}

/** Edit an existing message, falling back to send if edit fails or handle is null */
export async function editOrSend(
  provider: OutputProvider,
  handle: ProviderMessage | null | undefined,
  msg: OutgoingMessage,
): Promise<void> {
  if (handle) {
    try { await provider.edit(handle, msg); return; } catch { /* edit failed, fall through */ }
  }
  await provider.send(msg);
}
