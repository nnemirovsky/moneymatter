import type { LanguageModelV3GenerateResult } from '@ai-sdk/provider';
import type { AiEffort } from '@bt/shared/types';

import type { CliCredentialSource, CliRunOutcome } from './cli-credential-run';

/**
 * Overrides for how a model's `doGenerate` goes through `runWithCliCredential`. The defaults (the
 * feature run timeout, no wait cap, no hook) are right for feature runs; the validation probes set
 * their own timeout, slot wait and a `beforeRelease` hook.
 */
export interface CliModelRunOptions {
  timeoutMs?: number;
  maxWaitMs?: number;
  beforeRelease?: (params: { outcome: CliRunOutcome<LanguageModelV3GenerateResult> }) => Promise<void>;
}

export interface CliLanguageModelParams {
  model: string;
  credentialSource: CliCredentialSource;
  runOptions?: CliModelRunOptions;
  /** Passed to the CLI as its reasoning effort; unset, the CLI's default. */
  effort?: AiEffort;
}
