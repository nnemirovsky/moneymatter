import { API_HTTP, API_VER } from '@/api/api-base-url';

const INGEST_PATH = '/ingest/card-payment';

/**
 * The absolute URL the shortcut posts to. The shortcut runs on a phone, so a relative path is no
 * use: in same-origin mode `API_HTTP` is empty and the page's own origin stands in for it.
 */
export const buildIngestUrl = (): string => `${API_HTTP || window.location.origin}${API_VER}${INGEST_PATH}`;
