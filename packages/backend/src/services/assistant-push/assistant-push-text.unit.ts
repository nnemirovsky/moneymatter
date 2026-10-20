import { NOTIFICATION_TYPES } from '@bt/shared/types';
import { i18nextReady } from '@i18n/index';
import { beforeAll, describe, expect, it } from '@jest/globals';

import { isAssistantNotificationType, renderAssistantBody, renderAssistantTitle } from './assistant-push-text';

const titleFor = ({ cardCount, locale }: { cardCount: number; locale: string }) =>
  renderAssistantTitle({
    type: NOTIFICATION_TYPES.chatCardsWaiting,
    payload: { threadId: 't1', threadTitle: 'Budget', cardCount },
    locale,
  });

const inboxBodyFor = ({ count, locale }: { count: number; locale: string }) =>
  renderAssistantBody({ type: NOTIFICATION_TYPES.automationInbox, payload: { threadId: 'inbox', count }, locale });

const bodyFor = ({ reason, locale = 'en' }: { reason: string; locale?: string }) =>
  renderAssistantBody({ type: NOTIFICATION_TYPES.ingestAttention, payload: { reason }, locale });

describe('assistant push text', () => {
  beforeAll(async () => {
    await i18nextReady;
  });

  describe('isAssistantNotificationType', () => {
    it('owns the four assistant types and no other', () => {
      expect(
        [
          NOTIFICATION_TYPES.chatReplyReady,
          NOTIFICATION_TYPES.chatCardsWaiting,
          NOTIFICATION_TYPES.automationInbox,
          NOTIFICATION_TYPES.ingestAttention,
        ].every((type) => isAssistantNotificationType({ type })),
      ).toBe(true);
      expect(isAssistantNotificationType({ type: NOTIFICATION_TYPES.system })).toBe(false);
      expect(isAssistantNotificationType({ type: NOTIFICATION_TYPES.subscriptionReminder })).toBe(false);
    });
  });

  describe('chatReplyReady', () => {
    const payload = { threadId: 't1', threadTitle: 'Where did my money go?', runStatus: 'complete' };

    it('titles a finished run and bodies it with the thread title', () => {
      expect(renderAssistantTitle({ type: NOTIFICATION_TYPES.chatReplyReady, payload, locale: 'en' })).toBe(
        'Your reply is ready',
      );
      expect(renderAssistantBody({ type: NOTIFICATION_TYPES.chatReplyReady, payload, locale: 'en' })).toBe(
        'Where did my money go?',
      );
    });

    it('says so when the run failed', () => {
      expect(
        renderAssistantTitle({
          type: NOTIFICATION_TYPES.chatReplyReady,
          payload: { ...payload, runStatus: 'failed' },
          locale: 'en',
        }),
      ).toBe('The assistant could not finish');
    });

    it('falls back to a fixed line when the thread has no title', () => {
      expect(
        renderAssistantBody({
          type: NOTIFICATION_TYPES.chatReplyReady,
          payload: { threadId: 't1', threadTitle: '  ', runStatus: 'complete' },
          locale: 'en',
        }),
      ).toBe('Open the chat to read it.');
    });

    it('is translated into uk', () => {
      expect(renderAssistantTitle({ type: NOTIFICATION_TYPES.chatReplyReady, payload, locale: 'uk' })).toBe(
        'Відповідь готова',
      );
    });
  });

  describe('chatCardsWaiting', () => {
    it('counts the cards with the right plural', () => {
      expect(titleFor({ cardCount: 1, locale: 'en' })).toBe('1 card waits for your OK');
      expect(titleFor({ cardCount: 3, locale: 'en' })).toBe('3 cards wait for your OK');
    });

    it('uses the uk plural forms', () => {
      expect(titleFor({ cardCount: 1, locale: 'uk' })).toBe('1 картка чекає на ваше підтвердження');
      expect(titleFor({ cardCount: 3, locale: 'uk' })).toBe('3 картки чекають на ваше підтвердження');
      expect(titleFor({ cardCount: 5, locale: 'uk' })).toBe('5 карток чекають на ваше підтвердження');
    });
  });

  describe('automationInbox', () => {
    it('carries only the count', () => {
      expect(inboxBodyFor({ count: 1, locale: 'en' })).toBe('1 new item to review');
      expect(inboxBodyFor({ count: 3, locale: 'en' })).toBe('3 new items to review');
      expect(inboxBodyFor({ count: 3, locale: 'uk' })).toBe('3 нові елементи для перегляду');
    });
  });

  describe('ingestAttention', () => {
    it('says what is wrong per reason', () => {
      expect(bodyFor({ reason: 'aiCapReached' })).toBe(
        'A bank notification could not be read: the monthly AI limit is reached.',
      );
      expect(bodyFor({ reason: 'rateUnavailable' })).toBe('A payment waits for an exchange rate.');
      expect(bodyFor({ reason: 'aiCapReached', locale: 'uk' })).toBe(
        'Не вдалося прочитати сповіщення банку: вичерпано місячний ліміт ШІ.',
      );
    });

    it('uses a generic line for a reason it does not know', () => {
      expect(bodyFor({ reason: 'somethingNew' })).toBe('A payment is waiting for you.');
    });
  });

  describe('privacy', () => {
    it('never puts a payload field other than the thread title, the count or the reason into the text', () => {
      const secret = 'Wolt 43.60 GEL card 4321';
      const payloads = [
        {
          type: NOTIFICATION_TYPES.chatReplyReady,
          payload: { threadId: 't', threadTitle: 'Plain title', runStatus: 'complete', text: secret },
        },
        {
          type: NOTIFICATION_TYPES.chatCardsWaiting,
          payload: { threadId: 't', threadTitle: 'Plain title', cardCount: 2, text: secret },
        },
        { type: NOTIFICATION_TYPES.automationInbox, payload: { threadId: 't', count: 2, text: secret } },
        { type: NOTIFICATION_TYPES.ingestAttention, payload: { reason: 'aiCapReached', text: secret } },
      ];

      for (const { type, payload } of payloads) {
        for (const locale of ['en', 'uk']) {
          const text = `${renderAssistantTitle({ type, payload, locale })} ${renderAssistantBody({ type, payload, locale })}`;
          expect(text).not.toContain('Wolt');
          expect(text).not.toContain('4321');
        }
      }
    });

    it('has no body for a type outside the group', () => {
      expect(renderAssistantBody({ type: NOTIFICATION_TYPES.system, payload: {}, locale: 'en' })).toBeNull();
    });
  });
});
