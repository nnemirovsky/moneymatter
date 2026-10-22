import type { ContextIgnoreReason, NotificationIgnoreReason, RecordId } from '@bt/shared/types';
import IngestRequests from '@models/ingest-requests.model';
import { withTransaction } from '@services/common/with-transaction';

import type { StoredParse } from '../event/stored-parse';
import type { StoredContext } from './context-types';

const ignoreContextImpl = async ({
  requestId,
  reason,
  parsed,
  context,
}: {
  requestId: RecordId;
  reason: ContextIgnoreReason | NotificationIgnoreReason;
  parsed: Pick<StoredParse, 'parser' | 'kind' | 'confidence'>;
  /** The order the notification belonged to, kept (without its excerpt) so the order's later stages are recognized. */
  context?: StoredContext;
}): Promise<boolean> => {
  const row = await IngestRequests.findOne({ where: { id: requestId }, lock: true });
  if (!row || (row.status !== 'received' && row.status !== 'held')) return false;

  // Nothing worth keeping: the text, the summary and the reading go, only the reduced reading stays (and the
  // order's service and store, when given).
  await row.update({
    status: 'ignored',
    reason,
    textEnc: null,
    summary: null,
    parsed: {
      parser: parsed.parser,
      kind: parsed.kind,
      confidence: parsed.confidence,
      ...(context && { context: { ...context, excerpt: '' } }),
    },
  });

  return true;
};

/** Records a context notification that changed nothing, and wipes its text. A held one can be ignored too. */
export const ignoreContext = withTransaction(ignoreContextImpl);
