import { type Client, TextChannel } from 'discord.js';
import type { AppConfig } from './config';
import { generateMorningGreeting, generateLunchJoke } from './ai';
import { sendHumanized, randomOffset } from './humanize';
import { fetchListedCoupons, couponLine } from './promos';
import { firstFresh, recentBotLines } from './freshness';

const timers: ReturnType<typeof setTimeout>[] = [];

/** Default floor for scheduled chatter when a config doesn't set one. */
const DEFAULT_MIN_ONLINE = 5;

/**
 * How many humans are online right now.
 *
 * Read over REST with `withCounts` rather than from the member cache: the
 * client runs without the GuildPresences intent, so gateway presence data is
 * simply not there. Alex is always online and is in the count, so subtract it
 * -- otherwise an empty server reads as one person and the floor is off by one.
 */
async function humansOnline(client: Client, guildId: string): Promise<number | null> {
  try {
    const guild = await client.guilds.fetch({ guild: guildId, withCounts: true });
    const present = guild.approximatePresenceCount;
    if (typeof present !== 'number') return null;
    return Math.max(0, present - 1);
  } catch {
    return null;
  }
}

/**
 * Scheduled posts are for a room with people in it. A greeting to an empty
 * channel reads as a bot talking to itself, which is worse than silence.
 *
 * A failed count returns null and we stay quiet: if we can't tell whether
 * anyone is around, the safe assumption is that nobody is.
 */
async function roomIsAwake(
  client: Client,
  config: AppConfig,
  label: string
): Promise<boolean> {
  const floor = config.personality.min_online ?? DEFAULT_MIN_ONLINE;
  const online = await humansOnline(client, config.guild_id);
  if (online === null) {
    console.log(`[scheduler:${config.app.name}] ${label} skipped -- presence count unavailable`);
    return false;
  }
  if (online <= floor) {
    console.log(`[scheduler:${config.app.name}] ${label} skipped -- ${online} online, needs > ${floor}`);
    return false;
  }
  return true;
}

/**
 * Post one line into #general, if there is anything worth saying.
 *
 * The two-a-day cap is structural rather than a counter: there are exactly two
 * scheduled slots per server per day and this is the only thing that writes to
 * them, so the ceiling holds across restarts without any state to keep. Replies
 * to people go through a different path and are deliberately not throttled --
 * rate-limiting answers to a direct question would break the support side of
 * the bot.
 *
 * `build` returns candidates in preference order; the first one that has not
 * been said before wins, and if they are all repeats nothing is posted.
 */
async function postFresh(
  client: Client,
  config: AppConfig,
  label: string,
  build: () => Promise<string[]>
): Promise<void> {
  if (!(await roomIsAwake(client, config, label))) return;

  const channel = await client.channels.fetch(config.channels.general);
  if (!(channel instanceof TextChannel)) return;

  const botId = client.user?.id;
  if (!botId) return;

  const history = await recentBotLines(channel, botId);
  const candidates = (await build()).filter((c) => c?.trim());
  const line = firstFresh(candidates, history);

  if (!line) {
    console.log(`[scheduler:${config.app.name}] ${label} skipped -- nothing new to say`);
    return;
  }
  await sendHumanized(channel, line);
  console.log(`[scheduler:${config.app.name}] ${label} posted`);
}

/**
 * Live discounts first, then the model's own line. A real code that expires is
 * the only thing here with a deadline attached, so it outranks chatter; when
 * there is no promo running this falls straight through to the joke.
 */
async function lunchCandidates(config: AppConfig): Promise<string[]> {
  const coupons = await fetchListedCoupons(config);
  const promos = coupons.map((c) => couponLine(config, c));
  const joke = await generateLunchJoke(config);
  // Two joke draws: the stored-jokes list is small and repeats quickly, so a
  // second sample meaningfully improves the odds of clearing the freshness bar.
  const joke2 = await generateLunchJoke(config);
  return [...promos, joke, joke2];
}

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
      await postFresh(client, config, 'morning greeting', async () => [
        await generateMorningGreeting(config),
        await generateMorningGreeting(config),
      ]);
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
      await postFresh(client, config, 'lunch post', () => lunchCandidates(config));
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
