import {
  CHAT_ATTACHMENTS_PER_MESSAGE,
  CHAT_ENTITY_KINDS,
  CHAT_MESSAGE_MAX_CHARS,
  CHAT_CLARIFICATION_LIMITS,
} from '@bt/shared/types';
import { recordId } from '@common/lib/zod/custom-types';
import { createController } from '@controllers/helpers/controller-factory';
import { startChatRun } from '@services/chat/runs/start-run';
import { z } from 'zod';

/** Filters are free-form for the model's benefit; a size bound keeps a page context from carrying a payload. */
const PAGE_CONTEXT_FILTERS_MAX_BYTES = 4_096;

/** The rows ticked on a page are a sample for the model; the page says how many there are in all. */
const PAGE_CONTEXT_SELECTION_MAX_IDS = 50;

const entityRefSchema = z.strictObject({ kind: z.enum(CHAT_ENTITY_KINDS), id: recordId() });

const pageContextSchema = z.strictObject({
  route: z.string().max(100).optional(),
  // A kind this server does not know (a newer browser) is left out; it does not fail the message.
  entity: entityRefSchema.optional().catch(undefined),
  focus: entityRefSchema.optional().catch(undefined),
  selection: z
    .strictObject({
      kind: z.enum(CHAT_ENTITY_KINDS),
      ids: z.array(recordId()).max(PAGE_CONTEXT_SELECTION_MAX_IDS),
      total: z.number().int().nonnegative().optional(),
    })
    .optional()
    .catch(undefined),
  filters: z
    .record(z.string().max(100), z.unknown())
    .refine((filters) => JSON.stringify(filters).length <= PAGE_CONTEXT_FILTERS_MAX_BYTES)
    .optional(),
  period: z.strictObject({ from: z.string().max(40), to: z.string().max(40) }).optional(),
});

const clarificationAnswerSchema = z.strictObject({
  clarificationId: recordId(),
  optionIds: z.array(z.string().max(100)).max(CHAT_CLARIFICATION_LIMITS.maxOptions),
  freeText: z.string().max(CHAT_CLARIFICATION_LIMITS.freeTextMaxChars).optional(),
});

const schema = z.object({
  params: z.object({ id: recordId() }),
  body: z
    .strictObject({
      text: z.string().trim().max(CHAT_MESSAGE_MAX_CHARS),
      attachmentIds: z.array(recordId()).max(CHAT_ATTACHMENTS_PER_MESSAGE).default([]),
      pageContext: pageContextSchema.optional(),
      clarificationAnswer: clarificationAnswerSchema.optional(),
    })
    .refine((body) => body.text.length > 0 || body.attachmentIds.length > 0 || body.clarificationAnswer !== undefined, {
      message: 'A message needs text, an attachment or an answer to a question',
      path: ['text'],
    }),
});

export default createController(schema, async ({ user, params, body }) => ({
  data: await startChatRun({
    user,
    threadId: params.id,
    text: body.text,
    attachmentIds: body.attachmentIds,
    pageContext: body.pageContext ?? null,
    clarificationAnswer: body.clarificationAnswer,
  }),
  statusCode: 202,
}));
