import { GATE_STRICTNESS_LEVELS, type GateStrictnessDto } from '@bt/shared/types';
import { createController } from '@controllers/helpers/controller-factory';
import { getGateStrictness, setGateStrictness } from '@services/ingest';
import { z } from 'zod';

export const getGateStrictnessController = createController(z.object({}), async ({ user }) => {
  const data: GateStrictnessDto = { strictness: await getGateStrictness({ userId: user.id }) };

  return { data };
});

export const setGateStrictnessController = createController(
  z.object({ body: z.object({ strictness: z.enum(GATE_STRICTNESS_LEVELS) }) }),
  async ({ user, body }) => {
    const data: GateStrictnessDto = {
      strictness: await setGateStrictness({ userId: user.id, strictness: body.strictness }),
    };

    return { data };
  },
);
