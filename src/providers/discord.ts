import {
  Client,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  AttachmentBuilder,
  Events,
  type TextChannel,
  type ThreadChannel,
  type Message,
  type MessageCreateOptions,
  type MessageComponentInteraction,
} from "discord.js";
import type {
  OutputProvider,
  ThreadCapable,
  InputCapable,
  OutgoingMessage,
  ProviderMessage,
  ProviderThread,
  ProviderInteraction,
  UserAttachment,
} from "../provider.js";
import { ID_PREFIX } from "../utils.js";

// ── Rate limiting ──

const RATE_WINDOW = 5000;
const RATE_LIMIT = 5;

// ── Cache limits ──

const MAX_MESSAGE_CACHE = 80;
const MAX_THREAD_CACHE = 40;

export class DiscordProvider implements OutputProvider, ThreadCapable, InputCapable {
  private messageTimes: number[] = [];
  private messageCache = new Map<string, Message>();
  private threadCache = new Map<string, ThreadChannel>();
  private userMessageCb?: (text: string, attachments?: UserAttachment[]) => void;
  private interactionCb?: (interaction: ProviderInteraction) => void;

  constructor(
    private client: Client,
    private channel: TextChannel,
  ) {
    client.on(Events.MessageCreate, (msg) => this.handleMessage(msg));
    client.on(Events.InteractionCreate, (interaction) => this.handleInteraction(interaction));
  }

  // ── OutputProvider ──

  async send(msg: OutgoingMessage): Promise<ProviderMessage | null> {
    const payload = this.toDiscord(msg);
    const sent = await this.rateLimitedSend(this.channel, payload);
    if (!sent) return null;
    this.messageCache.set(sent.id, sent);
    this.capCache(this.messageCache, MAX_MESSAGE_CACHE);
    return { id: sent.id };
  }

  async edit(handle: ProviderMessage, msg: OutgoingMessage): Promise<void> {
    const message = this.messageCache.get(handle.id);
    if (!message) return;
    const payload = this.toDiscord(msg);
    try { await message.edit(payload as import("discord.js").MessageEditOptions); } catch { /* message may be gone */ }
  }

  async delete(handle: ProviderMessage): Promise<void> {
    const message = this.messageCache.get(handle.id);
    if (!message) return;
    try { await message.delete(); } catch { /* already gone */ }
    this.messageCache.delete(handle.id);
  }

  async pin(handle: ProviderMessage): Promise<void> {
    const message = this.messageCache.get(handle.id);
    if (!message) return;
    try { await message.pin(); } catch { /* best effort */ }
  }

  async destroy(): Promise<void> {
    this.messageCache.clear();
    this.threadCache.clear();
    this.client.destroy();
  }

  // ── ThreadCapable ──

  async createThread(name: string): Promise<ProviderThread> {
    const thread = await this.channel.threads.create({
      name,
      autoArchiveDuration: 60,
    });
    this.threadCache.set(thread.id, thread);
    this.capCache(this.threadCache, MAX_THREAD_CACHE);
    return { id: thread.id };
  }

  async sendToThread(handle: ProviderThread, msg: OutgoingMessage): Promise<ProviderMessage | null> {
    const thread = this.threadCache.get(handle.id);
    if (!thread) return null;
    const payload = this.toDiscord(msg);
    const sent = await this.rateLimitedSend(thread, payload);
    if (!sent) return null;
    this.messageCache.set(sent.id, sent);
    this.capCache(this.messageCache, MAX_MESSAGE_CACHE);
    return { id: sent.id };
  }

  async renameThread(handle: ProviderThread, name: string): Promise<void> {
    const thread = this.threadCache.get(handle.id);
    if (!thread) return;
    try { await thread.setName(name); } catch { /* rate limited */ }
  }

  async archiveThread(handle: ProviderThread): Promise<void> {
    const thread = this.threadCache.get(handle.id);
    if (!thread) return;
    try { await thread.setArchived(true); } catch { /* best effort */ }
    this.threadCache.delete(handle.id);
  }

  // ── InputCapable ──

  onUserMessage(cb: (text: string, attachments?: UserAttachment[]) => void): void {
    this.userMessageCb = cb;
  }

  onInteraction(cb: (interaction: ProviderInteraction) => void): void {
    this.interactionCb = cb;
  }

  async respond(interaction: ProviderInteraction, msg: OutgoingMessage): Promise<void> {
    const ref = interaction.ref;
    if (!ref) return;
    const discordInteraction = ref as import("discord.js").MessageComponentInteraction | import("discord.js").ModalSubmitInteraction;
    const payload = this.toDiscord(msg);

    if (discordInteraction.isModalSubmit()) {
      await discordInteraction.reply({ ...payload, ephemeral: true } as never);
    } else {
      await discordInteraction.update(payload as never);
    }
  }

  // ── Discord message → provider callback ──

  private handleMessage(message: Message) {
    if (message.author.bot) return;
    if (message.channel.id !== this.channel.id) return;
    const text = message.content.trim();

    // Collect image attachments
    const IMAGE_EXTS = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
    const attachments: UserAttachment[] = [];
    for (const [, att] of message.attachments) {
      const isImage = att.contentType?.startsWith("image/") || IMAGE_EXTS.test(att.name ?? "");
      if (isImage) {
        attachments.push({ url: att.url, filename: att.name ?? "image.png", contentType: att.contentType ?? "image/png" });
      }
    }

    if (!text && attachments.length === 0) return;
    this.userMessageCb?.(text, attachments.length > 0 ? attachments : undefined);
  }

