import type { IosAutomationIconsDto } from '@bt/shared/types';
import { createController } from '@controllers/helpers/controller-factory';
import { getIosAutomationIcons } from '@services/ingest/source-icons/ios-automation-icons';
import { z } from 'zod';

export const getIosAutomationIconsController = createController(z.object({}), async () => {
  const data: IosAutomationIconsDto = await getIosAutomationIcons();

  return { data };
});
