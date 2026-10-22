import { findContextApp } from '@bt/shared/types';
import IngestRequests from '@models/ingest-requests.model';
import NotificationSources from '@models/notification-sources.model';

import { decryptNotificationText } from '../event/notification-text';
import { CONTEXT_EXCERPT_MAX_LENGTH } from './context-config';
import type { StoredContext } from './context-types';
import { parseContextNotification, type ParsedContext } from './parse-context-notification';
import { parseContextWithAi } from './parse-context-with-ai';
import { resolveContext } from './resolve-context';
import { ignoreContext } from './settle-context';

const excerptOf = ({ title, subtitle, body }: { title: string; subtitle: string; body: string }): string =>
  [title, subtitle, body].join(' ').replace(/\s+/g, ' ').trim().slice(0, CONTEXT_EXCERPT_MAX_LENGTH);

/**
 * Reads and settles the notification of a context source: the text is read (the rules first, the
 * model when none applies), and a reading that names a store of an order that was not cancelled is
 * matched to its payment (`resolveContext`). Anything else is ignored with its text wiped. A context
 * source never creates a transaction.
 *
 * No model and no rule for the text is `contextUnreadable`: a context note is an extra, so it is not
 * parked on an inbox card.
 */
export const processContextNotification = async ({
  row,
  source,
  locale,
}: {
  row: IngestRequests;
  source: NotificationSources;
  locale: string;
}): Promise<void> => {
  if (!row.textEnc) throw new Error(`Notification request ${row.id} has no stored text.`);

  const text = decryptNotificationText({ textEnc: row.textEnc });
  const appName = typeof row.payload.app === 'string' ? row.payload.app : null;
  const service = findContextApp({ appName: source.appName ?? appName })?.service ?? source.appName ?? appName ?? 'App';

  let parsed: ParsedContext | null = parseContextNotification(text);
  let parser: 'rules' | 'ai' = 'rules';
  let confidence = 1;

  if (!parsed) {
    parser = 'ai';
    confidence = 0.7;
    const read = await parseContextWithAi({ userId: row.userId, text, appName: source.appName ?? appName });
    if (read.status === 'unavailable') {
      await ignoreContext({ requestId: row.id, reason: 'contextUnreadable', parsed: { parser, kind: 'context', confidence: 0 } });

      return;
    }
    parsed = read.context;
  }

  // A status line without a store, a cancelled order and a text that is no order add nothing.
  if (!parsed || !parsed.store || parsed.status === 'cancelled') {
    await ignoreContext({ requestId: row.id, reason: 'info', parsed: { parser, kind: 'context', confidence } });

    return;
  }

  const context: StoredContext = {
    service,
    store: parsed.store,
    status: parsed.status,
    at: typeof row.payload.time === 'string' ? row.payload.time : row.createdAt.toISOString(),
    excerpt: excerptOf(text),
  };

  await resolveContext({ requestId: row.id, context, parser, confidence, locale });
};
