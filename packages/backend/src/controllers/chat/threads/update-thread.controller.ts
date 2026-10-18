import { recordId } from '@common/lib/zod/custom-types';
import { createController } from '@controllers/helpers/controller-factory';
import { updateThread } from '@services/chat/threads/update.service';
import { z } from 'zod';

import { threadTitleSchema } from './shared-schemas';

const schema = z.object({
  params: z.object({ id: recordId() }),
  body: z
    .object({ title: threadTitleSchema.optional(), pinned: z.boolean().optional() })
    .refine((body) => body.title !== undefined || body.pinned !== undefined, {
      message: 'Provide a title or pinned',
    }),
});

export default createController(schema, async ({ user, params, body }) => ({
  data: await updateThread({ userId: user.id, threadId: params.id, title: body.title, pinned: body.pinned }),
}));
