import type { ChatCardWarning, ChatProposalPreview, ChatProposalSnapshot } from '@bt/shared/types';

import type { PreviewResolverName, ResolvedToolPolicy } from '../../policies/rules';

/** What a preview resolver computed: the card's preview and the part of the snapshot it owns. */
export interface PreviewResolution {
  preview: ChatProposalPreview;
  /** Merged into the snapshot next to the base currency and the parents' statuses. */
  snapshot: Partial<ChatProposalSnapshot>;
  /** Rows the call affects; decides the typed confirmation of a red card. */
  affectedCount?: number;
  warnings?: ChatCardWarning[];
}

/**
 * Computes what a call will do, reading only: no handler runs and nothing is written. `args` are the
 * proposal's arguments with `$proposal:` refs still in place.
 */
type PreviewResolver = (params: {
  userId: number;
  toolName: string;
  args: Record<string, unknown>;
  policy: ResolvedToolPolicy;
}) => Promise<PreviewResolution>;

/**
 * The resolver registry, keyed by the names the policies declare. A policy that declares a name with
 * no resolver here makes its cards unapplicable (`previewPending`), so no red card is ever approved
 * on its arguments alone.
 */
export const PREVIEW_RESOLVERS: Partial<Record<PreviewResolverName, PreviewResolver>> = {};
