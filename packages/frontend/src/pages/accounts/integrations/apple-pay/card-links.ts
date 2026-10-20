import type { AccountModel, CardMappingDto } from '@bt/shared/types';

/** One card and the accounts its payments are logged on: the default first, then one per currency. */
export interface CardLinkGroup {
  cardLabel: string;
  lastDigits: string | null;
  mappings: CardMappingDto[];
}

/**
 * Groups the link rows by card. The rows of one card share their label, and the server lists them in
 * the order they should read: the default row, then the currencies alphabetically. Cards keep the
 * server's order.
 */
export const groupCardMappings = ({ mappings }: { mappings: readonly CardMappingDto[] }): CardLinkGroup[] => {
  const groups = new Map<string, CardLinkGroup>();

  for (const mapping of mappings) {
    const group = groups.get(mapping.cardLabel);

    if (group) {
      group.mappings.push(mapping);
      group.lastDigits ??= mapping.lastDigits;
    } else {
      groups.set(mapping.cardLabel, {
        cardLabel: mapping.cardLabel,
        lastDigits: mapping.lastDigits,
        mappings: [mapping],
      });
    }
  }

  return [...groups.values()];
};

export const hasDefaultLink = ({ group }: { group: CardLinkGroup }): boolean =>
  group.mappings.some((mapping) => mapping.currencyCode === null);

/**
 * What a row of one card can still be for: the currencies of the accounts the user can link that the
 * card has no row for yet, and whether the card still lacks its default.
 */
export const getFreeLinkTargets = ({
  accounts,
  siblings,
}: {
  accounts: readonly AccountModel[];
  siblings: readonly CardMappingDto[];
}): { currencies: string[]; defaultAvailable: boolean } => {
  const taken = new Set(siblings.map((sibling) => sibling.currencyCode));
  const currencies = [...new Set(accounts.map((account) => account.currencyCode))]
    .filter((code) => !taken.has(code))
    .sort();

  return { currencies, defaultAvailable: !taken.has(null) };
};
