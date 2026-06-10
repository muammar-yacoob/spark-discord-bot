import Groq from 'groq-sdk';
import type { AppConfig } from './config';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

function buildSystemPrompt(config: AppConfig, context?: string): string {
  const faqBlock = config.faq
    .map((f) => `Q: ${f.q}\nA: ${f.a}`)
    .join('\n\n');

  return `You are ${config.personality.name}, a community helper in the ${config.app.name} Discord server.

About ${config.app.name}: ${config.app.description}
Website: ${config.app.url}
Stack: ${config.app.stack}

Your personality: ${config.personality.tone}

Rules:
- Keep responses SHORT. 1-3 sentences max unless someone needs a technical walkthrough.
- Never use emojis excessively. One per message max, and only when it fits naturally.
- Never pitch or sell. You help, you don't promote.
- If you don't know something, say so. Suggest they open a thread in #help or #bug-reports.
- For bugs: ask for steps to reproduce, browser/OS, and any error messages. Log it.
- Never reveal you are an AI or a bot. You are ${config.personality.name}, a dev on the team. If asked directly, deflect with humor.
- Never join or reference voice channels.
- Use casual lowercase for chat, proper formatting for technical answers.
- When greeting in the morning, keep it to one short line. No paragraphs.
- Jokes should be dev humor, light, app-relevant. One-liners only.

Known FAQ:
${faqBlock}

${context ? `Recent related messages for context:\n${context}` : ''}`;
}

async function safeComplete(
  messages: Array<{ role: string; content: string }>,
  opts: { temperature?: number; max_tokens?: number; top_p?: number } = {}
): Promise<string | null> {
  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: messages as any,
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.max_tokens ?? 300,
      top_p: opts.top_p ?? 0.9,
    });
    return completion.choices[0]?.message?.content || null;
  } catch (err) {
    console.error('[ai] groq call failed:', err);
    return null;
  }
}

export async function generateResponse(
  config: AppConfig,
  userMessage: string,
  context?: string
): Promise<string> {
  const result = await safeComplete(
    [
      { role: 'system', content: buildSystemPrompt(config, context) },
      { role: 'user', content: userMessage },
    ],
    { temperature: 0.7, max_tokens: 300, top_p: 0.9 }
  );
  return result || "hmm, drawing a blank on that one. mind rephrasing?";
}

export async function generateMorningGreeting(config: AppConfig): Promise<string> {
  const result = await safeComplete(
    [
      { role: 'system', content: buildSystemPrompt(config) },
      {
        role: 'user',
        content:
          'Generate a very short, casual good morning message for the dev community. One line only. No emojis. Vary it -- sometimes reference coffee, code, deployments, bugs. Be natural, not robotic.',
      },
    ],
    { temperature: 0.95, max_tokens: 60 }
  );
  return result || 'morning everyone';
}

export async function generateLunchJoke(config: AppConfig): Promise<string> {
  const useStored = Math.random() > 0.5 && config.jokes.length > 0;
  if (useStored) {
    return config.jokes[Math.floor(Math.random() * config.jokes.length)];
  }

  const result = await safeComplete(
    [
      { role: 'system', content: buildSystemPrompt(config) },
      {
        role: 'user',
        content: `Write a single short dev joke or observation related to ${config.app.name} or payment/subscription/SaaS development. One line, casual, actually funny. No setup-punchline format. More like a shower thought or tweet.`,
      },
    ],
    { temperature: 1.0, max_tokens: 80 }
  );
  return result || config.jokes[0] || 'lunch break brb';
}

export async function classifyIntent(
  message: string
): Promise<'support' | 'bug' | 'chat' | 'escalate' | 'ignore'> {
  const result = await safeComplete(
    [
      {
        role: 'system',
        content:
          'Classify the user message intent. Reply with exactly one word: support, bug, escalate, chat, or ignore.\n- "support" for how-to questions\n- "bug" for error reports or broken behavior\n- "escalate" for billing issues, account problems, refund requests, security concerns, or anything requiring human intervention\n- "chat" for general conversation\n- "ignore" for greetings, thank-yous, reactions, or messages not directed at you',
      },
      { role: 'user', content: message },
    ],
    { temperature: 0, max_tokens: 5 }
  );
  const word = (result || 'ignore').trim().toLowerCase();
  if (['support', 'bug', 'chat', 'escalate'].includes(word)) {
    return word as 'support' | 'bug' | 'chat' | 'escalate';
  }
  return 'ignore';
}

export async function assessConfidence(
  config: AppConfig,
  question: string,
  answer: string
): Promise<boolean> {
  const result = await safeComplete(
    [
      {
        role: 'system',
        content: `You are a QA checker. Given a question about ${config.app.name} and the answer provided, reply "yes" if the answer is confident and accurate, or "no" if it seems uncertain, vague, or the bot is guessing. One word only.`,
      },
      {
        role: 'user',
        content: `Question: ${question}\nAnswer: ${answer}`,
      },
    ],
    { temperature: 0, max_tokens: 3 }
  );
  return (result || 'yes').trim().toLowerCase() === 'yes';
}
