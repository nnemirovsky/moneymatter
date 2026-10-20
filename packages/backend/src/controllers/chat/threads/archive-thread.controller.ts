import { recordId } from '@common/lib/zod/custom-types';
import { createController } from '@controllers/helpers/controller-factory';
import { archiveInboxThread } from '@services/chat/inbox/inbox-thread';
import { z } from 'zod';

const schema = z.object({
  params: z.object({ id: recordId() }),
});

export default createController(schema, async ({ user, params }) => ({
  data: await archiveInboxThread({ userId: user.id, threadId: params.id }),
}));
