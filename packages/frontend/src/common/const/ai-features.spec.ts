import { AI_FEATURE } from '@bt/shared/types';
import { MessageSquareIcon } from '@lucide/vue';
import { describe, expect, it } from 'vitest';

import { getAIFeatureDisplayInfo } from './ai-features';

describe('getAIFeatureDisplayInfo', () => {
  it.each(Object.values(AI_FEATURE))('describes %s', (feature) => {
    const info = getAIFeatureDisplayInfo({ feature });

    expect(info.nameKey).toMatch(/^common\.aiFeatures\./);
    expect(info.modelGuide.needs.length).toBeGreaterThan(0);
  });

  it('describes chat as a smart-tier, tool-calling feature that reads files and writes long answers', () => {
    const info = getAIFeatureDisplayInfo({ feature: AI_FEATURE.chat });

    expect(info.icon).toBe(MessageSquareIcon);
    expect(info.nameKey).toBe('common.aiFeatures.chat.name');
    expect(info.descriptionKey).toBe('common.aiFeatures.chat.description');
    expect(info.modelGuide).toEqual({
      tier: 'smart',
      needs: ['toolCalling', 'readsFiles', 'longAnswers'],
      whyKey: 'settings.ai.modelGuide.why.chat',
      picksKey: 'settings.ai.modelGuide.picks.chat',
    });
  });
});
