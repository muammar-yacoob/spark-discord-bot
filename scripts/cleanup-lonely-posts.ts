/**
 * Deletes Alex's scheduled posts that landed in an empty room.
 *
 * Scheduled greetings and replies to people both go out through
 * `channel.send()`, so nothing on the message itself says which is which.
 * "Lonely" is the usable signal: a scheduled post sits in a stretch of channel
 * with no human either side of it, while a reply always has the message it was
 * answering right before it. So a bot message is a deletion candidate only when
 * no non-bot message appears within the window on either side.
 *
 * Dry run by default -- deletion is not reversible, and the heuristic deserves
 * a read-through on your own channels before it is allowed to act.
 *
 * Usage:
 *   bun run scripts/cleanup-lonely-posts.ts                       # every config, dry run
 *   bun run scripts/cleanup-lonely-posts.ts --config ./configs/spark-ads.json
 *   bun run scripts/cleanup-lonely-posts.ts --window 4            # hours, default 2
 *   bun run scripts/cleanup-lonely-posts.ts --apply               # actually delete
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('DISCORD_BOT_TOKEN not set');

const argv = process.argv;
function flag(name: string): string | null {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 ? argv[i + 1] ?? null : null;
}

const APPLY = argv.includes('--apply');
const WINDOW_MS = Number(flag('window') ?? 2) * 3600 * 1000;
const ONE_CONFIG = flag('config');

const BASE = 'https://discord.com/api/v10';

async function api(path: string, method = 'GET'): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
  });
  if (res.status === 429) {
    const retry = Number(res.headers.get('retry-after') || '2');
    await Bun.sleep(retry * 1000 + 500);
    return api(path, method);
  }
  if (!res.ok) {
    console.error(`  [api] ${method} ${path} -> ${res.status}: ${await res.text()}`);
    return null;
  }
  return res.status === 204 ? {} : res.json();
}

const me = await api('/users/@me');
if (!me) throw new Error('could not identify the bot user');
console.log(`Bot: ${me.username} (${me.id})`);
console.log(APPLY ? 'Mode: APPLY -- messages will be deleted' : 'Mode: dry run');
console.log(`Window: ${WINDOW_MS / 3600000}h either side\n`);

/** Every message in a channel, newest first, walked back through pagination. */
async function allMessages(channelId: string): Promise<any[]> {
  const out: any[] = [];
  let before: string | null = null;
  for (;;) {
    const query = `?limit=100${before ? `&before=${before}` : ''}`;
    const batch = await api(`/channels/${channelId}/messages${query}`);
    if (!batch || batch.length === 0) break;
    out.push(...batch);
    before = batch[batch.length - 1].id;
    if (batch.length < 100) break;
  }
  return out;
}

const configDir = join(import.meta.dir, '..', 'configs');
const configPaths = ONE_CONFIG
  ? [ONE_CONFIG]
  : readdirSync(configDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => join(configDir, f));

let totalFound = 0;
let totalDeleted = 0;

for (const configPath of configPaths) {
  const config = JSON.parse(readFileSync(configPath, 'utf-8'));
  if (!config.guild_id || !config.channels || Object.keys(config.channels).length === 0) {
    console.log(`- ${configPath}: no guild or channels yet, skipping`);
    continue;
  }

  console.log(`=== ${config.app.name} (${config.guild_id}) ===`);

  // Every text channel in the guild, not just the ones named in the config:
  // the ask was any channel, and scheduled posts have moved before.
  const channels = await api(`/guilds/${config.guild_id}/channels`);
  if (!channels) {
    console.log('  could not list channels\n');
    continue;
  }
  // Every text channel in the guild except the furniture ones. #rules, #faq,
  // #useful-links and #announcements are bot-authored by design and never have
  // a human posting in them, so every message in them looks lonely. The
  // useful-links post in particular is plain unpinned text -- shape alone would
  // not save it.
  // Matched by name as well as by id: a guild that was re-run through
  // setup-server.ts has fresh channel ids, and a config that was not saved
  // afterwards points at channels that no longer exist -- which silently turns
  // the id check into a no-op and puts #faq back on the deletion list.
  const furnitureIds = new Set(
    [
      config.channels.rules,
      config.channels.faq,
      config.channels.links,
      config.channels.announcements,
      config.channels.bot_logs,
    ].filter(Boolean)
  );
  const furnitureNames = new Set(['rules', 'faq', 'useful-links', 'announcements', 'bot-logs']);
  const textChannels = channels.filter(
    (c: any) => c.type === 0 && !furnitureIds.has(c.id) && !furnitureNames.has(c.name)
  );

  for (const channel of textChannels) {
    const messages = await allMessages(channel.id);
    if (messages.length === 0) continue;

    const humanTimes = messages
      .filter((m: any) => !m.author.bot)
      .map((m: any) => Date.parse(m.timestamp));

    const lonely = messages.filter((m: any) => {
      if (m.author.id !== me.id) return false;
      // The furniture setup-server.ts puts up -- rules, FAQ, useful-links -- is
      // bot-authored and sits in channels no human ever posts in, so it matches
      // "lonely" perfectly. It is also the last thing anyone wants deleted:
      // dropping the rules embed silently breaks the reaction-role gate that
      // grants Member. Scheduled chatter is plain unpinned one-liners, so
      // pinned, embedded and the known rules message are all out.
      if (m.id === config.rules_message_id) return false;
      if (m.pinned) return false;
      if (m.embeds?.length) return false;
      // Scheduled chatter is always a line of text. Anything with no content is
      // something else -- a pin notice, a join message, an attachment-only post
      // -- and deleting what we cannot even print is not a cleanup.
      if (typeof m.content !== 'string' || m.content.trim() === '') return false;
      if (m.type !== 0 && m.type !== 19) return false;
      const t = Date.parse(m.timestamp);
      return !humanTimes.some((h: number) => Math.abs(h - t) <= WINDOW_MS);
    });

    if (lonely.length === 0) continue;
    totalFound += lonely.length;
    console.log(`  #${channel.name}: ${lonely.length} lonely post(s)`);

    for (const m of lonely) {
      const preview = m.content.replace(/\s+/g, ' ').slice(0, 70);
      if (APPLY) {
        const ok = await api(`/channels/${channel.id}/messages/${m.id}`, 'DELETE');
        if (ok) totalDeleted++;
        console.log(`    ${ok ? 'deleted' : 'FAILED '} ${m.timestamp.slice(0, 16)}  ${preview}`);
        // Deletes are rate limited harder than reads; pace them.
        await Bun.sleep(400);
      } else {
        console.log(`    would delete ${m.timestamp.slice(0, 16)}  ${preview}`);
      }
    }
  }
  console.log('');
}

console.log(`Found ${totalFound} lonely post(s).`);
if (APPLY) {
  console.log(`Deleted ${totalDeleted}.`);
} else {
  console.log('Dry run -- nothing deleted. Re-run with --apply once the list looks right.');
}
