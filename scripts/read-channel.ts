/**
 * Reads recent messages from a configured app's Discord channel.
 * Usage: bun run scripts/read-channel.ts --app <app> --channel <key> [--limit N]
 */
import { loadConfig } from '../src/config';

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('DISCORD_BOT_TOKEN not set');

function arg(flag: string, fallback?: string): string {
  const i = process.argv.indexOf(flag);
  if (i === -1 || !process.argv[i + 1]) {
    if (fallback !== undefined) return fallback;
    throw new Error(`${flag} <value> required`);
  }
  return process.argv[i + 1]!;
}

const app = arg('--app');
const channelKey = arg('--channel');
const limit = arg('--limit', '10');

const config = loadConfig(`./configs/${app}.json`);
const channelId = config.channels[channelKey];
if (!channelId) {
  throw new Error(
    `Unknown channel "${channelKey}" for ${app}. Available: ${Object.keys(config.channels).join(', ')}`
  );
}

const res = await fetch(
  `https://discord.com/api/v10/channels/${channelId}/messages?limit=${limit}`,
  { headers: { Authorization: `Bot ${BOT_TOKEN}` } }
);

if (!res.ok) {
  console.error(`[read-channel] ${res.status}: ${await res.text()}`);
  process.exit(1);
}

const messages = (await res.json()) as any[];
for (const m of messages.reverse()) {
  console.log(`[${m.timestamp}] ${m.author.username}: ${m.content}`);
}
