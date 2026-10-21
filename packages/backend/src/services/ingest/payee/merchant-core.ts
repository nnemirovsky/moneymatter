import { normalizePayeeName } from '../../payees/normalize-name';

/**
 * Legal forms a bank or a terminal prints next to a business name ("NORD COFFEE COMPANY LTD",
 * "შპს ნორდი", "ООО Ромашка"), already normalized. They say what kind of company it is, not which
 * one, so they are dropped from either end of the name before it is compared.
 */
const LEGAL_FORMS: ReadonlySet<string> = new Set([
  'ltd',
  'limited',
  'llc',
  'inc',
  'incorporated',
  'corp',
  'corporation',
  'company',
  'plc',
  'llp',
  'gmbh',
  'sarl',
  'srl',
  'jsc',
  'ojsc',
  'cjsc',
  'pjsc',
  'ooo',
  'oao',
  'zao',
  'pao',
  'tov',
  'fop',
  'ооо',
  'оао',
  'зао',
  'пао',
  'ип',
  'тов',
  'фоп',
  'прат',
  'пат',
  'შპს',
  'სს',
]);

/**
 * Short forms that are also ordinary words or name parts ("Co" in "Coffee & Co", "AS" in a name),
 * so they count only at the end of a name, where a legal form stands in the Latin script.
 */
const TRAILING_LEGAL_FORMS: ReadonlySet<string> = new Set(['co', 'ag', 'sa', 'sas', 'bv', 'nv', 'ab', 'as', 'oy']);

/** "ი/მ" (an individual entrepreneur in Georgian) normalizes to two one-letter words. */
const GEORGIAN_SOLE_TRADER = ['ი', 'მ'];

const dropLeading = ({ words }: { words: string[] }): string[] => {
  let start = 0;
  while (start < words.length - 1) {
    if (LEGAL_FORMS.has(words[start]!)) {
      start += 1;
    } else if (
      words[start] === GEORGIAN_SOLE_TRADER[0] &&
      words[start + 1] === GEORGIAN_SOLE_TRADER[1] &&
      start < words.length - 2
    ) {
      start += 2;
    } else {
      break;
    }
  }

  return words.slice(start);
};

const dropTrailing = ({ words }: { words: string[] }): string[] => {
  let end = words.length;
  while (end > 1 && (LEGAL_FORMS.has(words[end - 1]!) || TRAILING_LEGAL_FORMS.has(words[end - 1]!))) {
    end -= 1;
  }

  return words.slice(0, end);
};

/**
 * The part of a merchant name that tells the business: the normalized name (case, accents and
 * punctuation gone) without the legal forms at either end. A name made only of legal forms keeps
 * its last word, so it never shrinks to nothing.
 */
export const merchantCoreName = ({ raw }: { raw: string }): string => {
  const words = normalizePayeeName({ raw }).split(' ').filter(Boolean);

  return dropTrailing({ words: dropLeading({ words }) }).join(' ');
};

/**
 * Edits (insert, delete, substitute, swap two neighbours) between two strings: the optimal string
 * alignment distance, enough to tell a typo ("cofee") from another word.
 */
export const editDistance = ({ a, b }: { a: string; b: string }): number => {
  const left = [...a];
  const right = [...b];
  const rows = left.length + 1;
  const cols = right.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) =>
    Array.from({ length: cols }, (__, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      let best = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) {
        best = Math.min(best, d[i - 2]![j - 2]! + 1);
      }
      d[i]![j] = best;
    }
  }

  return d[left.length]![right.length]!;
};

/**
 * How many edits still read as the same name: none for a short name, where one letter makes
 * another word ("spa" and "spar"), one for an ordinary name, two for a long one.
 */
export const allowedEdits = ({ length }: { length: number }): number => {
  if (length < 5) return 0;
  if (length < 12) return 1;
  return 2;
};

/** A payee and the names it answers to: its own and its aliases'. */
export interface MerchantMatchPayee {
  id: string;
  name: string;
  names: readonly string[];
}

export interface MerchantCoreCandidate {
  payeeId: string;
  name: string;
  /** Edits between the merchant's core name and the closest name of the payee. */
  distance: number;
}

export type MerchantCoreMatch =
  | { kind: 'none' }
  | { kind: 'unique'; payeeId: string; distance: number }
  /** Several payees are as close: the closest first. */
  | { kind: 'ambiguous'; candidates: MerchantCoreCandidate[] };

/**
 * Matches a merchant to the user's payees by their core names: equal, or a typo apart.
 *
 * - Both sides drop legal forms, case and punctuation, so "NORD COFEE COMPANY LTD" compares as
 *   "nord cofee" and "Nord Coffee" as "nord coffee".
 * - Two names match when they have as many words and are at most `allowedEdits` apart, measured on
 *   the shorter one.
 * - The one payee closest to the merchant is `unique`. Several payees at that distance are
 *   `ambiguous`, which the caller settles with the AI or the owner, never by guessing.
 */
export const matchMerchantCore = ({
  rawMerchant,
  payees,
}: {
  rawMerchant: string;
  payees: readonly MerchantMatchPayee[];
}): MerchantCoreMatch => {
  const core = merchantCoreName({ raw: rawMerchant });
  if (!core) return { kind: 'none' };

  const wordCount = core.split(' ').length;
  const candidates: MerchantCoreCandidate[] = [];

  for (const payee of payees) {
    let best: number | null = null;

    for (const name of payee.names) {
      const other = merchantCoreName({ raw: name });
      if (!other || other.split(' ').length !== wordCount) continue;

      const distance = other === core ? 0 : editDistance({ a: core, b: other });
      const limit = allowedEdits({ length: Math.min([...core].length, [...other].length) });
      if (distance <= limit && (best === null || distance < best)) best = distance;
    }

    if (best !== null) candidates.push({ payeeId: payee.id, name: payee.name, distance: best });
  }

  if (!candidates.length) return { kind: 'none' };

  const sorted = candidates.toSorted((a, b) => a.distance - b.distance || a.name.localeCompare(b.name));
  const closest = sorted.filter((candidate) => candidate.distance === sorted[0]!.distance);
  if (closest.length === 1) return { kind: 'unique', payeeId: closest[0]!.payeeId, distance: closest[0]!.distance };

  return { kind: 'ambiguous', candidates: sorted };
};
