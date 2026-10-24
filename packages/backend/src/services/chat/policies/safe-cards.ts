import type { ChatProposalCard } from '@bt/shared/types';

import { LOG_INGEST_REQUEST_TOOL } from '../inbox/inbox-config';
import { getToolPolicy } from './index';

/**
 * Whether "Approve all safe" may apply a card. Safe means pending and fresh, no danger, no
 * confirmation, no egress, not standalone, not a settings change, applicable, with no field the
 * model was unsure about, and every pending parent safe too. A pending parent missing from `cards`
 * cannot be checked and makes the card unsafe, as does a parent that was rejected or failed; an
 * applied parent is done and is not looked at. The card's own `safe` flag is an output of this
 * check, never an input. A payment of the automation inbox with no account chosen is never safe, whatever
 * it was parked for: approve-all must not log money on an account the owner has not seen.
 */
export function isSafeForApproveAll({ card, cards }: { card: ChatProposalCard; cards: ChatProposalCard[] }): boolean {
  const byId = new Map(cards.map((candidate) => [candidate.id, candidate]));

  const isSafe = ({ candidate, visiting }: { candidate: ChatProposalCard; visiting: Set<string> }): boolean => {
    if (visiting.has(candidate.id)) return false;
    if (!isSafeOnItsOwn({ candidate })) return false;

    const path = new Set(visiting).add(candidate.id);
    return candidate.dependsOn.every((dependency) => {
      if (dependency.status === 'applied') return true;

      const parent = byId.get(dependency.id);
      return parent !== undefined && isSafe({ candidate: parent, visiting: path });
    });
  };

  return isSafe({ candidate: card, visiting: new Set() });
}

/** A log-payment card whose account has not been chosen on the card, for any park reason. */
export function isIngestCardWithoutAccount({ card }: { card: ChatProposalCard }): boolean {
  return (
    card.toolName === LOG_INGEST_REQUEST_TOOL && !card.fields.some((field) => field.path === 'accountId' && field.value)
  );
}

function isSafeOnItsOwn({ candidate }: { candidate: ChatProposalCard }): boolean {
  const policy = getToolPolicy({ name: candidate.toolName });
  if (!policy || policy.standalone) return false;

  return (
    candidate.status === 'pending' &&
    candidate.stale === undefined &&
    candidate.danger === 'none' &&
    candidate.confirmation.mode === 'none' &&
    candidate.egress === undefined &&
    candidate.kind !== 'settings' &&
    candidate.canApply.ok &&
    !isIngestCardWithoutAccount({ card: candidate }) &&
    !candidate.fields.some((field) => field.uncertain !== undefined)
  );
}
