import type NotificationSources from '@models/notification-sources.model';

/**
 * How a source is named to the owner: the app, with the sender for a messaging or mail app. It is
 * what a banner says when no payment could be read.
 */
export const describeSource = ({
  source,
  payload,
}: {
  source: Pick<NotificationSources, 'appName' | 'bundleId' | 'sender'> | null;
  payload: Record<string, unknown>;
}): string => {
  const app =
    source?.appName ??
    (typeof payload.app === 'string' ? payload.app : null) ??
    source?.bundleId ??
    (typeof payload.bundleId === 'string' ? payload.bundleId : null);
  const name = app?.trim() || 'notification';

  return source?.sender ? `${name} · ${source.sender}` : name;
};
