import type { NotificationSourceDto } from '@bt/shared/types';

/** What a source is called in a list: its app name, else its bundle id, else `fallback`. */
export const getSourceName = ({
  source,
  fallback,
}: {
  source: Pick<NotificationSourceDto, 'appName' | 'bundleId'>;
  fallback: string;
}): string => source.appName || source.bundleId || fallback;
