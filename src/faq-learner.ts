import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { type Client, TextChannel, EmbedBuilder } from 'discord.js';
import type { AppConfig } from './config';
import Groq from 'groq-sdk';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Track bot answers awaiting resolution: messageId -> { question, answer, guildId, channelId, askerID }
interface PendingAnswer {
  question: string;
  answer: string;
  guildId: string;
  channelId: string;
  askerId: string;
  timestamp: number;
}

const pendingAnswers = new Map<string, PendingAnswer>();
const RESOLVED_WINDOW_MS = 30 * 60 * 1000; // 30 minutes to confirm

// Cleanup stale pending answers
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of pendingAnswers) {
    if (now - val.timestamp > RESOLVED_WINDOW_MS) pendingAnswers.delete(key);
  }
}, 10 * 60 * 1000);

/** Track that the bot answered a question */
export function trackAnswer(
  botMessageId: string,
  question: string,
  answer: string,
  guildId: string,
  channelId: string,
  askerId: string
): void {
  pendingAnswers.set(channelId + ':' + askerId, {
    question,
    answer,
    guildId,
    channelId,
    askerId,
    timestamp: Date.now(),
  });
}

/** Check if a follow-up message indicates the question was resolved */
export async function checkResolved(
  content: string,
  authorId: string,
  channelId: string
): Promise<PendingAnswer | null> {
  const key = channelId + ':' + authorId;
  const pending = pendingAnswers.get(key);
  if (!pending) return null;

  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: 'Does this message indicate the user\'s question was answered/resolved? Look for: thanks, got it, that worked, perfect, solved, makes sense, appreciate it, etc. Reply "yes" or "no" only.',
        },
        { role: 'user', content },
      ],
      temperature: 0,
      max_tokens: 3,
    });
    const result = (completion.choices[0]?.message?.content || 'no').trim().toLowerCase();

    if (result === 'yes') {
      pendingAnswers.delete(key);
      return pending;
    }
  } catch (err) {
    console.error('[faq-learner] resolve check failed:', err);
  }

  return null;
}

/** Check if a Q&A is novel (not already covered in FAQ) */
async function isNovelQuestion(config: AppConfig, question: string): Promise<boolean> {
  const existingQs = config.faq.map((f) => f.q).join('\n');

  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: `Existing FAQ questions:\n${existingQs}\n\nIs the following question substantially different from ALL existing FAQ entries? Reply "yes" if it's a new topic not covered, "no" if it's already covered or too similar.`,
        },
        { role: 'user', content: question },
      ],
      temperature: 0,
      max_tokens: 3,
    });
    return (completion.choices[0]?.message?.content || 'no').trim().toLowerCase() === 'yes';
  } catch {
    return false;
  }
}

/** Generate a clean FAQ entry from a resolved Q&A */
async function generateFaqEntry(
  config: AppConfig,
  question: string,
  answer: string
): Promise<{ q: string; a: string } | null> {
  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: `You are writing FAQ entries for ${config.app.name}. Given a user question and the answer that resolved it, produce a clean FAQ pair. The question should be general (not user-specific). The answer should be concise (1-2 sentences). Reply in exactly this format:\nQ: <question>\nA: <answer>`,
        },
        {
          role: 'user',
          content: `User asked: ${question}\nAnswer that resolved it: ${answer}`,
        },
      ],
      temperature: 0.3,
      max_tokens: 150,
    });

    const text = completion.choices[0]?.message?.content || '';
    const qMatch = text.match(/Q:\s*(.+)/);
    const aMatch = text.match(/A:\s*(.+)/);

    if (qMatch && aMatch) {
      return { q: qMatch[1].trim(), a: aMatch[1].trim() };
    }
  } catch (err) {
    console.error('[faq-learner] generation failed:', err);
  }
  return null;
}

/** Find the config file path for a guild */
function findConfigPath(guildId: string): string | null {
  const configDir = join(process.cwd(), 'configs');
  for (const file of readdirSync(configDir)) {
    if (!file.endsWith('.json')) continue;
    const content = JSON.parse(readFileSync(join(configDir, file), 'utf-8'));
    if (content.guild_id === guildId) return join(configDir, file);
  }
  return null;
}

/** Add a resolved Q&A to FAQ config and update the channel */
export async function learnFaq(
  client: Client,
  config: AppConfig,
  question: string,
  answer: string
): Promise<void> {
  // Check novelty
  const novel = await isNovelQuestion(config, question);
  if (!novel) {
    console.log(`[faq-learner:${config.app.name}] question already covered in FAQ, skipping`);
    return;
  }

  // Generate clean entry
  const entry = await generateFaqEntry(config, question, answer);
  if (!entry) return;

  // Add to config
  config.faq.push(entry);

  // Save to file
  const configPath = findConfigPath(config.guild_id);
  if (configPath) {
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    console.log(`[faq-learner:${config.app.name}] saved new FAQ: "${entry.q}"`);
  }

  // Update #faq channel
  await updateFaqChannel(client, config);
}

/** Rebuild and post the FAQ embed in #faq channel */
export async function updateFaqChannel(
  client: Client,
  config: AppConfig
): Promise<void> {
  if (!config.channels.faq) return;

  try {
    const channel = await client.channels.fetch(config.channels.faq);
    if (!(channel instanceof TextChannel)) return;

    // Delete old messages (bot's own)
    const messages = await channel.messages.fetch({ limit: 10 });
    const botMessages = messages.filter((m) => m.author.id === client.user!.id);
    for (const msg of botMessages.values()) {
      await msg.delete().catch(() => {});
    }

    // Post new FAQ embed
    const embed = buildFaqEmbed(config);
    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error(`[faq-learner:${config.app.name}] channel update failed:`, err);
  }
}

/** Build a styled FAQ embed */
export function buildFaqEmbed(config: AppConfig): EmbedBuilder {
  const color = config.app.brand_color || 0x5865f2;
  const embed = new EmbedBuilder()
    .setTitle(`${config.app.name} -- FAQ`)
    .setColor(color)
    .setFooter({ text: "Don't see your question? Ask in #help." });

  if (config.app.icon_url) {
    embed.setThumbnail(config.app.icon_url);
  }

  for (const faq of config.faq.slice(0, 25)) { // Discord max 25 fields
    embed.addFields({ name: faq.q, value: faq.a });
  }

  return embed;
}

/** Build a styled rules embed */
export function buildRulesEmbed(config: AppConfig): EmbedBuilder {
  const color = config.app.brand_color || 0x57f287;
  const embed = new EmbedBuilder()
    .setTitle(`Welcome to ${config.app.name}`)
    .setDescription(`${config.app.tagline}\n\nWe're glad you're here. Please read the rules below.`)
    .setColor(color)
    .addFields(
      { name: '1. Be respectful', value: 'No harassment, hate speech, or personal attacks. Ever.' },
      { name: '2. Stay on topic', value: 'Use the right channels. Off-topic has its own room.' },
      { name: '3. No spam or self-promo', value: 'Share your work in #show-and-tell, not everywhere.' },
      { name: '4. Search before asking', value: 'Check #faq and #help first.' },
      { name: '5. Report bugs properly', value: 'Use #bug-reports with steps to reproduce.' },
      { name: '6. No unsolicited DMs', value: "Don't message members or staff without permission." },
      { name: '7. English only', value: 'In public channels.' },
      { name: '8. Staff decisions are final', value: 'Disagree? DM a moderator calmly.' },
    )
    .setFooter({ text: 'React with a checkmark below to agree and get access.' });

  if (config.app.icon_url) {
    embed.setThumbnail(config.app.icon_url);
  }

  return embed;
}
