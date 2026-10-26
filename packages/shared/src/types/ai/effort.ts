import { AI_PROVIDER } from './settings';

/**
 * How hard a reasoning model thinks before it answers. One scale for every provider; what each one accepts is
 * `getAiEffortOptions`. A model without a stored level runs on its provider's own default.
 */
export const AI_EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type AiEffort = (typeof AI_EFFORT_LEVELS)[number];

export const isAiEffort = (value: unknown): value is AiEffort =>
  typeof value === 'string' && (AI_EFFORT_LEVELS as readonly string[]).includes(value);

const CLAUDE_FAMILY = /^(?:claude-)?(opus|sonnet|fable|haiku)(?:-(\d+)(?:-(\d+))?)?(?:-\d{8})?$/;
/** A date stamp (`claude-opus-4-20250514`), which is not a minor version. */
const MINOR_VERSION_MAX = 99;

interface ModelVersion {
  major: number;
  minor: number;
}

const isAtLeast = ({ version, major, minor }: { version: ModelVersion; major: number; minor: number }) =>
  version.major > major || (version.major === major && version.minor >= minor);

/**
 * The effort levels a Claude model accepts. An alias (`opus`, `sonnet`, `fable`) names the newest model of its
 * family, so it gets the newest list. Only levels the Claude API documents for the generation are offered:
 * Opus takes low to high from 4.5, `max` from 4.6 and `xhigh` from 4.7; Sonnet takes low to high from 4.6 (its
 * higher levels are left out, since they are not verified for every generation); Fable takes them all. Haiku
 * and older models are not offered an effort.
 */
const claudeEfforts = ({ model }: { model: string }): AiEffort[] => {
  const match = CLAUDE_FAMILY.exec(model.toLowerCase());
  if (!match) return [];

  const [, family, majorText, minorText] = match;
  const version: ModelVersion | null =
    majorText === undefined
      ? null
      : {
          major: Number(majorText),
          minor: minorText !== undefined && Number(minorText) <= MINOR_VERSION_MAX ? Number(minorText) : 0,
        };
  const atLeast = ({ major, minor }: { major: number; minor: number }) =>
    version === null || isAtLeast({ version, major, minor });

  switch (family) {
    case 'fable':
      return ['low', 'medium', 'high', 'xhigh', 'max'];
    case 'opus':
      if (!atLeast({ major: 4, minor: 5 })) return [];
      if (!atLeast({ major: 4, minor: 6 })) return ['low', 'medium', 'high'];
      if (!atLeast({ major: 4, minor: 7 })) return ['low', 'medium', 'high', 'max'];
      return ['low', 'medium', 'high', 'xhigh', 'max'];
    case 'sonnet':
      return atLeast({ major: 4, minor: 6 }) ? ['low', 'medium', 'high'] : [];
    default:
      return [];
  }
};

const GPT_VERSION = /^gpt-(\d+)(?:\.(\d+))?(?:-(.+))?$/;

/**
 * The effort levels an OpenAI model accepts, whether it is dialled through the API or the Codex CLI. GPT-6 and
 * later list low to max (the AI SDK's own table for them). Earlier GPT-5 models differ by release (`minimal`
 * only on the original GPT-5, `none` and `xhigh` on some later ones), so only the levels every one of them
 * takes are offered, plus `minimal` for the original. The chat variants and Codex-tuned models are not offered
 * `minimal`; the o-series reasons at low to high; `o1-mini` and `o1-preview` have no setting.
 */
const openAiEfforts = ({ model }: { model: string }): AiEffort[] => {
  const id = model.toLowerCase();
  if (/^o(?:3|4)(?:-|$)/.test(id) || /^o1(?:$|-(?!mini|preview))/.test(id)) return ['low', 'medium', 'high'];

  const match = GPT_VERSION.exec(id);
  if (!match) return [];

  const major = Number(match[1]);
  const hasMinor = match[2] !== undefined;
  const variant = match[3] ?? '';
  if (major < 5 || variant.startsWith('chat')) return [];
  if (major >= 6) return ['low', 'medium', 'high', 'xhigh', 'max'];

  return !hasMinor && !variant.includes('codex') ? ['minimal', 'low', 'medium', 'high'] : ['low', 'medium', 'high'];
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
