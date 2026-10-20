import { DEFAULT_GATE_STRICTNESS, type GateStrictness } from '@bt/shared/types';
import IngestSettings from '@models/ingest-settings.model';
import { withTransaction } from '@services/common/with-transaction';

/** How strict the amount gate is for this user, on the device and on the server. */
export const getGateStrictness = async ({ userId }: { userId: number }): Promise<GateStrictness> => {
  const settings = await IngestSettings.findByPk(userId, { attributes: ['gateStrictness'] });

  return settings?.gateStrictness ?? DEFAULT_GATE_STRICTNESS;
};

const setGateStrictnessImpl = async ({
  userId,
  strictness,
}: {
  userId: number;
  strictness: GateStrictness;
}): Promise<GateStrictness> => {
  await IngestSettings.upsert({ userId, gateStrictness: strictness }, { fields: ['userId', 'gateStrictness'] });

  return strictness;
};

/** The shortcut applies the same level from its setup code, so a change needs a new code. */
export const setGateStrictness = withTransaction(setGateStrictnessImpl);
