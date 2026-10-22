import { type ChatBadgeTotal } from '@bt/shared/types';
import { createController } from '@controllers/helpers/controller-factory';
import { getChatBadgeTotal } from '@services/chat/threads/thread-badges';
import { z } from 'zod';

const schema = z.object({});

/** `GET /chat/badge`: what waits across every thread, for the AI chat entry of the navigation. */
export default createController(schema, async ({ user }) => {
  const data: ChatBadgeTotal = { total: await getChatBadgeTotal({ userId: user.id }) };
  return { data };
});
