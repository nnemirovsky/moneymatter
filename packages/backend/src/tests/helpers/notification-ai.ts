import { AI_FEATURE } from '@bt/shared/types';
import { afterEach, beforeEach } from '@jest/globals';
import { FALLBACK_SERVER_MODELS } from '@services/ai/resolution-ladder';
import { GEMINI_API_URL } from '@tests/mocks/gemini/mock-api';
import { HttpResponse, http } from 'msw';

import type { NotificationParseOutput } from '../../services/ingest/event/classify-notification';
import { notificationRules } from '../../services/ingest/event/constants';

/** The model the server key runs for notification parsing. */
const NOTIFICATION_MODEL = FALLBACK_SERVER_MODELS[AI_FEATURE.notificationParsing]!.model;

/** The model the server key runs for duplicate matching, which also composes the short-balance correction. */
const CORRECTION_MODEL = FALLBACK_SERVER_MODELS[AI_FEATURE.duplicateMatching]!.model;

const NO_ANSWER_OUTPUT: NotificationParseOutput = {
  kind: 'debit',
  stage: 'payment',
  isOwnAccountTransfer: false,
  amount: null,
  currency: null,
  originalAmount: null,
  originalCurrency: null,
  merchant: null,
  payee: null,
  cardName: null,
  cardLastDigits: null,
  balanceAfter: null,
  occurredAt: null,
  confidence: 0.95,
};

const geminiAnswer = ({ text }: { text: string }) =>
  HttpResponse.json({
    candidates: [{ content: { parts: [{ text }], role: 'model' }, finishReason: 'STOP', index: 0 }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 },
  });

/**
 * What the mocked model answers for one notification: the fields it fills, a server error (`fail`: the provider is down,
 * which passes), or text that is no answer at all (`garbage`: a failure no later try is expected to mend).
 */
type NotificationAnswer = Partial<NotificationParseOutput> | 'fail' | 'garbage';

/** What the mocked model answers for a short-balance correction: the account aliases best first and a reason. */
type CorrectionAnswer = { ranking: string[]; reason: string | null } | 'fail';

/** What the mocked model answers for the duplicate judge: the candidates it calls the same payment, or a server error. */
type JudgeAnswer = { matches: { id: string; confidence: number; reason: string | null }[] } | 'fail';

/** What the mocked model answers when a tap's merchant is equally close to several payees: one candidate's id, or none. */
type PayeePickAnswer = { candidateId: string | null } | 'fail';

/** What the mocked model answers when it picks a logged payment's note from the payee's past notes. */
type NotePickAnswer = { candidateId: string | null } | 'fail';

/** What the mocked model answers for a merchant-app notification: the order it reads, or a server error. */
type ContextParseAnswer = { isOrderUpdate: boolean; store: string | null; status: string; confidence: number } | 'fail';

/** What the mocked model answers when it reads a business sender's message about a currency exchange. */
type ExchangeReadAnswer = { confirmsExchange: boolean; note: string | null; confidence: number } | 'fail';

/** What the mocked model answers when it weighs several payments for one context notification. */
type ContextPickAnswer = { choice: string | null; confidence: number } | 'fail';

/** What the mocked model answers when it picks the category of a store. */
type ContextCategoryAnswer = { categoryId: string | null; confidence: number } | 'fail';

/**
 * For a suite of the AI reading of notifications: plain pushes go to the (mocked) model, as the suite expects, instead
 * of being read by their layout. Registers its own hooks.
 */
export const useAiOnlyNotificationParsing = (): void => {
  let before = notificationRules.enabled;

  beforeEach(() => {
    before = notificationRules.enabled;
    notificationRules.enabled = false;
  });
  afterEach(() => {
    notificationRules.enabled = before;
  });
};

/**
 * Answers `notificationParsing` calls over MSW. Every call to the model that carries a notification
 * is passed to `answer` with its prompt; any other call to the endpoint (a categorization the logged
 * row triggers) gets an empty answer. A short-balance correction prompt is answered by `correction`, which
 * is optional: without it the model answers nothing usable and the deterministic suggestion stands.
 * A duplicate-judge prompt is answered by `judge`, optional the same way: without it the judge
 * finds nothing usable and raises no suggestion. A payee-pick prompt (a tap whose merchant is equally close
 * to several payees) is answered by `payeePick`, and a note-pick prompt (a payee with mixed past notes) by
 * `notePick`, both optional too: without them the model picks none.
 * Returns the prompts the parser sent, in order.
 */
