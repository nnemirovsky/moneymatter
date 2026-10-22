/**
 * Generates the unsigned "MoneyMatter - Log card payment" Shortcut as an XML property list.
 *
 * `npm run shortcuts:build` writes `shortcuts/log-card-payment.plist`; the maintainer signs that
 * file on macOS (`shortcuts sign`, see `public/shortcuts/README.md`). The output is
 * deterministic: every action UUID derives from a fixed seed and its position, so a change to this
 * script shows up as a readable diff of the committed XML, and the spec fails on any drift.
 *
 * The flow is described under "Generic shortcut" in the ingest plan: decode the setup code, then
 * either log the payment of the Wallet automation or, with no input (a manual run), send a dry run.
 * The tap-only shortcut is for iOS 26 and earlier; `build-payments-shortcut.ts` is the iOS 27 one.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import plist from 'plist';

import {
  type Dict,
  INPUT_CONTENT_ITEM_CLASSES,
  SHORTCUT_PARAMS,
  createShortcutKit,
  importQuestion,
} from './shortcut-plist.ts';

const SEED = 'moneymatter-log-card-payment-shortcut-v1';
const SHORTCUT_NAME = 'MoneyMatter - Log card payment';
const IMPORT_QUESTION = 'Paste the setup code from the iOS Automation page in MoneyMatter (Accounts → iOS Automation).';
const NO_CODE_ERROR =
  'No MoneyMatter setup code was entered. Generate one on the iOS Automation page and add the shortcut again.';
const UNREADABLE_CODE_ERROR =
  'The MoneyMatter setup code could not be read. Generate a new one on the iOS Automation page and add the shortcut again.';
// To the second: two identical taps inside one minute are two payments, not a retry.
export const KEY_TIME_FORMAT = "yyyy-MM-dd'T'HH:mm:ssZZZZZ";
// Apple's date formatter prints the IANA zone ID (`Asia/Tbilisi`) for `VV`.
export const TIME_ZONE_FORMAT = 'VV';
const SOURCE = 'apple-pay';

/** Property names of the Wallet transaction input, as the device shows them. */
const INPUT_PROPERTY = {
  merchant: 'Merchant',
  amount: 'Amount',
  card: 'Card or Pass',
  name: 'Name',
} as const;

export const buildCardPaymentShortcut = (): Dict => {
  const kit = createShortcutKit({ seed: SEED, name: SHORTCUT_NAME });
  const { actions, from, shortcutInput } = kit;

  // 0-8: the setup code → url, token and the Cloudflare Access pair, then the guards.
  const setup = kit.decodeSetupCode({
    withGate: false,
    missingCodeError: NO_CODE_ERROR,
    unreadableCodeError: UNREADABLE_CODE_ERROR,
  });
  const sender = kit.createSender({ target: from({ output: setup.url }), setup });

  // The Wallet automation passes the payment as Shortcut Input; a manual run has none.
  const inputGroup = kit.openGroup();
  kit.conditional({ group: inputGroup, mode: 0, subject: shortcutInput(), condition: 'Has Any Value' });

  const now = kit.currentDate();
  // The input carries no date, so the run time stands in for the payment time.
  const isoTime = kit.formatDate({
    date: from({ output: now }),
    parameters: { [SHORTCUT_PARAMS.dateFormatStyle]: 'ISO 8601', [SHORTCUT_PARAMS.isoIncludeTime]: true },
  });
  const zoneName = kit.formatDate({
    date: from({ output: now }),
    parameters: { [SHORTCUT_PARAMS.dateFormatStyle]: 'Custom', [SHORTCUT_PARAMS.dateFormat]: TIME_ZONE_FORMAT },
  });
  const keyTime = kit.formatDate({
    date: from({ output: now }),
    parameters: { [SHORTCUT_PARAMS.dateFormatStyle]: 'Custom', [SHORTCUT_PARAMS.dateFormat]: KEY_TIME_FORMAT },
  });
  const idempotencyKey = kit.hashOf({
    parts: [
      shortcutInput({ property: INPUT_PROPERTY.card }),
      '|',
      shortcutInput({ property: INPUT_PROPERTY.merchant }),
      '|',
      shortcutInput({ property: INPUT_PROPERTY.amount }),
      '|',
      from({ output: keyTime }),
    ],
  });
  sender.sendWithRetry({
    entries: [
      { key: 'amount', value: [shortcutInput({ property: INPUT_PROPERTY.amount })] },
      { key: 'merchant', value: [shortcutInput({ property: INPUT_PROPERTY.merchant })] },
      { key: 'card', value: [shortcutInput({ property: INPUT_PROPERTY.card })] },
      { key: 'name', value: [shortcutInput({ property: INPUT_PROPERTY.name, userInfo: 'WFItemName' })] },
      { key: 'time', value: [from({ output: isoTime })] },
      { key: 'timeZone', value: [from({ output: zoneName })] },
      { key: 'idempotencyKey', value: [from({ output: idempotencyKey })] },
      { key: 'source', value: [SOURCE] },
    ],
  });

  kit.conditional({ group: inputGroup, mode: 1 });
  sender.send({ entries: [{ key: 'dryRun', value: true }] });
  kit.conditional({ group: inputGroup, mode: 2 });

  kit.showAnswerBanner({ silentWhenEmpty: false });

  return {
    WFQuickActionSurfaces: [],
    WFWorkflowActions: actions,
    WFWorkflowClientVersion: '4711',
    WFWorkflowHasOutputFallback: false,
    WFWorkflowHasShortcutInputVariables: true,
    WFWorkflowIcon: { WFWorkflowIconGlyphNumber: 62322, WFWorkflowIconStartColor: 2071128575 },
    WFWorkflowImportQuestions: [importQuestion({ text: IMPORT_QUESTION })],
    WFWorkflowInputContentItemClasses: INPUT_CONTENT_ITEM_CLASSES,
    WFWorkflowMinimumClientVersion: 900,
    WFWorkflowMinimumClientVersionString: '900',
    WFWorkflowName: SHORTCUT_NAME,
    WFWorkflowOutputContentItemClasses: [],
    WFWorkflowTypes: ['Watch', 'WFWorkflowTypeShowInSearch'],
  };
};

export const renderCardPaymentShortcutXml = (): string =>
  `${plist.build(buildCardPaymentShortcut() as never, { indent: '\t', newline: '\n' })}\n`;

const OUTPUT_PATH = fileURLToPath(new URL('../../shortcuts/log-card-payment.plist', import.meta.url));

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(OUTPUT_PATH, renderCardPaymentShortcutXml());
}
