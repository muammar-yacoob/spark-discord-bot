import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { type Client, TextChannel, type Message } from 'discord.js';
import type { AppConfig } from './config';
import { generateResponse } from './ai';
import { findRelevantContext } from './context';
import { sendHumanized } from './humanize';

const TIMESTAMP_FILE = join(process.cwd(), '.last_online');
const MAX_CATCHUP_MESSAGES = 30;

/** Save shutdown timestamp */
export function saveShutdownTime(): void {
  writeFileSync(TIMESTAMP_FILE, Date.now().toString());
}

/** Get last shutdown time, or 1 hour ago as fallback */
function getLastOnlineTime(): number {
  if (!existsSync(TIMESTAMP_FILE)) {
    return Date.now() - 60 * 60 * 1000; // 1 hour ago
  }
  return Number(readFileSync(TIMESTAMP_FILE, 'utf-8').trim()) || Date.now() - 60 * 60 * 1000;
}

/** Find messages in #help that have no bot reply after them */
async function findUnanswered(
  channel: TextChannel,
  botId: string,
  since: number
): Promise<Message[]> {
  const messages = await channel.messages.fetch({ limit: MAX_CATCHUP_MESSAGES });
  const sorted = [...messages.values()]
    .filter((m) => m.createdTimestamp > since)
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  const unanswered: Message[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const msg = sorted[i];
    if (msg.author.bot) continue;
    if (!msg.content.includes('?')) continue;

    // Check if the bot replied after this message
    const hasReply = sorted
      .slice(i + 1)
      .some((m) => m.author.id === botId);

    if (!hasReply) {
      unanswered.push(msg);
    }
  }

  return unanswered;
}

/** Run catch-up for a single guild */
async function catchUpGuild(
  client: Client,
  config: AppConfig,
  since: number
): Promise<void> {
  if (!config.channels.help) return;

  try {
    const channel = await client.channels.fetch(config.channels.help);
    if (!(channel instanceof TextChannel)) return;

    const unanswered = await findUnanswered(channel, client.user!.id, since);
    if (unanswered.length === 0) {
      console.log(`[catchup:${config.app.name}] no unanswered questions`);
      return;
    }

    console.log(`[catchup:${config.app.name}] found ${unanswered.length} unanswered question(s)`);

    for (const msg of unanswered) {
      const content = msg.content.replace(/<@!?\d+>/g, '').trim();
      if (!content) continue;

      const context = await findRelevantContext(channel, content);
      const response = await generateResponse(config, content, context);
      await sendHumanized(channel, response);
      console.log(`[catchup:${config.app.name}] answered: "${content.slice(0, 60)}..."`);
    }
  } catch (err) {
    console.error(`[catchup:${config.app.name}] failed:`, err);
  }
}

/** Run catch-up across all guilds */
export async function runCatchUp(
  client: Client,
  configs: Map<string, AppConfig>
): Promise<void> {
  const since = getLastOnlineTime();
  const offlineMinutes = Math.round((Date.now() - since) / 60000);
  console.log(`[catchup] bot was offline for ~${offlineMinutes} minutes, scanning for unanswered questions...`);

  for (const config of configs.values()) {
    await catchUpGuild(client, config, since);
  }

  console.log('[catchup] done');
}
