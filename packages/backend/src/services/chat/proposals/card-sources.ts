import type { ChatProposalCard, NotificationSourceDisplay } from '@bt/shared/types';
import type ChatProposals from '@models/chat-proposals.model';
import IngestRequests from '@models/ingest-requests.model';
import NotificationSources from '@models/notification-sources.model';
import { refreshDueSourceIcons } from '@services/ingest/source-icons/source-icon-cache';

const SET_SOURCE_TOOL = 'set_notification_source';
const LOG_REQUEST_TOOL = 'log_ingest_request';

const text = ({ value }: { value: unknown }): string | null => (typeof value === 'string' && value ? value : null);

/**
 * Gives the cards of the Automation inbox that are about a notification source the source's display (its app and
 * sender, and the app's icon as it is now). The card shows a parked payment with the source it came from, and a
 * source update with the source it concerns. A card about anything else is left as it is.
 */
export async function withNotificationSources({
  userId,
  rows,
  cards,
}: {
  userId: number;
  rows: ChatProposals[];
  cards: ChatProposalCard[];
}): Promise<ChatProposalCard[]> {
  const requestIds = rows.flatMap((row) =>
    row.toolName === LOG_REQUEST_TOOL ? (text({ value: row.args.requestId }) ?? []) : [],
  );
  const requests =
    requestIds.length > 0
      ? await IngestRequests.findAll({ where: { id: requestIds, userId }, attributes: ['id', 'sourceId'] })
      : [];
  const sourceOfRequest = new Map(requests.map((request) => [request.id as string, request.sourceId]));

  const sourceIdOf = (row: ChatProposals): string | null => {
    if (row.toolName === SET_SOURCE_TOOL) return text({ value: row.args.sourceId });
    if (row.toolName === LOG_REQUEST_TOOL)
      return sourceOfRequest.get(text({ value: row.args.requestId }) ?? '') ?? null;
    return null;
  };

  const sourceIds = [...new Set(rows.flatMap((row) => sourceIdOf(row) ?? []))];
  if (sourceIds.length === 0) return cards;

  const sources = await NotificationSources.findAll({ where: { id: sourceIds, userId } });
  // A source seen for the first time gets its icon in the background; the card shows it the next time it is read.
  refreshDueSourceIcons({ sources });

  const displayOf = new Map(
    sources.map((source): [string, NotificationSourceDisplay] => [
      source.id as string,
      {
        appName: source.appName,
        // The app the owner chose is the app of the source, whatever bundle id the shortcut sends.
        bundleId: source.iconOverride ? source.resolvedBundleId : (source.bundleId ?? source.resolvedBundleId),
        sender: source.sender,
        iconUrl: source.iconUrl,
      },
    ]),
  );

  return cards.map((card, index) => {
    const display = displayOf.get(sourceIdOf(rows[index]!) ?? '');
    return display ? { ...card, source: display } : card;
  });
}
