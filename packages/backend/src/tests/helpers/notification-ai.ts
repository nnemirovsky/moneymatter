import { AI_FEATURE } from '@bt/shared/types';
import { FALLBACK_SERVER_MODELS } from '@services/ai/resolution-ladder';
import { GEMINI_API_URL } from '@tests/mocks/gemini/mock-api';
import { HttpResponse, http } from 'msw';

import type { NotificationParseOutput } from '../../services/ingest/event/classify-notification';

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

/** What the mocked model answers for one notification: the fields it fills, or a server error. */
type NotificationAnswer = Partial<NotificationParseOutput> | 'fail';

/** What the mocked model answers for a short-balance correction: the account aliases best first and a reason. */
type CorrectionAnswer = { ranking: string[]; reason: string | null } | 'fail';

/** What the mocked model answers for the duplicate judge: the candidates it calls the same payment, or a server error. */
type JudgeAnswer = { matches: { id: string; confidence: number; reason: string | null }[] } | 'fail';

/** What the mocked model answers when a tap's merchant is equally close to several payees: one candidate's id, or none. */
type PayeePickAnswer = { candidateId: string | null } | 'fail';

/** What the mocked model answers when it picks a logged payment's note from the payee's past notes. */
type NotePickAnswer = { candidateId: string | null } | 'fail';

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
}): string[] => {
  const prompts: string[] = [];

  global.mswMockServer.use(
    http.post(GEMINI_API_URL, async ({ request }) => {
      // The categorization the logged row triggers runs on another model and gets an empty answer.
      const model = /\/v1beta\/models\/([^/:]+):/.exec(request.url)?.[1];
      if (model !== NOTIFICATION_MODEL && model !== CORRECTION_MODEL) {
        return geminiAnswer({ text: '# No categorizations' });
      }

      const body = (await request.clone().json()) as { contents?: { parts?: { text?: string }[] }[] };
      const prompt = (body.contents ?? [])
        .flatMap((content) => content.parts ?? [])
        .map((part) => part.text ?? '')
        .join('\n');

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

      return geminiAnswer({ text: JSON.stringify({ ...NO_ANSWER_OUTPUT, ...result }) });
    }),
  );

  return prompts;
};
