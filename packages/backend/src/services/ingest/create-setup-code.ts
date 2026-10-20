import {
  AMOUNT_GATE_PATTERNS,
  DEFAULT_GATE_STRICTNESS,
  encodeSetupCode,
  SetupCodeError,
  type CreateCardPaymentSetupCodeResponse,
} from '@bt/shared/types';
import { t } from '@i18n/index';
import { ValidationError } from '@js/errors';
import { withTransaction } from '@services/common/with-transaction';
import { createIngestToken, revokeIngestTokens } from '@services/ingest-tokens';

import { readAccessHeaders } from './access-headers.service';
import { getGateStrictness } from './gate-strictness.service';

const DEFAULT_TOKEN_NAME = 'Apple Pay';

const buildDefaultTokenName = () => `${DEFAULT_TOKEN_NAME} ${new Date().toISOString().slice(0, 10)}`;

interface CreateCardPaymentSetupCodeParams {
  userId: number;
  ingestUrl: string;
  tokenName?: string;
  revokePrevious?: boolean;
}

/**
 * Mints a token for the shortcut and folds it, the ingest URL, the stored Cloudflare Access pair
 * and, when the user chose a level other than the default, the amount-gate pattern into a setup
 * code. The raw secret exists only here and inside the returned code: the store keeps its hash, the
 * response's `token` entry omits it, and nothing here logs or persists the code.
 *
 * The token's purpose is set here, never by the client, so `revokePrevious` can retire the earlier
 * setup-code tokens without ever touching a token the user named themselves. The revoke, the mint
 * and the encode share one transaction, so a code that cannot be built leaves the working token
 * in place.
 */
const createCardPaymentSetupCodeImpl = async ({
  userId,
  ingestUrl,
  tokenName,
  revokePrevious = true,
}: CreateCardPaymentSetupCodeParams): Promise<CreateCardPaymentSetupCodeResponse> => {
  if (revokePrevious) await revokeIngestTokens({ userId, purpose: 'card-payment-setup' });

  const { token, secret } = await createIngestToken({
    userId,
    name: tokenName ?? buildDefaultTokenName(),
    purpose: 'card-payment-setup',
  });
  const accessHeaders = await readAccessHeaders({ userId });
  const strictness = await getGateStrictness({ userId });

  try {
    const setupCode = encodeSetupCode({
      url: ingestUrl,
      token: secret,
      ...(accessHeaders && { cfAccessId: accessHeaders.clientId, cfAccessSecret: accessHeaders.clientSecret }),
      // The shortcut carries the standard pattern itself, so only another level travels in the code.
      ...(strictness !== DEFAULT_GATE_STRICTNESS && { gate: AMOUNT_GATE_PATTERNS[strictness] }),
    });

    return { token, setupCode };
  } catch (error) {
    if (error instanceof SetupCodeError) {
      throw new ValidationError({ message: t({ key: 'ingest.setupCodeUnusable' }) });
    }
    throw error;
  }
};

export const createCardPaymentSetupCode = withTransaction(createCardPaymentSetupCodeImpl);
