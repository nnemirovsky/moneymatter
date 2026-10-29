import type { NotificationSourceDto } from '@bt/shared/types';

/** What a source is called in a list: its app name, else its bundle id, else `fallback`. */
export const getSourceName = ({
  source,
  fallback,
}: {
  source: Pick<NotificationSourceDto, 'appName' | 'bundleId'>;
  fallback: string;
}): string => source.appName || source.bundleId || fallback;

/** The props of the source label: sender first, then the app with its icon. */
export const sourceLabelOf = ({
  source,
}: {
  source: Pick<NotificationSourceDto, 'appName' | 'bundleId' | 'sender' | 'iconUrl'>;
}) => ({
  appName: source.appName,
  bundleId: source.bundleId,
  sender: source.sender,
  iconUrl: source.iconUrl,
});
