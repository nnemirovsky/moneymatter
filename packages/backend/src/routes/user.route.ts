import { FEATURES } from '@bt/shared/types';
import { categorizationCandidatesController } from '@controllers/ai-categorization/candidates.controller';
import { categorizationStatusController } from '@controllers/ai-categorization/categorization-status.controller';
import { categorizationHistoryController } from '@controllers/ai-categorization/history.controller';
import { triggerCategorizationController } from '@controllers/ai-categorization/trigger-categorization.controller';
import { listAuthSessionsController } from '@controllers/auth-sessions.controller';
import { activeRestoreStatusController } from '@controllers/backup/active-restore-status.controller';
import { exportBackupController } from '@controllers/backup/export-backup.controller';
import { restoreBackupController } from '@controllers/backup/restore-backup.controller';
import { restoreStatusController } from '@controllers/backup/restore-status.controller';
import addUserCurrencies from '@controllers/currencies/add-user-currencies';
import changeBaseCurrencyStatus from '@controllers/currencies/change-base-currency-status.controller';
import changeBaseCurrency from '@controllers/currencies/change-base-currency.controller';
import {
  createCustomCurrency,
  deleteCustomCurrency,
  listCustomCurrencies,
  updateCustomCurrency,
} from '@controllers/currencies/custom-currencies';
import editCurrencyExchangeRate from '@controllers/currencies/edit-currency-exchange-rate';
import { getCurrencyRateHistory } from '@controllers/currencies/rate-history';
import {
  findCoingeckoCoins,
  testCurrencyRateSource,
  updateCurrencyRateSource,
} from '@controllers/currencies/rate-source';
import { exportDataController } from '@controllers/data-export/export-data.controller';
import { getAccessHeadersController, setAccessHeadersController } from '@controllers/ingest/access-headers.controller';
import {
  createCardMappingController,
  deleteCardMappingController,
  listCardMappingsController,
  updateCardMappingController,
} from '@controllers/ingest/card-mappings.controller';
import {
  dismissCardPaymentRequestController,
  listCardPaymentRequestsController,
  listUnconfirmedCardPaymentsController,
  listUnlinkedCardsController,
  retryCardPaymentRequestController,
} from '@controllers/ingest/card-payment-requests.controller';
import { createCardPaymentSetupCodeController } from '@controllers/ingest/card-payment-setup-code.controller';
import {
  getGateStrictnessController,
  setGateStrictnessController,
} from '@controllers/ingest/gate-strictness.controller';
import {
  createIngestTokenController,
  listIngestTokensController,
  revokeIngestTokenController,
} from '@controllers/ingest/ingest-tokens.controller';
import {
  deleteNotificationSourceController,
  listNotificationSourcesController,
  updateNotificationSourceController,
} from '@controllers/ingest/notification-sources.controller';
import { getConnectedAppsController, revokeConnectedAppController } from '@controllers/mcp/connected-apps.controller';
import {
  cancelCliAuthSessionController,
  getCliAuthSessionController,
  getCliAvailabilityController,
  startCliAuthSessionController,
  submitCliAuthCodeController,
} from '@controllers/user-settings/ai-cli';
import {
  createConnectionController,
  deleteConnectionController,
  getConnectionsController,
  listConnectionModelsController,
  setDefaultConnectionController,
  testConnectionController,
  updateConnectionController,
} from '@controllers/user-settings/ai-connections';
import {
  getCustomInstructionsController,
  setCustomInstructionsController,
} from '@controllers/user-settings/ai-custom-instructions';
import {
  getFeatureConfigController,
  getFeaturesStatus,
  resetFeatureConfigController,
  setFeatureConfigController,
} from '@controllers/user-settings/ai-feature-settings';
import getUserSettings from '@controllers/user-settings/get-settings';
import { getOnboarding, updateOnboarding } from '@controllers/user-settings/onboarding';
import patchUserSettings from '@controllers/user-settings/patch-settings';
import updateUserSettings from '@controllers/user-settings/update-settings';
import {
  deleteUser,
  deleteUserCurrency,
  editUserCurrency,
  getCurrenciesExchangeRates,
  getUser,
  getUserBaseCurrency,
  getUserCurrencies,
  removeUserCurrencyExchangeRate,
  setBaseUserCurrency,
  startFeatureTrial,
  updateUser,
  wipeUserData,
} from '@controllers/user.controller';
import { adminOnly } from '@middlewares/admin-only';
import { authenticateSession } from '@middlewares/better-auth';
import { blockDemoUsers } from '@middlewares/block-demo-users';
import { checkBaseCurrencyLock } from '@middlewares/check-base-currency-lock';
import { requireFeature, requireFireSettingsAccess } from '@middlewares/entitlements';
import {
  aiConnectionModelsRateLimit,
  aiConnectionProbeRateLimit,
  backupRateLimit,
  backupRestoreRateLimit,
  dataExportRateLimit,
  ingestSettingsWriteRateLimit,
  rateSourceSaveRateLimit,
  rateSourceTestRateLimit,
} from '@middlewares/rate-limit';
import { selfHostOnly } from '@middlewares/self-host-only';
import { Router } from 'express';

