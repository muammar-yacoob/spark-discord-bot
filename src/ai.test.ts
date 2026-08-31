import { beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * Every API key in the org draws on ONE shared per-minute token budget, so a
 * busy minute in a sibling project throttles the bot. `safeComplete` returns
 * null on failure and every caller falls back to canned text ("hmm, drawing a
 * blank on that one"), so an un-retried throttle reads as the bot going vague
 * rather than as anything erroring - which is why the retry is worth a test in
 * a repo that otherwise has none.
 */
const create = mock(() => Promise.resolve({ choices: [{ message: { content: 'ok' } }] }));

mock.module('groq-sdk', () => ({
  default: class {
    chat = { completions: { create } };
  },
}));

const { generateResponse } = await import('./ai');

const config = {
  app: { name: 'App', description: 'd', url: 'u', stack: 's' },
  personality: { name: 'Dev', tone: 't' },
  faq: [],
  jokes: [],
} as any;

/** Shaped like the SDK's APIError: a status, headers and the upstream message. */
function throttle(message: string, retryAfter?: string) {
  return Object.assign(new Error(message), {
    status: 429,
    headers: retryAfter ? new Headers({ 'retry-after': retryAfter }) : undefined,
  });
}

const reply = (content: string) => ({ choices: [{ message: { content } }] });

beforeEach(() => {
  create.mockReset();
});

describe('safeComplete retry', () => {
  test('answers on the happy path with one request', async () => {
    create.mockResolvedValueOnce(reply('hello'));

    expect(await generateResponse(config, 'hi')).toBe('hello');
    expect(create).toHaveBeenCalledTimes(1);
  });

  test('retries once through a per-minute throttle', async () => {
    create
      .mockRejectedValueOnce(throttle('tokens per minute (TPM). Please try again in 0.05s'))
      .mockResolvedValueOnce(reply('recovered'));

    expect(await generateResponse(config, 'hi')).toBe('recovered');
    expect(create).toHaveBeenCalledTimes(2);
  });

  // A daily cap will not clear inside this call, so sleeping just delays the
  // same failure while a user waits on a Discord reply.
  test('does not retry a daily cap', async () => {
    create.mockRejectedValue(throttle('Rate limit reached ... tokens per day (TPD)'));

    const result = await generateResponse(config, 'hi');

    expect(create).toHaveBeenCalledTimes(1);
    expect(result).toBe('hmm, drawing a blank on that one. mind rephrasing?');
  });

  test('does not retry a non-throttle failure', async () => {
    create.mockRejectedValue(Object.assign(new Error('bad request'), { status: 400 }));

    await generateResponse(config, 'hi');

    expect(create).toHaveBeenCalledTimes(1);
  });

  test('gives up after one retry rather than looping on a busy window', async () => {
    create.mockRejectedValue(throttle('tokens per minute (TPM). Please try again in 0.05s'));

    await generateResponse(config, 'hi');

    expect(create).toHaveBeenCalledTimes(2);
  });

  // Reasoning spends from the same budget as the reply, so a cap sized to the
  // visible answer returns empty content.
  test('floors the token budget so reasoning cannot starve the reply', async () => {
    create.mockResolvedValueOnce(reply('ok'));

    await generateResponse(config, 'hi');

    expect(create.mock.calls[0][0].max_tokens).toBe(700);
  });
});
