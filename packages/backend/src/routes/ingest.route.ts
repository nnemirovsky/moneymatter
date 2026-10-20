import { INGEST_SCOPES } from '@bt/shared/types';
import { cardPaymentController } from '@controllers/ingest/card-payment.controller';
import { eventController } from '@controllers/ingest/event.controller';
import { createBaseCurrencyLockCheck } from '@middlewares/check-base-currency-lock';
import { authenticateIngestToken } from '@middlewares/ingest-token-auth';
import { ingestTokenRateLimit } from '@middlewares/rate-limit';
import { Router } from 'express';

const router = Router();

// The shortcut shows the 423 message as a banner, so it says the payment was not saved.
const checkBaseCurrencyLock = createBaseCurrencyLockCheck({ messageKey: 'ingest.busy' });

// Machine clients (the Apple Pay shortcut) authenticate with a personal ingest token, never a session.
router.post(
  '/card-payment',
  authenticateIngestToken({ scope: INGEST_SCOPES.transactions }),
  checkBaseCurrencyLock,
  ingestTokenRateLimit,
  cardPaymentController,
);

// One endpoint for everything the iOS 27 shortcut forwards; `kind` picks the pipeline.
router.post(
  '/event',
  authenticateIngestToken({ scope: INGEST_SCOPES.transactions }),
  checkBaseCurrencyLock,
  ingestTokenRateLimit,
  eventController,
);

export default router;