const router = Router({});

router.use(authenticateSession);

router.get('/', getUser);
// Read here rather than through better-auth's /list-sessions, which refuses sessions older than its freshAge.
router.get('/sessions', listAuthSessionsController);
router.post('/feature-trials/:feature', startFeatureTrial);
router.put('/update', updateUser);
router.delete('/delete', checkBaseCurrencyLock, deleteUser);
router.post('/wipe-data', checkBaseCurrencyLock, wipeUserData);
router.post('/data-export', requireFeature(FEATURES.data_export), dataExportRateLimit, exportDataController);
router.post('/backup', requireFeature(FEATURES.backup_export), backupRateLimit, exportBackupController);
router.post(
  '/backup/restore',
  requireFeature(FEATURES.backup_restore),
  // Guard the most destructive write like every other mutating route: 423 while a
  // base-currency migration (or an in-flight restore, which takes the same lock) runs.
  checkBaseCurrencyLock,
  backupRestoreRateLimit,
  restoreBackupController,
);
router.get('/backup/restore/status', activeRestoreStatusController);
router.get('/backup/restore/status/:jobId', restoreStatusController);

router.get('/currencies', getUserCurrencies);
router.get('/currencies/base', getUserBaseCurrency);
router.get('/currencies/rates', getCurrenciesExchangeRates);

router.post('/currencies', checkBaseCurrencyLock, addUserCurrencies);
// Custom currencies change which decimals amounts round to, so they sit behind the same
// base-currency guard as every other write that feeds amounts.
router.get('/currencies/custom', listCustomCurrencies);
// Coin lookup for the CoinGecko rate-source editor; read-only, so it is not behind the guard.
router.get('/currencies/coingecko/search', findCoingeckoCoins);
router.post('/currencies/custom', checkBaseCurrencyLock, createCustomCurrency);
router.put('/currencies/custom/:code', checkBaseCurrencyLock, updateCustomCurrency);
router.delete('/currencies/custom/:code', checkBaseCurrencyLock, deleteCustomCurrency);
router.post('/currencies/base', checkBaseCurrencyLock, setBaseUserCurrency);
// The source decides which rate prices a currency's amounts, so it sits behind the same guard. A save
// fetches rates and values saved rows again, so it is limited like the preview.
router.put('/currencies/:code/rate-source', checkBaseCurrencyLock, rateSourceSaveRateLimit, updateCurrencyRateSource);
// The dated rates stored for a custom currency; a read, so it is not behind the guard.
router.get('/currencies/:code/rate-history', getCurrencyRateHistory);
// A preview saves nothing, so it is not behind the base-currency guard.
router.post('/currencies/:code/rate-source/test', rateSourceTestRateLimit, testCurrencyRateSource);
// The enqueue route owns its own dedupe: its NX lock acquisition returns the proper 423,
// so guarding it here would reject the request that is supposed to start the change.
router.post('/currencies/change-base', changeBaseCurrency);
// Read-only status any device polls to drive the blocking overlay; GET routes are
// never lock-guarded.
router.get('/currencies/change-base/status', changeBaseCurrencyStatus);

router.put('/currency', checkBaseCurrencyLock, editUserCurrency);
router.put('/currency/rates', checkBaseCurrencyLock, editCurrencyExchangeRate);

router.delete('/currency', checkBaseCurrencyLock, deleteUserCurrency);
router.delete('/currency/rates', checkBaseCurrencyLock, removeUserCurrencyExchangeRate);

router.get('/settings', getUserSettings);
router.put('/settings', updateUserSettings);
router.patch('/settings', requireFireSettingsAccess, patchUserSettings);

// Onboarding (Quick Start)
router.get('/settings/onboarding', getOnboarding);
router.put('/settings/onboarding', updateOnboarding);

// AI connections (the user's own models)
router.get('/settings/ai/connections', getConnectionsController);
router.post('/settings/ai/connections', aiConnectionProbeRateLimit, createConnectionController);
router.post('/settings/ai/connections/test', aiConnectionProbeRateLimit, testConnectionController);
router.post('/settings/ai/connections/models', aiConnectionModelsRateLimit, listConnectionModelsController);
router.put('/settings/ai/connections/:id', aiConnectionProbeRateLimit, updateConnectionController);
router.delete('/settings/ai/connections/:id', deleteConnectionController);
router.post('/settings/ai/connections/:id/default', setDefaultConnectionController);

