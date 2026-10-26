import {
  type AutomationInboxPayload,
  type ChatCardsWaitingPayload,
  type ChatReplyReadyPayload,
  type IngestAttentionPayload,
  NOTIFICATION_TYPES,
  type NotificationType,
} from '@bt/shared/types';
import { t } from '@i18n/index';

/** The notification types the assistant push group owns. */
const ASSISTANT_NOTIFICATION_TYPES: readonly NotificationType[] = [
  NOTIFICATION_TYPES.chatReplyReady,
  NOTIFICATION_TYPES.chatCardsWaiting,
  NOTIFICATION_TYPES.automationInbox,
  NOTIFICATION_TYPES.ingestAttention,
];

export const isAssistantNotificationType = ({ type }: { type: NotificationType }): boolean =>
  ASSISTANT_NOTIFICATION_TYPES.includes(type);

/** Park reasons that have their own sentence; any other reason takes the generic one. */
const INGEST_ATTENTION_REASONS = [
  'unknownCard',
  'rateUnavailable',
  'processingFailed',
  'aiUnavailable',
  'aiCapReached',
  'aiLimitReached',
  'aiQuotaWait',
];

/**
 * The title of an assistant notification, in `locale`. It carries ids' worth of facts only: a count,
 * or what happened. The text of a message, a card or a bank notification never reaches it.
 */
export const renderAssistantTitle = ({
  type,
  payload,
  locale,
}: {
  type: NotificationType;
  payload: Record<string, any>;
  locale: string;
}): string => {
  switch (type) {
    case NOTIFICATION_TYPES.chatReplyReady:
      return (payload as ChatReplyReadyPayload).runStatus === 'failed'
        ? t({ key: 'notifications.push.chatReplyReady.titleFailed', locale })
        : t({ key: 'notifications.push.chatReplyReady.title', locale });
    case NOTIFICATION_TYPES.chatCardsWaiting:
      return t({
        key: 'notifications.push.chatCardsWaiting.title',
        variables: { count: (payload as ChatCardsWaitingPayload).cardCount },
        locale,
      });
    case NOTIFICATION_TYPES.automationInbox:
      return t({ key: 'notifications.push.automationInbox.title', locale });
    default:
      return t({ key: 'notifications.push.ingestAttention.title', locale });
  }
};

/**
 * The text under an assistant push's title, or null for a type this group does not own. Only counts,
 * the thread's title and the park reason are used.
 */
export const renderAssistantBody = ({
  type,
  payload,
  locale,
}: {
  type: NotificationType;
  payload: Record<string, any>;
  locale: string;
}): string | null => {
  switch (type) {
    case NOTIFICATION_TYPES.chatReplyReady: {
      const { threadTitle } = payload as Partial<ChatReplyReadyPayload>;
      return threadTitle?.trim() || t({ key: 'notifications.push.chatReplyReady.bodyFallback', locale });
    }
    case NOTIFICATION_TYPES.chatCardsWaiting: {
      const { threadTitle } = payload as Partial<ChatCardsWaitingPayload>;
      return threadTitle?.trim() || t({ key: 'notifications.push.chatCardsWaiting.bodyFallback', locale });
    }
    case NOTIFICATION_TYPES.automationInbox:
      return t({
        key: 'notifications.push.automationInbox.body',
        variables: { count: (payload as Partial<AutomationInboxPayload>).count ?? 1 },
        locale,
      });
    case NOTIFICATION_TYPES.ingestAttention: {
      const { reason } = payload as Partial<IngestAttentionPayload>;
      return INGEST_ATTENTION_REASONS.includes(reason ?? '')
        ? t({ key: `notifications.push.ingestAttention.reasons.${reason}`, locale })
        : t({ key: 'notifications.push.ingestAttention.reasons.other', locale });
    }
    default:
      return null;
  }
};
