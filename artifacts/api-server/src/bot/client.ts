import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type Guild,
  type Message,
} from "discord.js";
import { logger } from "../lib/logger";
import { createReply } from "./personality";
import { getVideoContext } from "./video-context";
import { isGuildActive, loadMemory, saveMemory, setGuildActive } from "./memory";

const activateCommand = new SlashCommandBuilder()
  .setName("activate")
  .setDescription("turn mack on in this server")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
const deactivateCommand = new SlashCommandBuilder()
  .setName("deactivate")
  .setDescription("turn mack off in this server")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
const commands = [activateCommand.toJSON(), deactivateCommand.toJSON()];

const channelQueues = new Map<string, Promise<void>>();
const TIMEOUT_CONTROLLER_ID = "1166090148732219393";
const MAX_DISCORD_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;
const TIMEOUT_COMMAND_PREFIX =
  /^\s*(?:(?:hey\s+)?(?:mack|<@!?\d+>)[\s,:-]+)?(?:(?:please|plz)\s+|(?:(?:can|could|would)\s+(?:you|u|ya)(?:\s+please)?\s+)|(?:i\s+(?:want|need)\s+(?:you|u)\s+to\s+))?(?:timeout\b|time\s+out\b|time\s+(?:this\s+person|them|<@!?\d+>)\s+out\b|put\b|give\b)/i;
const UNTIMEOUT_COMMAND_PREFIX =
  /^\s*(?:(?:hey\s+)?(?:mack|<@!?\d+>)[\s,:-]+)?(?:(?:please|plz)\s+|(?:(?:can|could|would)\s+(?:you|u|ya)(?:\s+please)?\s+)|(?:i\s+(?:want|need)\s+(?:you|u)\s+to\s+))?(?:un[\s-]*time\s*out\b|(?:remove|clear|lift)\s+(?:the\s+)?timeout\b)/i;
const TIMEOUT_DURATION =
  /(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|min|m|hours?|hrs?|hr|h|days?|d|weeks?|wks?|wk|w|months?|mos?|mo|years?|yrs?|yr|y)\b/gi;

async function registerCommands(guild: Guild): Promise<void> {
  try {
    await guild.commands.set(commands);
    logger.info({ guildId: guild.id }, "Registered Mack's server commands");
  } catch (err) {
    logger.error({ err, guildId: guild.id }, "Could not register Mack's commands");
  }
}

async function storeSentMessage(
  message: Message,
  sentId: string,
  content: string,
): Promise<void> {
  const botUserId = message.client.user?.id;
  if (!message.guildId || !botUserId) return;

  await saveMemory({
    id: sentId,
    guildId: message.guildId,
    channelId: message.channelId,
    authorId: botUserId,
    authorName: "mack thicklin",
    role: "assistant",
    content,
    createdAt: new Date(),
  });
}

async function sendStoredReply(message: Message, content: string): Promise<void> {
  const sent = await message.reply({
    content,
    allowedMentions: { parse: [] },
  });
  await storeSentMessage(message, sent.id, content);
}

function parseDurationNumber(value: string): number | undefined {
  const words: Record<string, number> = {
    a: 1,
    an: 1,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
    twenty: 20,
  };
  const normalized = value.toLocaleLowerCase();
  return words[normalized] ?? Number(value);
}

function durationUnit(
  unit: string,
): { milliseconds: number; name: string } | undefined {
  const normalized = unit.toLocaleLowerCase();
  if (normalized === "ms" || normalized.startsWith("millisecond")) {
    return { milliseconds: 1, name: "millisecond" };
  }
  if (
    normalized === "s" ||
    normalized.startsWith("sec") ||
    normalized.startsWith("second")
  ) {
    return { milliseconds: 1_000, name: "second" };
  }
  if (
    normalized === "m" ||
    normalized.startsWith("min")
  ) {
    return { milliseconds: 60_000, name: "minute" };
  }
  if (
    normalized === "h" ||
    normalized.startsWith("hr") ||
    normalized.startsWith("hour")
  ) {
    return { milliseconds: 3_600_000, name: "hour" };
  }
  if (normalized === "d" || normalized.startsWith("day")) {
    return { milliseconds: 86_400_000, name: "day" };
  }
  if (
    normalized === "w" ||
    normalized.startsWith("wk") ||
    normalized.startsWith("week")
  ) {
    return { milliseconds: 604_800_000, name: "week" };
  }
  if (
    normalized === "mo" ||
    normalized === "mos" ||
    normalized.startsWith("month")
  ) {
    return { milliseconds: 30 * 86_400_000, name: "month" };
  }
  if (
    normalized === "y" ||
    normalized.startsWith("yr") ||
    normalized.startsWith("year")
  ) {
    return { milliseconds: 365 * 86_400_000, name: "year" };
  }

  return undefined;
}

