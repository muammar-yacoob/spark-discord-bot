import { type Message, TextChannel } from 'discord.js';
import type { AppConfig } from './config';

const CAPS_THRESHOLD = 0.7;
const MIN_LENGTH_FOR_CAPS = 10;
const REPEAT_WINDOW_MS = 5000;
const MAX_WARNINGS = 3;
const TIMEOUT_DURATION_MS = 10 * 60 * 1000; // 10 minutes
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // clean maps every 10 minutes
const STALE_MS = 30 * 60 * 1000; // entries older than 30 min are stale

// Track warnings per user (resets on restart -- fine for a lightweight bot)
const warnings = new Map<string, { count: number; lastAt: number }>();
const recentMessages = new Map<string, { content: string; timestamp: number }>();

// Periodic cleanup to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of recentMessages) {
    if (now - val.timestamp > STALE_MS) recentMessages.delete(key);
  }
  for (const [key, val] of warnings) {
    if (now - val.lastAt > STALE_MS) warnings.delete(key);
  }
}, CLEANUP_INTERVAL_MS);

export async function moderateMessage(
  message: Message,
  config: AppConfig
): Promise<boolean> {
  const content = message.content;
  const userId = message.author.id;
  let violation: string | null = null;

  // Check excessive caps
  if (content.length >= MIN_LENGTH_FOR_CAPS) {
    const caps = content.replace(/[^a-zA-Z]/g, '');
    const upperRatio = caps.length > 0
      ? caps.split('').filter((c) => c === c.toUpperCase()).length / caps.length
      : 0;
    if (upperRatio > CAPS_THRESHOLD) {
      violation = 'excessive caps';
    }
  }

  // Check duplicate/flood
  const recent = recentMessages.get(userId);
  if (
    recent &&
    recent.content === content &&
    Date.now() - recent.timestamp < REPEAT_WINDOW_MS
  ) {
    violation = 'duplicate message';
  }
  recentMessages.set(userId, { content, timestamp: Date.now() });

  if (!violation) return false;

  // Issue warning
  const prev = warnings.get(userId);
  const count = (prev?.count || 0) + 1;
  warnings.set(userId, { count, lastAt: Date.now() });

  try {
    if (count >= MAX_WARNINGS) {
      const member = await message.guild?.members.fetch(userId);
      if (member) {
        await member.timeout(TIMEOUT_DURATION_MS, `Auto-mod: ${count} warnings`);
        await message.reply(
          `you've been timed out for 10 minutes after ${count} warnings. please review the rules when you're back.`
        );
      }
      warnings.delete(userId);
    } else {
      await message.reply(
        `hey, easy on the ${violation}. warning ${count}/${MAX_WARNINGS}.`
      );
    }
  } catch (err) {
    console.error('[mod] action failed:', err);
  }

  // Log to bot-logs
  try {
    const logChannel = await message.client.channels.fetch(config.channels.bot_logs);
    if (logChannel instanceof TextChannel) {
      await logChannel.send(
        `**[mod]** ${message.author.tag} -- ${violation} in #${(message.channel as TextChannel).name} (warning ${count}/${MAX_WARNINGS})`
      );
    }
  } catch {
    // silent
  }

  return true;
}
