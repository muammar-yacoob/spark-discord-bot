import { type Client, TextChannel } from 'discord.js';
import type { AppConfig } from './config';
import Groq from 'groq-sdk';
import { randomOffset } from './humanize';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

let digestTimer: ReturnType<typeof setTimeout> | null = null;
const DIGEST_DAY = 1; // Monday
const DIGEST_HOUR = 9; // 9 AM UTC

interface ServerSummary {
  name: string;
  newMembers: number;
  totalMessages: number;
  helpMessages: number;
  bugReports: number;
  unresolvedQuestions: string[];
  topTopics: string;
}

async function gatherServerStats(
  client: Client,
  config: AppConfig
): Promise<ServerSummary> {
  const summary: ServerSummary = {
    name: config.app.name,
    newMembers: 0,
    totalMessages: 0,
    helpMessages: 0,
    bugReports: 0,
    unresolvedQuestions: [],
    topTopics: '',
  };

  try {
    // Count recent messages in general
    if (config.channels.general) {
      const ch = await client.channels.fetch(config.channels.general);
      if (ch instanceof TextChannel) {
        const msgs = await ch.messages.fetch({ limit: 100 });
        const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        summary.totalMessages = msgs.filter(
          (m) => m.createdTimestamp > weekAgo && !m.author.bot
        ).size;
      }
    }

    // Count help messages and find unresolved
    if (config.channels.help) {
      const ch = await client.channels.fetch(config.channels.help);
      if (ch instanceof TextChannel) {
        const msgs = await ch.messages.fetch({ limit: 100 });
        const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const recent = msgs.filter(
          (m) => m.createdTimestamp > weekAgo && !m.author.bot
        );
        summary.helpMessages = recent.size;

        // Find questions without a checkmark reaction (unresolved)
        for (const msg of recent.values()) {
          if (!msg.content.includes('?')) continue;
          const hasCheck = msg.reactions.cache.some(
            (r) => r.emoji.name === '\u2705'
          );
          if (!hasCheck) {
            summary.unresolvedQuestions.push(
              msg.content.slice(0, 80)
            );
          }
        }

        // Get topic summary from AI
        if (recent.size > 0) {
          const helpTexts = recent
            .map((m) => m.content)
            .slice(0, 15)
            .join('\n');
          try {
            const completion = await groq.chat.completions.create({
              model: 'llama-3.3-70b-versatile',
              messages: [
                {
                  role: 'system',
                  content:
                    'Summarize the common themes/topics from these Discord help channel messages in 1-2 short bullet points. Be specific. If nothing stands out, say "no clear pattern".',
                },
                { role: 'user', content: helpTexts },
              ],
              temperature: 0.3,
              max_tokens: 100,
            });
            summary.topTopics =
              completion.choices[0]?.message?.content || '';
          } catch {
            summary.topTopics = '';
          }
        }
      }
    }

    // Count bug reports (forum posts)
    if (config.channels.bug_reports) {
      try {
        const ch = await client.channels.fetch(config.channels.bug_reports);
        if (ch && 'threads' in ch) {
          const threads = await (ch as any).threads.fetchActive();
          const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
          summary.bugReports = threads.threads.filter(
            (t: any) => t.createdTimestamp > weekAgo
          ).size;
        }
      } catch {
        // Forum might not support this
      }
    }

    // Count new members from bot-logs
    if (config.channels.bot_logs) {
      const ch = await client.channels.fetch(config.channels.bot_logs);
      if (ch instanceof TextChannel) {
        const msgs = await ch.messages.fetch({ limit: 100 });
        const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        summary.newMembers = msgs.filter(
          (m) =>
            m.createdTimestamp > weekAgo &&
            m.content.includes('[join]')
        ).size;
      }
    }
  } catch (err) {
    console.error(`[digest:${config.app.name}] stats failed:`, err);
  }

  return summary;
}

function formatDigest(summaries: ServerSummary[]): string {
  const lines: string[] = ['**Weekly Digest**\n'];

  // Flag servers needing attention
  const needsAttention = summaries.filter(
    (s) => s.unresolvedQuestions.length > 0 || s.bugReports > 0
  );

  if (needsAttention.length > 0) {
    lines.push('**Needs your attention:**');
    for (const s of needsAttention) {
      const issues: string[] = [];
      if (s.unresolvedQuestions.length > 0)
        issues.push(`${s.unresolvedQuestions.length} unanswered`);
      if (s.bugReports > 0) issues.push(`${s.bugReports} bug(s)`);
      lines.push(`  -- ${s.name}: ${issues.join(', ')}`);
    }
    lines.push('');
  }

  for (const s of summaries) {
    lines.push(`**${s.name}**`);
    lines.push(
      `  +${s.newMembers} members | ${s.totalMessages} msgs | ${s.helpMessages} help questions | ${s.bugReports} bugs`
    );

    if (s.unresolvedQuestions.length > 0) {
      lines.push(
        `  Unresolved: ${s.unresolvedQuestions.slice(0, 3).map((q) => `"${q.slice(0, 50)}..."`).join(', ')}`
      );
    }

    if (s.topTopics) {
      lines.push(`  Themes: ${s.topTopics}`);
    }

    lines.push('');
  }

  // Quiet servers
  const quiet = summaries.filter(
    (s) =>
      s.totalMessages === 0 &&
      s.helpMessages === 0 &&
      s.bugReports === 0
  );
  if (quiet.length > 0) {
    lines.push(
      `*Quiet this week: ${quiet.map((s) => s.name).join(', ')}*`
    );
  }

  return lines.join('\n');
}

function msUntilNextDigest(): number {
  const now = new Date();
  const target = new Date(now);
  target.setUTCHours(DIGEST_HOUR, 0, 0, 0);

  // Find next Monday
  const daysUntilMonday = (DIGEST_DAY - now.getUTCDay() + 7) % 7 || 7;
  target.setUTCDate(target.getUTCDate() + daysUntilMonday);

  if (target <= now) {
    target.setUTCDate(target.getUTCDate() + 7);
  }

  return target.getTime() - now.getTime();
}

function scheduleDigest(
  client: Client,
  configs: Map<string, AppConfig>
): void {
  const delay = msUntilNextDigest();
  const days = Math.floor(delay / 86400000);
  const hours = Math.floor((delay % 86400000) / 3600000);
  console.log(`[digest] next weekly digest in ${days}d ${hours}h`);

  digestTimer = setTimeout(async () => {
    try {
      const summaries: ServerSummary[] = [];

      for (const config of configs.values()) {
        const stats = await gatherServerStats(client, config);
        summaries.push(stats);
      }

      const digest = formatDigest(summaries);

      // DM the owner (use owner_id from first config)
      const ownerId = configs.values().next().value?.owner_id;
      if (ownerId) {
        const owner = await client.users.fetch(ownerId);
        await owner.send(digest);
        console.log('[digest] sent weekly digest to owner');
      }
    } catch (err) {
      console.error('[digest] failed:', err);
    }

    // Reschedule
    scheduleDigest(client, configs);
  }, delay);
}

export function startDigest(
  client: Client,
  configs: Map<string, AppConfig>
): void {
  scheduleDigest(client, configs);
}

export function stopDigest(): void {
  if (digestTimer) clearTimeout(digestTimer);
}
