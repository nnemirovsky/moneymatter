import { INGEST_SCOPES } from '@bt/shared/types';
import { cardPaymentController } from '@controllers/ingest/card-payment.controller';
import { eventController } from '@controllers/ingest/event.controller';
import { createBaseCurrencyLockCheck } from '@middlewares/check-base-currency-lock';
import { authenticateIngestToken } from '@middlewares/ingest-token-auth';
import { ingestEventRateLimit, ingestProbeRateLimit, ingestTokenRateLimit } from '@middlewares/rate-limit';
import type { NextFunction, Request, Response } from 'express';
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

// A sender probe has a budget of its own, so a burst of chat messages cannot starve a payment notification.
const limitEventByKind = (req: Request, res: Response, next: NextFunction) =>
  (req.body?.kind === 'notificationProbe' ? ingestProbeRateLimit : ingestEventRateLimit)(req, res, next);

// One endpoint for everything the iOS 27 shortcut forwards; `kind` picks the pipeline.
router.post(
  '/event',
  authenticateIngestToken({ scope: INGEST_SCOPES.transactions }),
  checkBaseCurrencyLock,
  limitEventByKind,
  eventController,
);

export default router;