export const mockNotificationParsing = ({
  answer,
  correction,
  correctionPrompts = [],
  judge,
  judgePrompts = [],
  payeePick,
  payeePickPrompts = [],
  notePick,
  notePickPrompts = [],
  contextParse,
  contextParsePrompts = [],
  contextPick,
  contextPickPrompts = [],
  contextCategory,
  contextCategoryPrompts = [],
  exchangeRead,
  exchangeReadPrompts = [],
}: {
  answer: (args: { prompt: string; call: number }) => NotificationAnswer;
  correction?: (args: { prompt: string }) => CorrectionAnswer;
  /** Collects the correction prompts the model was sent. */
  correctionPrompts?: string[];
  judge?: (args: { prompt: string }) => JudgeAnswer;
  /** Collects the judge prompts the model was sent. */
  judgePrompts?: string[];
  payeePick?: (args: { prompt: string }) => PayeePickAnswer;
  /** Collects the payee-pick prompts the model was sent. */
  payeePickPrompts?: string[];
  notePick?: (args: { prompt: string }) => NotePickAnswer;
  /** Collects the note-pick prompts the model was sent. */
  notePickPrompts?: string[];
  /** Reads a merchant-app (context) notification; without it the model finds no order in it. */
  contextParse?: (args: { prompt: string }) => ContextParseAnswer;
  contextParsePrompts?: string[];
  /** Weighs the payments a context notification could belong to; without it the nearest in time stands in. */
  contextPick?: (args: { prompt: string }) => ContextPickAnswer;
  contextPickPrompts?: string[];
  /** Picks the category of a store; without it the category is left alone. */
  contextCategory?: (args: { prompt: string }) => ContextCategoryAnswer;
  contextCategoryPrompts?: string[];
  /** Reads a business sender's message about a waiting currency exchange; without it the model confirms nothing. */
  exchangeRead?: (args: { prompt: string }) => ExchangeReadAnswer;
  exchangeReadPrompts?: string[];
}): string[] => {
  const prompts: string[] = [];

  global.mswMockServer.use(
    http.post(GEMINI_API_URL, async ({ request }) => {
      const body = (await request.clone().json()) as { contents?: { parts?: { text?: string }[] }[] };
      const prompt = (body.contents ?? [])
        .flatMap((content) => content.parts ?? [])
        .map((part) => part.text ?? '')
        .join('\n');

      const fail = () =>
        HttpResponse.json({ error: { code: 500, message: 'boom', status: 'INTERNAL' } }, { status: 500 });

      // The context pipeline's calls are told apart by their prompts, whatever model they run on.
      if (prompt.includes('CATEGORIES (id|parent id|name)')) {
        contextCategoryPrompts.push(prompt);
        const picked = contextCategory?.({ prompt }) ?? { categoryId: null, confidence: 0 };

        return picked === 'fail' ? fail() : geminiAnswer({ text: JSON.stringify(picked) });
      }

      if (prompt.includes('PAYMENTS (id|time|amount|merchant)')) {
        contextPickPrompts.push(prompt);
        const picked = contextPick?.({ prompt }) ?? { choice: null, confidence: 0 };

        return picked === 'fail' ? fail() : geminiAnswer({ text: JSON.stringify(picked) });
      }

      if (prompt.startsWith('EXCHANGE CONFIRMATION')) {
        exchangeReadPrompts.push(prompt);
        const read = exchangeRead?.({ prompt }) ?? { confirmsExchange: false, note: null, confidence: 0 };

        return read === 'fail' ? fail() : geminiAnswer({ text: JSON.stringify(read) });
      }

      if (prompt.startsWith('APP:') && prompt.includes('NOTIFICATION (untrusted text')) {
        contextParsePrompts.push(prompt);
        const read = contextParse?.({ prompt }) ?? {
          isOrderUpdate: false,
          store: null,
          status: 'other',
          confidence: 0,
        };

        return read === 'fail' ? fail() : geminiAnswer({ text: JSON.stringify(read) });
      }

      // The categorization the logged row triggers runs on another model and gets an empty answer.
      const model = /\/v1beta\/models\/([^/:]+):/.exec(request.url)?.[1];
      if (model !== NOTIFICATION_MODEL && model !== CORRECTION_MODEL) {
        return geminiAnswer({ text: '# No categorizations' });
      }

      if (prompt.includes('SHORT BALANCE PAYMENT')) {
        correctionPrompts.push(prompt);
        const composed = correction?.({ prompt });
        if (!composed) return geminiAnswer({ text: '# No categorizations' });
        if (composed === 'fail') {
          return HttpResponse.json({ error: { code: 500, message: 'boom', status: 'INTERNAL' } }, { status: 500 });
        }

        return geminiAnswer({ text: JSON.stringify(composed) });
      }

      if (prompt.includes('DUPLICATE JUDGE')) {
        judgePrompts.push(prompt);
        const judged = judge?.({ prompt });
        if (!judged) return geminiAnswer({ text: '# No categorizations' });
        if (judged === 'fail') {
          return HttpResponse.json({ error: { code: 500, message: 'boom', status: 'INTERNAL' } }, { status: 500 });
        }

        return geminiAnswer({ text: JSON.stringify(judged) });
      }

      if (prompt.includes('NOTE PICK')) {
        notePickPrompts.push(prompt);
        const picked = notePick?.({ prompt }) ?? { candidateId: null };
        if (picked === 'fail') {
          return HttpResponse.json({ error: { code: 500, message: 'boom', status: 'INTERNAL' } }, { status: 500 });
        }

        return geminiAnswer({ text: JSON.stringify(picked) });
      }

      if (prompt.includes('PAYEE PICK')) {
        payeePickPrompts.push(prompt);
        const picked = payeePick?.({ prompt }) ?? { candidateId: null };
        if (picked === 'fail') {
          return HttpResponse.json({ error: { code: 500, message: 'boom', status: 'INTERNAL' } }, { status: 500 });
        }

        return geminiAnswer({ text: JSON.stringify(picked) });
      }

      if (!prompt.includes('NOTIFICATION (untrusted text')) return geminiAnswer({ text: '# No categorizations' });
      prompts.push(prompt);
      const result = answer({ prompt, call: prompts.length });
      if (result === 'fail') {
        return HttpResponse.json({ error: { code: 500, message: 'boom', status: 'INTERNAL' } }, { status: 500 });
      }
      if (result === 'garbage') return geminiAnswer({ text: 'this is not the object that was asked for' });

      return geminiAnswer({ text: JSON.stringify({ ...NO_ANSWER_OUTPUT, ...result }) });
    }),
  );

  return prompts;
};
