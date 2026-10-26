import { type AIConnectionInfo, type AiEffort, getAiEffortOptions } from '@bt/shared/types';

/** Chosen not to be a level, so the "Default" option has a value of its own. */
export const EFFORT_DEFAULT_VALUE = '__effort-default__';

export type EffortOption = { value: typeof EFFORT_DEFAULT_VALUE; kind: 'default' } | { value: AiEffort; kind: 'level' };

type EffortOwner = Pick<AIConnectionInfo, 'provider' | 'model'>;

/** The model an effort applies to: the one picked within the connection, else the connection's own. */
const modelOf = ({ connection, modelId }: { connection: EffortOwner; modelId: string | null }) =>
  modelId ?? connection.model;

/** The levels the connection's provider accepts for the model that will run; empty when the model has none. */
export const getConnectionEffortLevels = ({
  connection,
  modelId,
}: {
  connection: EffortOwner;
  modelId: string | null;
}): AiEffort[] => getAiEffortOptions({ provider: connection.provider, model: modelOf({ connection, modelId }) });

/**
 * "Default" first (the provider's own level, nothing sent), then each level the model accepts. Empty when the
 * model has no effort setting: the picker is then not offered at all.
 */
export const buildEffortOptions = ({
  connection,
  modelId,
}: {
  connection: EffortOwner;
  modelId: string | null;
}): EffortOption[] => {
  const levels = getConnectionEffortLevels({ connection, modelId });
  if (levels.length === 0) return [];

  return [
    { value: EFFORT_DEFAULT_VALUE, kind: 'default' },
    ...levels.map((level): EffortOption => ({ value: level, kind: 'level' })),
  ];
};

/**
 * The option a stored effort selects. A level the model does not accept (it was picked for another model) selects
 * the default: that is what a run does with it.
 */
export const findSelectedEffortOption = ({
  options,
  effort,
}: {
  options: EffortOption[];
  effort: AiEffort | null;
}): EffortOption | null =>
  options.find((option) => option.kind === 'level' && option.value === effort) ??
  options.find((option) => option.kind === 'default') ??
  null;

/** The level that actually applies for a stored one, or null when the model does not accept it. */
export const resolveEffectiveEffort = ({
  connection,
  modelId,
  effort,
}: {
  connection: EffortOwner;
  modelId: string | null;
  effort: AiEffort | null;
}): AiEffort | null =>
  effort !== null && getConnectionEffortLevels({ connection, modelId }).includes(effort) ? effort : null;
