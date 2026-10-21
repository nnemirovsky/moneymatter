/** How long an unpinned thread lives after its last message; `null` keeps threads until the user deletes them. */
export const CHAT_RETENTION_OPTIONS = [7, 30, 90, 365] as const;

export type ChatRetentionDays = (typeof CHAT_RETENTION_OPTIONS)[number];

/** What a user who never chose gets. Applied when settings are read, never written into the stored row. */
export const CHAT_DEFAULT_RETENTION_DAYS: ChatRetentionDays = 30;

/**
 * How many resolved items the Automation inbox keeps, newest first; older ones are deleted. Items still
 * waiting for the owner are never deleted and do not count.
 */
export const CHAT_INBOX_KEEP_RESOLVED = { min: 10, max: 1000, default: 100 } as const;

/** What `PUT /chat/settings` answers with. */
export interface ChatSettings {
  retentionDays: ChatRetentionDays | null;
  inboxKeepResolved: number;
}

/** What `PUT /chat/settings` takes: at least one of the settings. */
export type ChatSettingsUpdate = Partial<ChatSettings>;
