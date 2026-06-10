import {
  Client,
  GatewayIntentBits,
  Partials,
  TextChannel,
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  type User,
  type PartialUser,
} from 'discord.js';
import { loadConfig, loadAllConfigs, type AppConfig } from './config';
import { generateResponse, classifyIntent, assessConfidence } from './ai';
import { findRelevantContext } from './context';
import { sendHumanized } from './humanize';
import { moderateMessage } from './moderation';
import { startAllSchedulers, startScheduler, stopScheduler } from './scheduler';
import { runCatchUp, saveShutdownTime } from './catchup';
import { trackAnswer, checkResolved, learnFaq } from './faq-learner';

// --- Load configs ---
// Multi-guild: --configs ./configs/   (directory)
// Single-guild: --config ./configs/sparkpay.json   (file)
const configsFlag = process.argv.indexOf('--configs');
const configFlag = process.argv.indexOf('--config');

let guilds: Map<string, AppConfig>;

if (configsFlag !== -1) {
  guilds = loadAllConfigs(process.argv[configsFlag + 1]);
} else if (configFlag !== -1) {
  const cfg = loadConfig(process.argv[configFlag + 1]);
  guilds = new Map([[cfg.guild_id, cfg]]);
} else if (process.env.BOT_CONFIG_PATH) {
  const cfg = loadConfig();
  guilds = new Map([[cfg.guild_id, cfg]]);
} else {
  // Default: load all from ./configs/
  guilds = loadAllConfigs('./configs');
}

if (guilds.size === 0) {
  console.error('[bot] no configs loaded');
  process.exit(1);
}

console.log(`[bot] loaded ${guilds.size} server config(s)`);

/** Get the config for a guild, or null if not managed */
function getConfig(guildId: string | null | undefined): AppConfig | null {
  if (!guildId) return null;
  return guilds.get(guildId) || null;
}

// --- Client ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Reaction, Partials.User],
});

// --- Reaction role gate ---
client.on('messageReactionAdd', async (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser, _details) => {
  if (user.bot) return;
  if (reaction.partial) reaction = await reaction.fetch();
  if (user.partial) user = await user.fetch();

  const guildId = reaction.message.guild?.id;
  const config = getConfig(guildId);
  if (!config) return;

  if (
    reaction.message.id !== config.rules_message_id ||
    reaction.emoji.name !== '\u2705'
  ) return;

  try {
    const guild = await client.guilds.fetch(config.guild_id);
    const member = await guild.members.fetch(user.id);

    if (!member.roles.cache.has(config.roles.member)) {
      await member.roles.add(config.roles.member);
      console.log(`[roles:${config.app.name}] granted Member to ${user.tag}`);

      try {
        await user.send(
          `welcome to ${config.app.name}! you now have access to all channels. if you need help, head to #help. enjoy!`
        );
      } catch {
        // DMs might be disabled
      }
    }
  } catch (err) {
    console.error(`[roles:${config.app.name}] failed to assign member role:`, err);
  }
});

// --- Remove role on un-react ---
client.on('messageReactionRemove', async (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser, _details) => {
  if (user.bot) return;
  if (reaction.partial) reaction = await reaction.fetch();

  const guildId = reaction.message.guild?.id;
  const config = getConfig(guildId);
  if (!config) return;

  if (
    reaction.message.id !== config.rules_message_id ||
    reaction.emoji.name !== '\u2705'
  ) return;

  try {
    const guild = await client.guilds.fetch(config.guild_id);
    const member = await guild.members.fetch(user.id);
    if (member.roles.cache.has(config.roles.member)) {
      await member.roles.remove(config.roles.member);
      console.log(`[roles:${config.app.name}] removed Member from ${user.tag}`);
    }
  } catch (err) {
    console.error(`[roles:${config.app.name}] failed to remove member role:`, err);
  }
});

// --- Conversation tracking ---
const activeConversations = new Map<string, number>();
const CONVERSATION_WINDOW_MS = 3 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of activeConversations) {
    if (now - ts > CONVERSATION_WINDOW_MS) activeConversations.delete(key);
  }
}, 5 * 60 * 1000);

