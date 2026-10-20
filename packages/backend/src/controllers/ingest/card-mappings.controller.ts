import { CARD_LAST_DIGITS_PATTERN, CURRENCY_CODE_MAX_LENGTH, type CardMappingDto } from '@bt/shared/types';
import { recordId } from '@common/lib/zod/custom-types';
import { createController } from '@controllers/helpers/controller-factory';
import {
  CARD_LABEL_MAX_LENGTH,
  createCardMapping,
  deleteCardMapping,
  listCardMappings,
  updateCardMapping,
} from '@services/ingest';
import { z } from 'zod';

const cardLabelSchema = z.string().trim().min(1).max(CARD_LABEL_MAX_LENGTH);
const lastDigitsSchema = z.string().trim().regex(CARD_LAST_DIGITS_PATTERN);
// Whether the code is a currency the account actually has is the service's call.
const currencyCodeSchema = z.string().trim().min(1).max(CURRENCY_CODE_MAX_LENGTH);

export const listCardMappingsController = createController(z.object({}), async ({ user }) => {
  const data: CardMappingDto[] = await listCardMappings({ userId: user.id });

  return { data };
});

export const createCardMappingController = createController(
  z.object({
    body: z.object({
      cardLabel: cardLabelSchema,
      accountId: recordId(),
      currencyCode: currencyCodeSchema.nullable().optional(),
      lastDigits: lastDigitsSchema.nullable().optional(),
    }),
  }),
  async ({ user, body }) => {
    const data: CardMappingDto = await createCardMapping({
      userId: user.id,
      cardLabel: body.cardLabel,
      accountId: body.accountId,
      currencyCode: body.currencyCode,
      lastDigits: body.lastDigits,
    });

    return { data, statusCode: 201 };
  },
);

export const updateCardMappingController = createController(
  z.object({
    params: z.object({ id: recordId() }),
    body: z
      .object({
        cardLabel: cardLabelSchema.optional(),
        accountId: recordId().optional(),
        lastDigits: lastDigitsSchema.nullable().optional(),
      })
      .refine((body) => body.cardLabel !== undefined || body.accountId !== undefined || body.lastDigits !== undefined),
  }),
  async ({ user, params, body }) => {
    const data: CardMappingDto = await updateCardMapping({
      userId: user.id,
      id: params.id,
      cardLabel: body.cardLabel,
      accountId: body.accountId,
      lastDigits: body.lastDigits,
    });

    return { data };
  },
);

export const deleteCardMappingController = createController(
  z.object({
    params: z.object({ id: recordId() }),
  }),
  async ({ user, params }) => {
    await deleteCardMapping({ userId: user.id, id: params.id });

    return { data: { success: true } };
  },
);
