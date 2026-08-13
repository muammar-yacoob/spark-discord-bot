/**
 * Posts a message to a configured app's Discord channel via Alex's bot token.
 * Usage: bun run scripts/notify.ts --app <app> --channel <key> --message "..."
 */
import { loadConfig } from '../src/config';

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('DISCORD_BOT_TOKEN not set');

function arg(flag: string): string {
  const i = process.argv.indexOf(flag);
  if (i === -1 || !process.argv[i + 1]) throw new Error(`${flag} <value> required`);
  return process.argv[i + 1]!;
}

const app = arg('--app');
const channelKey = arg('--channel');
const message = arg('--message');

const config = loadConfig(`./configs/${app}.json`);
const channelId = config.channels[channelKey];
if (!channelId) {
  throw new Error(
    `Unknown channel "${channelKey}" for ${app}. Available: ${Object.keys(config.channels).join(', ')}`
  );
}

const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
  method: 'POST',
  headers: {
    Authorization: `Bot ${BOT_TOKEN}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ content: message }),
});

if (!res.ok) {
  console.error(`[notify] ${res.status}: ${await res.text()}`);
  process.exit(1);
}

console.log(`[notify] posted to ${app}#${channelKey}`);
