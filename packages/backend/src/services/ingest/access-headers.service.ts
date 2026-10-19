import type { AccessHeadersStatusDto } from '@bt/shared/types';
import { decryptToken, encryptToken } from '@common/utils/encryption';
import IngestSettings from '@models/ingest-settings.model';
import { withTransaction } from '@services/common/with-transaction';

/** How many trailing characters of the client id the hint reveals. */
const CLIENT_ID_HINT_LENGTH = 4;

const NOT_CONFIGURED: AccessHeadersStatusDto = { configured: false, clientIdHint: null };

const buildHint = ({ clientId }: { clientId: string }): string => `…${clientId.slice(-CLIENT_ID_HINT_LENGTH)}`;

/** Whether headers are stored, and the hint for the client id. The secret is never part of it. */
export const getAccessHeadersStatus = async ({ userId }: { userId: number }): Promise<AccessHeadersStatusDto> => {
  const settings = await IngestSettings.findByPk(userId);

  if (!settings?.accessClientIdEnc || !settings.accessClientSecretEnc) return NOT_CONFIGURED;

  return {
    configured: true,
    clientIdHint: buildHint({ clientId: decryptToken(settings.accessClientIdEnc) }),
  };
};

/**
 * The stored pair in clear text, for the setup-code builder only. It never goes into an API
 * response or a log line.
 */
export const readAccessHeaders = async ({
  userId,
}: {
  userId: number;
}): Promise<{ clientId: string; clientSecret: string } | null> => {
  const settings = await IngestSettings.findByPk(userId);

  if (!settings?.accessClientIdEnc || !settings.accessClientSecretEnc) return null;

  return {
    clientId: decryptToken(settings.accessClientIdEnc),
    clientSecret: decryptToken(settings.accessClientSecretEnc),
  };
};

const setAccessHeadersImpl = async ({
  userId,
  clientId,
  clientSecret,
}: {
  userId: number;
  clientId: string;
  clientSecret: string;
}): Promise<AccessHeadersStatusDto> => {
  await IngestSettings.upsert({
    userId,
    accessClientIdEnc: encryptToken(clientId),
    accessClientSecretEnc: encryptToken(clientSecret),
  });

  return { configured: true, clientIdHint: buildHint({ clientId }) };
};

export const setAccessHeaders = withTransaction(setAccessHeadersImpl);

const clearAccessHeadersImpl = async ({ userId }: { userId: number }): Promise<AccessHeadersStatusDto> => {
  await IngestSettings.destroy({ where: { userId } });

  return NOT_CONFIGURED;
};

export const clearAccessHeaders = withTransaction(clearAccessHeadersImpl);
