import type { CliPrompt } from '@services/ai/cli/cli-prompt';
import { estimateTokenCount } from '@services/import-export/statement-parser/text-extractor';

import type { CliChatOutcome } from './types';

/**
 * The usage of a CLI run that was ended on purpose, because the model asked the user a question. The CLI prints
 * its token counts when it finishes, which a run ended early never does, so the thread would show 0 for a turn
 * that did read the whole conversation. This estimates the counts from what was sent and what the CLI printed:
 * the prompt's text as input, the model output it printed as output. Images add nothing here. It is an estimate,
 * and it is only used where the CLI could not report the figure.
 */
export function estimateStoppedUsage({
  prompt,
  producedOutput,
}: {
  prompt: CliPrompt;
  /** The model output lines the CLI printed before it was ended. */
  producedOutput: string[];
}): NonNullable<CliChatOutcome['usage']> {
  const input = [prompt.system, ...prompt.parts.flatMap((part) => (part.type === 'text' ? [part.text] : []))]
    .filter(Boolean)
    .join('\n');
  const output = producedOutput.join('\n');

  return {
    inputTokens: input ? estimateTokenCount({ text: input }) : 0,
    outputTokens: output ? estimateTokenCount({ text: output }) : 0,
    cachedInputTokens: 0,
  };
}
