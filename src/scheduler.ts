import { type Client, TextChannel } from 'discord.js';
import type { AppConfig } from './config';
import { generateMorningGreeting, generateLunchJoke } from './ai';
import { sendHumanized, randomOffset } from './humanize';

const timers: ReturnType<typeof setTimeout>[] = [];

function msUntilHour(hour: number, offsetMinutes: number): number {
  const now = new Date();
  const target = new Date(now);
  target.setUTCHours(hour, Math.floor(offsetMinutes + 30), 0, 0);
  if (target <= now) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime() - now.getTime();
}

function scheduleMorning(client: Client, config: AppConfig): void {
  const offset = randomOffset(15);
  const delay = msUntilHour(config.personality.morning_hour, offset);

  const timer = setTimeout(async () => {
    try {
      const channel = await client.channels.fetch(config.channels.general);
      if (channel instanceof TextChannel) {
        const greeting = await generateMorningGreeting(config);
        await sendHumanized(channel, greeting);
      }
    } catch (err) {
      console.error(`[scheduler:${config.app.name}] morning greeting failed:`, err);
    }
    scheduleMorning(client, config);
  }, delay);
  timers.push(timer);

  const hours = Math.floor(delay / 3600000);
  const mins = Math.floor((delay % 3600000) / 60000);
  console.log(`[scheduler:${config.app.name}] morning greeting in ${hours}h ${mins}m`);
}

function scheduleLunch(client: Client, config: AppConfig): void {
  const offset = randomOffset(30);
  const delay = msUntilHour(config.personality.lunch_hour, offset);

  const timer = setTimeout(async () => {
    try {
      const channel = await client.channels.fetch(config.channels.general);
      if (channel instanceof TextChannel) {
        const joke = await generateLunchJoke(config);
        await sendHumanized(channel, joke);
      }
    } catch (err) {
      console.error(`[scheduler:${config.app.name}] lunch joke failed:`, err);
    }
    scheduleLunch(client, config);
  }, delay);
  timers.push(timer);

  const hours = Math.floor(delay / 3600000);
  const mins = Math.floor((delay % 3600000) / 60000);
  console.log(`[scheduler:${config.app.name}] lunch joke in ${hours}h ${mins}m`);
}

export function startScheduler(client: Client, config: AppConfig): void {
  scheduleMorning(client, config);
  scheduleLunch(client, config);
}

export function startAllSchedulers(client: Client, configs: Map<string, AppConfig>): void {
  for (const config of configs.values()) {
    startScheduler(client, config);
  }
  console.log(`[scheduler] started for ${configs.size} servers`);
}

export function stopScheduler(): void {
  for (const t of timers) clearTimeout(t);
  timers.length = 0;
}
