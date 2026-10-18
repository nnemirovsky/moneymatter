import { updateChatSettings } from '@controllers/chat/settings.controller';
import createThread from '@controllers/chat/threads/create-thread.controller';
import deleteThread from '@controllers/chat/threads/delete-thread.controller';
import getThread from '@controllers/chat/threads/get-thread.controller';
import listThreads from '@controllers/chat/threads/list-threads.controller';
import updateThread from '@controllers/chat/threads/update-thread.controller';
import { authenticateSession } from '@middlewares/better-auth';
import { blockDemoUsers } from '@middlewares/block-demo-users';
import { Router } from 'express';

const router = Router({});

router.use(authenticateSession);

// No write here carries `checkBaseCurrencyLock`: threads and retention hold no monetary data. The
// routes that apply a card to the user's finances are the guarded ones.
//
// A read-only (lapsed plan) user may use these writes too; the allowed set lives in
// `READ_ONLY_ROUTE_PATTERNS` (`middlewares/entitlements.ts`).

router.get('/threads', listThreads);
router.post('/threads', blockDemoUsers, createThread);
router.get('/threads/:id', getThread);
router.patch('/threads/:id', updateThread);
router.delete('/threads/:id', deleteThread);

router.put('/settings', updateChatSettings);

export default router;
