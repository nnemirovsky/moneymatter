import { AI_PROVIDER } from './settings';

/**
 * How hard a reasoning model thinks before it answers. One scale for every provider; what each one accepts is
 * `getAiEffortOptions`. A model without a stored level runs on its provider's own default.
 */
export const AI_EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type AiEffort = (typeof AI_EFFORT_LEVELS)[number];

export const isAiEffort = (value: unknown): value is AiEffort =>
  typeof value === 'string' && (AI_EFFORT_LEVELS as readonly string[]).includes(value);

const CLAUDE_FAMILY = /^(?:claude-)?(opus|sonnet|fable)(?:-(\d+)(?:-(\d+))?)?(?:-\d{8})?$/;
const OPENAI_REASONING = /^(?:gpt-[56]|o[134])/;
/** A date stamp (`claude-opus-4-20250514`), which is not a minor version. */
const MINOR_VERSION_MAX = 99;

/**
 * Whether a Claude model takes an effort level. The effort setting starts with the 4.5 generation; an alias
 * (`opus`, `sonnet`, `fable`) names the newest model of its family, so it always does. Haiku never does.
 */
const claudeEfforts = ({ model }: { model: string }): AiEffort[] => {
  const match = CLAUDE_FAMILY.exec(model.toLowerCase());
  if (!match) return [];

  const [, family, majorText, minorText] = match;
  if (majorText !== undefined) {
    const major = Number(majorText);
    const minor = minorText !== undefined && Number(minorText) <= MINOR_VERSION_MAX ? Number(minorText) : 0;
    if (major < 4 || (major === 4 && minor < 5)) return [];
  }

  return family === 'sonnet' ? ['low', 'medium', 'high'] : ['low', 'medium', 'high', 'xhigh', 'max'];
};

const openAiEfforts = ({ model }: { model: string }): AiEffort[] => {
  const id = model.toLowerCase();
  if (!OPENAI_REASONING.test(id)) return [];
  // The o-series and the Codex-tuned models have no minimal setting.
  return id.startsWith('o') || id.includes('codex') ? ['low', 'medium', 'high'] : ['minimal', 'low', 'medium', 'high'];
};

/**
 * The effort levels a provider and model accept, in order from lightest to heaviest; empty when the model has
 * no such setting (then the picker is not offered and nothing is sent). A custom endpoint and Google list none:
 * their reasoning controls differ by model, and a level a model refuses fails the run.
 */
export function getAiEffortOptions({ provider, model }: { provider: AI_PROVIDER; model: string }): AiEffort[] {
  switch (provider) {
    case AI_PROVIDER.anthropic:
    case AI_PROVIDER.claudeCode:
      return claudeEfforts({ model });
    case AI_PROVIDER.openai:
    case AI_PROVIDER.codex:
      return openAiEfforts({ model });
    default:
      return [];
  }
}

export function isAiEffortSupported({
  provider,
  model,
  effort,
}: {
  provider: AI_PROVIDER;
  model: string;
  effort: AiEffort;
}): boolean {
  return getAiEffortOptions({ provider, model }).includes(effort);
}
