import type { AiEffort } from '@bt/shared/types';

/** `claude --effort <level>`: unset, the CLI uses the model's own default. */
export const claudeEffortArgs = ({ effort }: { effort?: AiEffort | null }): string[] =>
  effort ? ['--effort', effort] : [];

/**
 * `codex exec -c model_reasoning_effort="<level>"`. The levels are plain lowercase words, so a JSON string is
 * the TOML basic string the config key wants.
 */
export const codexEffortArgs = ({ effort }: { effort?: AiEffort | null }): string[] =>
  effort ? ['-c', `model_reasoning_effort=${JSON.stringify(effort)}`] : [];