  private async handleInteraction(interaction: import("discord.js").Interaction) {
    if (!interaction.isMessageComponent() && !interaction.isModalSubmit()) return;

    if (interaction.isButton()) {
      const id = interaction.customId;

      if (id.startsWith(ID_PREFIX.ALLOW)) {
        this.interactionCb?.({ type: "button", customId: id, ref: interaction });
        return;
      }
      if (id.startsWith(ID_PREFIX.DENY)) {
        this.interactionCb?.({ type: "button", customId: id, ref: interaction });
        return;
      }
      if (id.startsWith(ID_PREFIX.ASK)) {
        const parts = id.split(":");
        const selectedLabel = parts[3];
        this.interactionCb?.({ type: "button", customId: id, values: [selectedLabel], ref: interaction });
        return;
      }
      if (id.startsWith(ID_PREFIX.ASK_OTHER)) {
        // Show modal
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

      // Forward any other button interactions to the callback
      this.interactionCb?.({ type: "button", customId: id, ref: interaction });
      return;
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith(ID_PREFIX.ASK)) {
        const selected = interaction.values.join(", ");
        this.interactionCb?.({ type: "select", customId: interaction.customId, values: interaction.values, text: selected, ref: interaction });
        return;
      }
    }

    if (interaction.isModalSubmit()) {
      const text = interaction.fields.getTextInputValue("text");
      if (text) {
        this.interactionCb?.({ type: "modal-submit", customId: interaction.customId, text, ref: interaction });
      }
    }
  }

  // ── Cache eviction ──

  private capCache<K, V>(map: Map<K, V>, max: number) {
    if (map.size <= max) return;
    const excess = map.size - max;
    const iter = map.keys();
    for (let i = 0; i < excess; i++) {
      const key = iter.next().value;
      if (key !== undefined) map.delete(key);
    }
  }

  // ── Internal helpers ──

  private toDiscord(msg: OutgoingMessage): MessageCreateOptions {
    const payload: MessageCreateOptions = {};

    if (msg.text) {
      payload.content = msg.text;
    }

    if (msg.embed) {
      const embed = new EmbedBuilder()
        .setDescription(msg.embed.description);
      if (msg.embed.title) embed.setTitle(msg.embed.title);
      if (msg.embed.color !== undefined) embed.setColor(msg.embed.color);
      if (msg.embed.footer) embed.setFooter({ text: msg.embed.footer });
      if (msg.embed.author) embed.setAuthor({ name: msg.embed.author });
      if (msg.embedImage) embed.setImage(msg.embedImage);
      payload.embeds = [embed];
    } else {
      payload.embeds = [];
    }

    const components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];

    if (msg.actions?.length) {
      const styleMap: Record<string, ButtonStyle> = {
        primary: ButtonStyle.Primary,
        success: ButtonStyle.Success,
        danger: ButtonStyle.Danger,
        secondary: ButtonStyle.Secondary,
      };
      const buttons = msg.actions.map((a) =>
        new ButtonBuilder()
          .setCustomId(a.id)
          .setLabel(a.label)
          .setStyle(styleMap[a.style] || ButtonStyle.Primary)
      );
      components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons));
    }

    if (msg.selectMenu) {
      const select = new StringSelectMenuBuilder()
        .setCustomId(msg.selectMenu.id)
        .setPlaceholder(msg.selectMenu.placeholder)
        .addOptions(msg.selectMenu.options.map((o) => ({
          label: o.label,
          value: o.value,
          description: o.description || undefined,
        })));
      if (msg.selectMenu.minValues) select.setMinValues(msg.selectMenu.minValues);
      if (msg.selectMenu.maxValues) select.setMaxValues(msg.selectMenu.maxValues);
      components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
    }

    // Always set components — when empty, this clears existing buttons on update()
    {
      payload.components = components;
    }

    if (msg.files?.length) {
      payload.files = msg.files.map((f) => new AttachmentBuilder(f.data, { name: f.name }));
    }

    return payload;
  }

  private async rateLimitedSend(ch: TextChannel | ThreadChannel, payload: MessageCreateOptions): Promise<Message | null> {
    const now = Date.now();
    this.messageTimes = this.messageTimes.filter((t) => now - t < RATE_WINDOW);

    if (this.messageTimes.length >= RATE_LIMIT) {
      const waitUntil = this.messageTimes[0] + RATE_WINDOW;
      await new Promise((r) => setTimeout(r, waitUntil - now + 50));
    }

    try {
      const msg = await ch.send(payload);
      this.messageTimes.push(Date.now());
      return msg;
    } catch (err) {
      console.error("[discord] Failed to send message:", err);
      return null;
    }
  }

  // ── Expose channel for daemon startup tasks ──

  getChannel(): TextChannel { return this.channel; }
  getClient(): Client { return this.client; }

  /** Clean up old threads from previous connections */
  async cleanupThreads(): Promise<void> {
    try {
      const activeThreads = await this.channel.threads.fetchActive();
      for (const [, thread] of activeThreads.threads) {
        try { await thread.delete(); } catch { /* may already be gone */ }
      }
    } catch { /* no threads to clean */ }
  }
}
