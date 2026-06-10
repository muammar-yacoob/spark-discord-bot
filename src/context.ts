import type { TextChannel, Message } from 'discord.js';

/** Search recent messages in a channel for relevant context */
export async function findRelevantContext(
  channel: TextChannel,
  query: string,
  limit = 50
): Promise<string> {
  try {
    const messages = await channel.messages.fetch({ limit });

    const keywords = query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3);

    if (keywords.length === 0) return '';

    const relevant = messages
      .filter((msg: Message) => {
        if (msg.author.bot) return false;
        const content = msg.content.toLowerCase();
        return keywords.some((kw) => content.includes(kw));
      })
      .map((msg: Message) => `${msg.author.displayName}: ${msg.content}`)
      .slice(0, 5);

    return relevant.join('\n');
  } catch (err) {
    console.error('[context] failed to fetch messages:', err);
    return '';
  }
}
