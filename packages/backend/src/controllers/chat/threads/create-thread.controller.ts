import { createController } from '@controllers/helpers/controller-factory';
import { createThread } from '@services/chat/threads/create.service';
import { z } from 'zod';

import { threadTitleSchema } from './shared-schemas';

const schema = z.object({
  body: z.object({ title: threadTitleSchema.optional() }),
});

export default createController(schema, async ({ user, body }) => ({
  data: await createThread({ userId: user.id, title: body.title }),
  statusCode: 201,
}));