// Subscription CLI providers (Claude Code, Codex): sign-in sessions for the instance admin of a self-hosted
// deployment. Availability answers every signed-in user so the UI and API clients can tell why it is closed.
router.get('/settings/ai/cli/availability', getCliAvailabilityController);
router.post(
  '/settings/ai/cli/auth-sessions',
  selfHostOnly,
  adminOnly,
  aiConnectionProbeRateLimit,
  startCliAuthSessionController,
);
router.get('/settings/ai/cli/auth-sessions/:id', selfHostOnly, adminOnly, getCliAuthSessionController);
router.post(
  '/settings/ai/cli/auth-sessions/:id/code',
  selfHostOnly,
  adminOnly,
  aiConnectionProbeRateLimit,
  submitCliAuthCodeController,
);
router.delete('/settings/ai/cli/auth-sessions/:id', selfHostOnly, adminOnly, cancelCliAuthSessionController);

// AI Feature configuration
router.get('/settings/ai/features', getFeaturesStatus);
router.get('/settings/ai/features/:feature', getFeatureConfigController);
router.put('/settings/ai/features/:feature', setFeatureConfigController);
router.delete('/settings/ai/features/:feature', resetFeatureConfigController);

// AI Custom Instructions
router.get('/settings/ai/custom-instructions', getCustomInstructionsController);
router.put('/settings/ai/custom-instructions', setCustomInstructionsController);

// AI Categorization
router.get('/ai/categorization/status', categorizationStatusController);
router.get('/ai/categorization/candidates', categorizationCandidatesController);
router.get('/ai/categorization/history', categorizationHistoryController);
router.post(
  '/ai/categorization/trigger',
  // Demo users would fall back to the operator's server-side AI key.
  blockDemoUsers,
  triggerCategorizationController,
);

// MCP Connected Apps
router.get('/settings/mcp/connected-apps', getConnectedAppsController);
router.delete('/settings/mcp/connected-apps/:clientId', revokeConnectedAppController);

// Ingest tokens: personal credentials for machine clients (the Apple Pay shortcut). The secret is
// returned by the create response only. Demo users cannot mint credentials.
router.get('/settings/ingest-tokens', listIngestTokensController);
router.post('/settings/ingest-tokens', blockDemoUsers, ingestSettingsWriteRateLimit, createIngestTokenController);
router.delete('/settings/ingest-tokens/:id', revokeIngestTokenController);

// Card links: which account a card's payments are logged on, per currency with a default row.
router.get('/settings/card-mappings', listCardMappingsController);
router.get('/settings/card-mappings/unlinked', listUnlinkedCardsController);
router.post('/settings/card-mappings', createCardMappingController);
router.patch('/settings/card-mappings/:id', updateCardMappingController);
router.delete('/settings/card-mappings/:id', deleteCardMappingController);

// Card payments that did not log on arrival: the waiting list, retry (writes a transaction, so it
// honors the base-currency lock), dismiss, and plans the bank never confirmed.
router.get('/settings/card-payments/requests', listCardPaymentRequestsController);
router.post('/settings/card-payments/requests/:id/retry', checkBaseCurrencyLock, retryCardPaymentRequestController);
router.delete('/settings/card-payments/requests/:id', dismissCardPaymentRequestController);
router.get('/settings/card-payments/unconfirmed', listUnconfirmedCardPaymentsController);

// Cloudflare Access service-token headers for the setup code. The secret is write-only. Demo users
// cannot store credentials.
router.get('/settings/card-payments/access-headers', getAccessHeadersController);
router.put(
  '/settings/card-payments/access-headers',
  blockDemoUsers,
  ingestSettingsWriteRateLimit,
  setAccessHeadersController,
);

// How strict the amount gate is, on the device and on the server. A change needs a new setup code.
router.get('/settings/card-payments/gate-strictness', getGateStrictnessController);
router.put('/settings/card-payments/gate-strictness', setGateStrictnessController);

// Apps and senders that send notifications: the user approves, mutes or forgets each, and picks the
// account its payments land on when the text names no card.
router.get('/settings/notification-sources', listNotificationSourcesController);
router.patch('/settings/notification-sources/:id', updateNotificationSourceController);
router.delete('/settings/notification-sources/:id', deleteNotificationSourceController);

// The setup code bundles the ingest URL, a freshly minted token and the stored Cloudflare Access
// pair. It is shown once and never stored, so there is no GET. Demo users cannot mint credentials.
router.post(
  '/settings/card-payments/setup-code',
  blockDemoUsers,
  ingestSettingsWriteRateLimit,
  createCardPaymentSetupCodeController,
);

export default router;
