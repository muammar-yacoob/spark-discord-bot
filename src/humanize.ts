import type { TextChannel } from 'discord.js';

/** Simulate human typing speed: ~40-80ms per character, capped at 8 seconds */
function typingDuration(text: string): number {
  const msPerChar = 40 + Math.random() * 40;
  return Math.min(text.length * msPerChar, 8000);
}

/** Random delay before responding (1-4 seconds) */
function thinkDelay(): number {
  return 1000 + Math.random() * 3000;
}

/** Send a message with realistic typing simulation */
export async function sendHumanized(
  channel: TextChannel,
  text: string
): Promise<void> {
  try {
    await sleep(thinkDelay());
    await channel.sendTyping().catch(() => {});
    await sleep(typingDuration(text));
    await channel.send(text);
  } catch (err) {
    console.error('[humanize] failed to send message:', err);
  }
}

/** Random offset in minutes around a target time */
export function randomOffset(maxMinutes: number): number {
  return (Math.random() * 2 - 1) * maxMinutes;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