// --- Message handler ---
client.on('messageCreate', async (message: Message) => {
  try {
    if (message.author.bot) return;
    if (!message.guild) return;

    const config = getConfig(message.guild.id);
    if (!config) return;
    if (message.channel.id === config.channels.rules) return;

    // Moderation
    const moderated = await moderateMessage(message, config);
    if (moderated) return;

    // Check if this is a "resolved" confirmation (thanks, got it, etc.)
    const resolved = await checkResolved(
      message.content,
      message.author.id,
      message.channel.id
    );
    if (resolved) {
      await message.react('\u2705');
      await learnFaq(client, config, resolved.question, resolved.answer);
      return;
    }

    const mentioned = message.mentions.has(client.user!.id);
    const inHelp = message.channel.id === config.channels.help;
    const convoKey = `${message.channel.id}:${message.author.id}`;
    const lastInteraction = activeConversations.get(convoKey) || 0;
    const inActiveConvo = Date.now() - lastInteraction < CONVERSATION_WINDOW_MS;

    if (!mentioned && !inHelp && !inActiveConvo) return;
    if (inHelp && !mentioned && !inActiveConvo && !message.content.includes('?')) return;

    if (mentioned || inHelp) {
      activeConversations.set(convoKey, Date.now());
    }

    const content = message.content.replace(/<@!?\d+>/g, '').trim();
    if (!content) return;

    const intent = await classifyIntent(content);
    if (intent === 'ignore' && !mentioned) return;

    const channel = message.channel as TextChannel;

    // Escalate
    if (intent === 'escalate') {
      await sendHumanized(
        channel,
        "this one needs a human -- I've flagged it for the team. someone will get back to you soon."
      );
      await escalateToOwner(client, config, message.author.tag, channel.name, content, 'escalation');
      return;
    }

    // Generate response
    const context = await findRelevantContext(channel, content);
    const response = await generateResponse(config, content, context);

    // Confidence check for support/bug
    if (intent === 'support' || intent === 'bug') {
      const confident = await assessConfidence(config, content, response);
      if (!confident) {
        await sendHumanized(
          channel,
          `${response}\n\n(not 100% sure on this one -- I've pinged the team to double-check)`
        );
        await escalateToOwner(client, config, message.author.tag, channel.name, content, 'low-confidence answer');
        return;
      }
    }

    await sendHumanized(channel, response);
    activeConversations.set(convoKey, Date.now());

    // Track this answer for FAQ learning
    if (intent === 'support') {
      trackAnswer(
        message.id,
        content,
        response,
        message.guild!.id,
        message.channel.id,
        message.author.id
      );
    }

    if (intent === 'bug') {
      await escalateToOwner(client, config, message.author.tag, channel.name, content, 'bug report');
    }
  } catch (err) {
    console.error('[bot] message handler error:', err);
  }
});

// --- Escalation ---
async function escalateToOwner(
  bot: Client,
  cfg: AppConfig,
  userTag: string,
  channelName: string,
  content: string,
  type: string
): Promise<void> {
  const summary = content.slice(0, 300);
  const logLine = `**[${type}]** from ${userTag} in #${channelName}:\n> ${summary}`;

  try {
    const logChannel = await bot.channels.fetch(cfg.channels.bot_logs);
    if (logChannel instanceof TextChannel) {
      await logChannel.send(logLine);
    }
  } catch { /* silent */ }

  if (cfg.owner_id) {
    try {
      const owner = await bot.users.fetch(cfg.owner_id);
      await owner.send(
        `**[${cfg.app.name}]** ${type} needs attention:\n> ${summary}\n\nfrom: ${userTag} in #${channelName}`
      );
    } catch {
      console.error(`[escalate:${cfg.app.name}] could not DM owner`);
    }
  }
}

// --- New member join ---
client.on('guildMemberAdd', async (member) => {
  const config = getConfig(member.guild.id);
  if (!config) return;
  if (member.user.bot) return;

  try {
    const logChannel = await client.channels.fetch(config.channels.bot_logs);
    if (logChannel instanceof TextChannel) {
      await logChannel.send(`**[join]** ${member.user.tag} joined the server`);
    }
  } catch { /* silent */ }
});

// --- Ready ---
client.once('ready', async () => {
  console.log(`[bot] online as ${client.user?.tag}`);
  for (const cfg of guilds.values()) {
    console.log(`[bot] serving ${cfg.app.name} (${cfg.guild_id})`);
  }
  startAllSchedulers(client, guilds);

  // Catch up on unanswered questions from while we were offline
  await runCatchUp(client, guilds);
});

// --- Graceful shutdown ---
process.on('SIGINT', () => {
  console.log('[bot] shutting down...');
  saveShutdownTime();
  stopScheduler();
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  saveShutdownTime();
  stopScheduler();
  client.destroy();
  process.exit(0);
});

// --- Login ---
const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
  console.error('[bot] DISCORD_BOT_TOKEN is not set');
  process.exit(1);
}

client.login(token);