async function handleTimeoutRequest(message: Message): Promise<void> {
  const targetUsers = [...message.mentions.users.values()].filter(
    (user) =>
      !user.bot &&
      user.id !== message.author.id &&
      user.id !== message.client.user?.id,
  );
  if (targetUsers.length !== 1) {
    await sendStoredReply(
      message,
      "mention one person so i know who you mean",
    );
    return;
  }

  const durationMatches = [...message.content.matchAll(TIMEOUT_DURATION)];
  if (durationMatches.length === 0) {
    await sendStoredReply(
      message,
      "tell me how long too like 10 minutes or 2 days",
    );
    return;
  }
  if (durationMatches.length > 1) {
    const betweenDurations = durationMatches.slice(1).every((match, index) => {
      const previous = durationMatches[index];
      const previousEnd = (previous.index ?? 0) + previous[0].length;
      return /^(?:\s*(?:and|,|\+)?\s*)$/i.test(
        message.content.slice(previousEnd, match.index ?? previousEnd),
      );
    });
    if (!betweenDurations) {
      await sendStoredReply(
        message,
        "make the timeout length clear like 1 hour or 30 minutes",
      );
      return;
    }
  }

  const durations: Array<{ amount: number; name: string; milliseconds: number }> =
    [];
  for (const match of durationMatches) {
    const amount = parseDurationNumber(match[1]);
    const unit = durationUnit(match[2]);
    if (amount === undefined || !unit) {
      await sendStoredReply(message, "tell me a clear timeout length");
      return;
    }
    const milliseconds = amount * unit.milliseconds;
    if (!Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(milliseconds)) {
      await sendStoredReply(message, "the timeout needs to be at least one second");
      return;
    }
    durations.push({ amount, name: unit.name, milliseconds });
  }

  const durationMs = durations.reduce(
    (total, duration) => total + duration.milliseconds,
    0,
  );

  if (
    !Number.isSafeInteger(durationMs) ||
    durationMs < 1_000
  ) {
    await sendStoredReply(message, "the timeout needs to be at least one second");
    return;
  }
  if (durationMs > MAX_DISCORD_TIMEOUT_MS) {
    await sendStoredReply(message, "discord timeouts can only last up to 28 days");
    return;
  }

  const targetId = targetUsers[0].id;

  const guild = message.guild;
  if (!guild) {
    await sendStoredReply(message, "i can only timeout someone inside a server");
    return;
  }

  if (!message.member?.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    await sendStoredReply(message, "you need timeout members permission to do that");
    return;
  }

  const botMember =
    guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!botMember?.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    await sendStoredReply(
      message,
      "mack needs timeout members permission from the server too",
    );
    return;
  }

  const targetMember = await guild.members.fetch(targetId).catch(() => null);
  if (!targetMember) {
    await sendStoredReply(message, "i couldnt find that person in this server");
    return;
  }
  if (!targetMember.moderatable) {
    await sendStoredReply(
      message,
      "i cant timeout them check their role and the server owner permissions",
    );
    return;
  }

  try {
    await targetMember.timeout(
      durationMs,
      "Requested by Mack's authorized timeout controller",
    );
  } catch (err) {
    logger.warn(
      { err, guildId: message.guildId, targetId },
      "Mack could not apply the requested timeout",
    );
    await sendStoredReply(
      message,
      "i couldnt apply it check my role and timeout members permission",
    );
    return;
  }

  const durationText = durations
    .map(
      (duration) =>
        `${duration.amount} ${duration.name}${duration.amount === 1 ? "" : "s"}`,
    )
    .join(" and ");
  await sendStoredReply(message, `done i timed them out for ${durationText}`);
}

async function handleUntimeoutRequest(message: Message): Promise<void> {
  const targetUsers = [...message.mentions.users.values()].filter(
    (user) =>
      !user.bot &&
      user.id !== message.author.id &&
      user.id !== message.client.user?.id,
  );
  if (targetUsers.length !== 1) {
    await sendStoredReply(
      message,
      "mention one person so i know whose timeout to remove",
    );
    return;
  }

  const guild = message.guild;
  if (!guild) {
    await sendStoredReply(message, "i can only remove a timeout inside a server");
    return;
  }

  if (!message.member?.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    await sendStoredReply(
      message,
      "you need timeout members permission to remove a timeout",
    );
    return;
  }

  const botMember =
    guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!botMember?.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    await sendStoredReply(
      message,
      "mack needs timeout members permission from the server too",
    );
    return;
  }

  const targetId = targetUsers[0].id;
  const targetMember = await guild.members.fetch(targetId).catch(() => null);
  if (!targetMember) {
    await sendStoredReply(message, "i couldnt find that person in this server");
    return;
  }
  if (!targetMember.moderatable) {
    await sendStoredReply(
      message,
      "i cant remove their timeout check their role and the server owner permissions",
    );
    return;
  }
  if (!targetMember.isCommunicationDisabled()) {
    await sendStoredReply(message, "they dont have an active timeout right now");
    return;
  }

  try {
    await targetMember.timeout(
      null,
      "Requested by Mack's authorized timeout controller",
    );
  } catch (err) {
    logger.warn(
      { err, guildId: message.guildId, targetId },
      "Mack could not remove the requested timeout",
    );
    await sendStoredReply(
      message,
      "i couldnt remove it check my role and timeout members permission",
    );
    return;
  }

  await sendStoredReply(message, "done i took their timeout off");
}

