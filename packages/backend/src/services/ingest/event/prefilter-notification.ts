import { matchAmountGate, normalizeSourceName, type GateStrictness } from '@bt/shared/types';
import { SUPPORTED_LOCALES, t } from '@i18n/index';

import {
  OTP_REQUEST_MARKERS,
  OWN_APP_BUNDLE_IDS,
  OWN_APP_NAMES,
  PAYMENT_CODE_MARKERS,
  PROMO_MARKERS,
  STANDALONE_CODE,
  TRANSACTION_MARKERS,
} from './prefilter-markers';

/** Why the server drops a notification before storing anything. `muted` is the source's own decision, not the text's. */
type PrefilterDropReason = 'noAmount' | 'security' | 'promo' | 'self';

type PrefilterResult =
  | {
      pass: true;
      /** The part of the text the amount gate matched, at most `AMOUNT_GATE_MATCH_MAX_LENGTH` characters. */
      amountText: string;
    }
  | { pass: false; reason: PrefilterDropReason };

/** Keys of the texts MoneyMatter writes into banners and pushes. A notification that starts with one is our own output. */
const OWN_OUTPUT_KEYS = [
  'ingest.summary.logged',
  'ingest.summary.alreadyLogged',
  'ingest.summary.noted',
  'ingest.summary.unknownCard',
  'ingest.summary.rateUnavailable',
  'ingest.summary.processingFailed',
  'ingest.summary.notificationLogged',
  'ingest.summary.contextAdded',
  'ingest.summary.contextAddedCategory',
  'ingest.summary.parkedNotification',
  'ingest.summary.queued',
];

/** Every placeholder the templates above use. */
const OWN_OUTPUT_VARIABLES = ['amount', 'merchant', 'category', 'card', 'from', 'to', 'date', 'summary', 'store'];

/** The fixed words a template must keep for it to tell our text from a bank's. */
const MIN_OWN_TEMPLATE_LITERAL_LENGTH = 8;

/** Stands for a placeholder while a template is rendered, so the fixed text around it can be told apart. */
const PLACEHOLDER = '\u0000';

const escapeRegExp = ({ value }: { value: string }) => value.replace(/[.*+?^${}()|[\]\\]/g, (char) => `\\${char}`);

/** NFC with every run of whitespace collapsed to one space, so a line compares the way a template reads. */
const normalizeText = ({ value }: { value: string }) => value.normalize('NFC').replace(/\s+/gu, ' ').trim();

let ownOutputTemplates: RegExp[] | null = null;

/**
 * One pattern per banner template, in every language: its fixed text with `.+?` where a value goes,
 * anchored at the start. "Logged 43.60 GEL at Wolt → Food" matches `Logged .+? at .+? → .+`, while a
 * bank's "Logged out of TBC" does not. Built on first use, once the translations are loaded.
 */
const getOwnOutputTemplates = (): RegExp[] => {
  if (ownOutputTemplates) return ownOutputTemplates;

  const variables = Object.fromEntries(OWN_OUTPUT_VARIABLES.map((name) => [name, PLACEHOLDER]));
  const sources = new Set<string>();

  for (const locale of SUPPORTED_LOCALES) {
    for (const key of OWN_OUTPUT_KEYS) {
      const parts = normalizeText({ value: t({ key, locale, variables }) }).split(PLACEHOLDER);
      const literalLength = parts.reduce((sum, part) => sum + part.trim().length, 0);

      if (literalLength >= MIN_OWN_TEMPLATE_LITERAL_LENGTH) {
        sources.add(
          `^${parts.map((part) => escapeRegExp({ value: part })).join('.+?')}${parts.at(-1) === '' ? '.*' : ''}`,
        );
      }
    }
  }

  ownOutputTemplates = [...sources].map((source) => new RegExp(source, 'iu'));

  return ownOutputTemplates;
};

/**
 * Whether the notification is something MoneyMatter itself produced: it comes from the Shortcuts
 * app or the MoneyMatter web app, or a line of it starts with one of our banner templates. Without
 * this, the shortcut's own "Logged 43.60 GEL …" banner would fire the any-app trigger again.
 */
const isOwnOutput = ({
  bundleId,
  appName,
  lines,
}: {
  bundleId: string | null;
  appName: string | null;
  lines: readonly string[];
}): boolean => {
  if (bundleId && OWN_APP_BUNDLE_IDS.has(bundleId.trim().toLowerCase())) return true;
  if (appName && OWN_APP_NAMES.has(normalizeSourceName({ value: appName }))) return true;

  const templates = getOwnOutputTemplates();

  return lines.some((line) => {
    const normalized = normalizeText({ value: line });

    return templates.some((template) => template.test(normalized));
  });
};

const matchesAny = ({ text, markers }: { text: string; markers: readonly RegExp[] }) =>
  markers.some((marker) => marker.test(text));

/**
 * The server's second look at a notification, before anything is stored. The first is the same
 * amount gate on the device; this one also reads the text for what the gate cannot see.
 *
 * In this order:
 *
 * 1. `self`: our own banner or push;
 * 2. `noAmount`: nothing in the text shows an amount at the user's strictness (a context source needs none);
 * 3. `security`: the text asks the user to enter, confirm or not share a code and a standalone
 *    4 to 8 digit code is present. "auth code" and "approval code" mark a completed payment and
 *    override this;
 * 4. `promo`: a strong promo marker and neither card digits nor a balance (a payment that happens
 *    to mention cashback is still a payment).
 */
export const prefilterNotification = ({
  bundleId,
  appName,
  title,
  subtitle,
  body,
  strictness,
  contextApp = false,
}: {
  bundleId: string | null;
  appName: string | null;
  title: string;
  subtitle: string;
  body: string;
  strictness: GateStrictness;
  /** The source is a context source: its notifications describe a purchase and show no amount. */
  contextApp?: boolean;
}): PrefilterResult => {
  if (isOwnOutput({ bundleId, appName, lines: [title, subtitle, body].filter(Boolean) })) {
    return { pass: false, reason: 'self' };
  }

  const text = [title, subtitle, body].filter(Boolean).join('\n');
  const matched = matchAmountGate({ text, strictness });
  // A context notification shows no amount; every other source needs one.
  if (matched === null && !contextApp) return { pass: false, reason: 'noAmount' };
  const amountText = matched ?? '';

  const asksForCode =
    matchesAny({ text, markers: OTP_REQUEST_MARKERS }) &&
    STANDALONE_CODE.test(text) &&
    !matchesAny({ text, markers: PAYMENT_CODE_MARKERS });
  if (asksForCode) return { pass: false, reason: 'security' };

  if (matchesAny({ text, markers: PROMO_MARKERS }) && !matchesAny({ text, markers: TRANSACTION_MARKERS })) {
    return { pass: false, reason: 'promo' };
  }

  return { pass: true, amountText };
};
