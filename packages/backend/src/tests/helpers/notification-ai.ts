import { AI_FEATURE } from '@bt/shared/types';
import { FALLBACK_SERVER_MODELS } from '@services/ai/resolution-ladder';
import { GEMINI_API_URL } from '@tests/mocks/gemini/mock-api';
import { HttpResponse, http } from 'msw';

import type { NotificationParseOutput } from '../../services/ingest/event/classify-notification';

/** The model the server key runs for notification parsing. */
const NOTIFICATION_MODEL = FALLBACK_SERVER_MODELS[AI_FEATURE.notificationParsing]!.model;

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

/**
 * Answers `notificationParsing` calls over MSW. Every call to the model that carries a notification
 * is passed to `answer` with its prompt; any other call to the endpoint (a categorization the logged
 * row triggers) gets an empty answer. Returns the prompts the parser sent, in order.
 */
export const mockNotificationParsing = ({
  answer,
}: {
  answer: (args: { prompt: string; call: number }) => NotificationAnswer;
}): string[] => {
  const prompts: string[] = [];

  global.mswMockServer.use(
    http.post(GEMINI_API_URL, async ({ request }) => {
      // The categorization the logged row triggers runs on another model and gets an empty answer.
      const model = /\/v1beta\/models\/([^/:]+):/.exec(request.url)?.[1];
      if (model !== NOTIFICATION_MODEL) return geminiAnswer({ text: '# No categorizations' });

      const body = (await request.clone().json()) as { contents?: { parts?: { text?: string }[] }[] };
      const prompt = (body.contents ?? [])
        .flatMap((content) => content.parts ?? [])
        .map((part) => part.text ?? '')
        .join('\n');

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
