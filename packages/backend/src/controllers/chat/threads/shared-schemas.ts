import { CHAT_THREAD_TITLE_MAX_CHARS } from '@bt/shared/types';
import { z } from 'zod';

/** A thread title as typed: trimmed, 1 to 120 characters. */
export const threadTitleSchema = z.string().trim().min(1).max(CHAT_THREAD_TITLE_MAX_CHARS);