async function handleMessage(message: Message): Promise<void> {
  const imageAttachments = [...message.attachments.values()]
    .filter((attachment) => {
      if (!attachment.contentType?.startsWith("image/") || attachment.size > 8_000_000) {
        return false;
      }

      try {
        const url = new URL(attachment.url);
        return (
          url.protocol === "https:" &&
          ["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname)
        );
      } catch {
        return false;
      }
    })
    .slice(0, 4)
    .map((attachment) => attachment.url);
  const hasAttachment = message.attachments.size > 0 || message.stickers.size > 0;
  if (
    !message.guildId ||
    message.author.bot ||
    message.webhookId ||
    (message.content.trim().length === 0 && !hasAttachment)
  ) {
    return;
  }

  if (!(await isGuildActive(message.guildId))) return;

  const content =
    message.content.trim().slice(0, 4000) ||
    (imageAttachments.length > 0
      ? "shared an image"
      : message.attachments.size > 0
        ? "shared a file"
        : "sent a sticker");
  await saveMemory({
    id: message.id,
    guildId: message.guildId,
    channelId: message.channelId,
    authorId: message.author.id,
    authorName: message.member?.displayName ?? message.author.username,
    role: "user",
    content,
    createdAt: message.createdAt,
  });

  if (message.author.id === TIMEOUT_CONTROLLER_ID) {
    if (UNTIMEOUT_COMMAND_PREFIX.test(content)) {
      await handleUntimeoutRequest(message);
      return;
    }
    if (TIMEOUT_COMMAND_PREFIX.test(content)) {
      await handleTimeoutRequest(message);
      return;
    }
  }

  const pingTarget = [...message.mentions.users.values()].find(
    (user) => !user.bot && user.id !== message.client.user?.id,
  );
  const memory = await loadMemory(
    message.guildId,
    message.channelId,
    message.id,
    content,
  );
  const videoContext = await getVideoContext(content);
  const replyResult = await createReply(
    message.author.id,
    message.member?.displayName ?? message.author.username,
    content,
    memory,
    imageAttachments,
    videoContext,
    Boolean(pingTarget),
  );

  if (!(await isGuildActive(message.guildId))) return;

  if (pingTarget && !replyResult.negativeMention) {
    const repeatedPing = Array.from(
      { length: 4 },
      () => `<@${pingTarget.id}>`,
    ).join(" ");
    const wakeReply = `${repeatedPing} wakey wakey stop sleeping`;
    const sent = await message.reply({
      content: wakeReply,
      allowedMentions: { users: [pingTarget.id], parse: [] },
    });
    await storeSentMessage(message, sent.id, wakeReply);
    return;
  }

  for (const [index, reply] of replyResult.messages.entries()) {
    if (index > 0) {
      await new Promise((resolve) => setTimeout(resolve, 650));
    }

    const sent = await message.reply({
      content: reply,
      allowedMentions: { parse: [] },
    });
    await storeSentMessage(message, sent.id, reply);
  }
}

function enqueueMessage(message: Message): void {
  const key = message.channelId;
  const previous = channelQueues.get(key) ?? Promise.resolve();
  const current = previous
    .then(() => handleMessage(message))
    .catch((err: unknown) => {
      logger.error(
        { err, guildId: message.guildId, channelId: message.channelId },
        "Could not process a Discord message",
      );
    });

  channelQueues.set(key, current);
  void current.then(() => {
    if (channelQueues.get(key) === current) {
      channelQueues.delete(key);
    }
  });
}

export async function startMackBot(): Promise<void> {
  const token = process.env["DISCORD_BOT_TOKEN"];
  if (!token) {
    logger.warn("DISCORD_BOT_TOKEN is not configured; Mack is not connected");
    return;
  }

  if (!process.env["OPENROUTER_API_KEY"]) {
    logger.warn("OPENROUTER_API_KEY is not configured; Mack cannot reply");
    return;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once(Events.ClientReady, (readyClient) => {
    logger.info(
      { botId: readyClient.user.id, guildCount: readyClient.guilds.cache.size },
      "Mack Thicklin connected to Discord",
    );
    for (const guild of readyClient.guilds.cache.values()) {
      void registerCommands(guild);
    }
  });

  client.on(Events.GuildCreate, (guild) => {
    void registerCommands(guild);
  });

  client.on(Events.MessageCreate, enqueueMessage);

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand() || !interaction.guildId) return;

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: "only server admins can change mack",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.commandName === "activate") {
      await setGuildActive(interaction.guildId, true);
      await interaction.reply({
        content: "mack is on now",
        flags: MessageFlags.Ephemeral,
      });
    } else if (interaction.commandName === "deactivate") {
      await setGuildActive(interaction.guildId, false);
      await interaction.reply({
        content: "mack is off and his memory is still here",
        flags: MessageFlags.Ephemeral,
      });
    }
  });

  client.on(Events.Error, (err) => {
    logger.error({ err }, "Discord client error");
  });

  await client.login(token);
}
