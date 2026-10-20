import type { NotificationStruct } from '@/api/notifications';
import {
  type AutomationInboxPayload,
  type ChatCardsWaitingPayload,
  type ChatReplyReadyPayload,
  type IngestAttentionPayload,
  NOTIFICATION_TYPES,
} from '@bt/shared/types';

type Translate = (key: string, named?: Record<string, unknown>, plural?: number) => string;

/** Park reasons that have a sentence of their own; any other reason takes the generic one. */
const INGEST_ATTENTION_REASONS: readonly string[] = [
  'unknownCard',
  'rateUnavailable',
  'processingFailed',
  'aiUnavailable',
  'aiCapReached',
  'aiLimitReached',
];

/**
 * The bell's title and line for an assistant entry, built from its payload in the current language
 * (the stored text is in the language the entry was created in). Counts come from the payload, never
 * from the stored text. Returns null for any other type.
 */
export const buildAssistantNotificationText = ({
  notification,
  t,
}: {
  notification: NotificationStruct;
  t: Translate;
}): { title: string; message: string | null } | null => {
  const prefix = 'notifications.types';

  switch (notification.type) {
    case NOTIFICATION_TYPES.chatReplyReady: {
      const payload = notification.payload as Partial<ChatReplyReadyPayload>;
      return {
        title: t(`${prefix}.chatReplyReady.${payload.runStatus === 'failed' ? 'titleFailed' : 'title'}`),
        message: payload.threadTitle?.trim() || t(`${prefix}.chatReplyReady.messageFallback`),
      };
    }

    case NOTIFICATION_TYPES.chatCardsWaiting: {
      const payload = notification.payload as Partial<ChatCardsWaitingPayload>;
      const count = payload.cardCount ?? 1;
      return {
        title: t(`${prefix}.chatCardsWaiting.title`, { count }, count),
        message: payload.threadTitle?.trim() || t(`${prefix}.chatCardsWaiting.messageFallback`),
      };
    }

    case NOTIFICATION_TYPES.automationInbox: {
      const count = (notification.payload as Partial<AutomationInboxPayload>).count ?? 1;
      return {
        title: t(`${prefix}.automationInbox.title`),
        message: t(`${prefix}.automationInbox.message`, { count }, count),
      };
    }

    case NOTIFICATION_TYPES.ingestAttention: {
      const reason = (notification.payload as Partial<IngestAttentionPayload>).reason ?? '';
      return {
        title: t(`${prefix}.ingestAttention.title`),
        message: t(`${prefix}.ingestAttention.reasons.${INGEST_ATTENTION_REASONS.includes(reason) ? reason : 'other'}`),
      };
    }

    default:
      return null;
  }
};
