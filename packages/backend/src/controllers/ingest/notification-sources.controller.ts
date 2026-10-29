import { type AppStoreSearchDto, NOTIFICATION_SOURCE_USER_MODES, type NotificationSourceDto } from '@bt/shared/types';
import { recordId } from '@common/lib/zod/custom-types';
import { createController } from '@controllers/helpers/controller-factory';
import {
  createContextSource,
  deleteNotificationSource,
  listNotificationSources,
  updateNotificationSource,
} from '@services/ingest';
import { chooseSourceApp, resetSourceApp, searchSourceApps } from '@services/ingest/event/source-app.service';
import { z } from 'zod';

export const listNotificationSourcesController = createController(z.object({}), async ({ user }) => {
  const data: NotificationSourceDto[] = await listNotificationSources({ userId: user.id });

  return { data };
});

export const updateNotificationSourceController = createController(
  z.object({
    params: z.object({ id: recordId() }),
    body: z
      .object({
        mode: z.enum(NOTIFICATION_SOURCE_USER_MODES).optional(),
        defaultAccountId: recordId().nullable().optional(),
      })
      .refine((body) => body.mode !== undefined || body.defaultAccountId !== undefined),
  }),
  async ({ user, params, body }) => {
    const data: NotificationSourceDto = await updateNotificationSource({
      userId: user.id,
      id: params.id,
      mode: body.mode,
      defaultAccountId: body.defaultAccountId,
    });

    return { data };
  },
);

export const deleteNotificationSourceController = createController(
  z.object({ params: z.object({ id: recordId() }) }),
  async ({ user, params }) => {
    await deleteNotificationSource({ userId: user.id, id: params.id });

    return { data: { success: true } };
  },
);

export const createContextSourceController = createController(
  z.object({
    body: z.object({
      appName: z.string().trim().min(1).max(255),
      sender: z.string().trim().max(255).nullable().optional(),
    }),
  }),
  async ({ user, body }) => {
    const data: NotificationSourceDto = await createContextSource({
      userId: user.id,
      appName: body.appName,
      sender: body.sender ?? null,
    });

    return { data, statusCode: 201 };
  },
);

export const searchSourceAppsController = createController(
  z.object({
    query: z.object({
      term: z.string().trim().min(2).max(100),
      storefront: z.string().trim().toLowerCase().max(2).optional(),
    }),
  }),
  async ({ user, query }) => {
    const data: AppStoreSearchDto = await searchSourceApps({
      userId: user.id,
      term: query.term,
      storefront: query.storefront,
    });

    return { data };
  },
);

export const chooseSourceAppController = createController(
  z.object({
    params: z.object({ id: recordId() }),
    body: z.object({
      bundleId: z.string().trim().min(1).max(255),
      storefront: z.string().trim().toLowerCase().max(2),
    }),
  }),
  async ({ user, params, body }) => {
    const data: NotificationSourceDto = await chooseSourceApp({
      userId: user.id,
      id: params.id,
      bundleId: body.bundleId,
      storefront: body.storefront,
    });

    return { data };
  },
);

export const resetSourceAppController = createController(
  z.object({ params: z.object({ id: recordId() }) }),
  async ({ user, params }) => {
    const data: NotificationSourceDto = await resetSourceApp({ userId: user.id, id: params.id });

    return { data };
  },
);
