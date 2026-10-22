/**
 * Generates the unsigned "MoneyMatter - Log payments" Shortcut for iOS 27 as an XML property list.
 *
 * `npm run shortcuts:build` writes `shortcuts/log-payments.plist`. The shortcut carries its own
 * triggers (`WFWorkflowTriggers`): the Wallet Transaction trigger and a Notification trigger. The macOS
 * signer drops them, so the distributable file is made by importing this plist on an iPhone and
 * exporting it from there (see `public/shortcuts/README.md`). The output is deterministic and a spec
 * compares it with the committed XML.
 *
 * The flow, per the ingest plan:
 *
 * 1. decode the setup code (url, token, Cloudflare Access pair, optional `gate`), point the url at
 *    `/ingest/event` and pick the gate regex;
 * 2. a Wallet tap (`Transaction → Merchant` has a value) posts `kind: walletTransaction`;
 * 3. a notification (`Notification → App` has a value) stops for our own output, runs the amount gate
 *    (Match Text, then If) and posts `kind: notification`; without an amount a one-time code stops, a messaging
 *    or mail app is probed (the sender only) and sent only when the server asks for it, and any other app
 *    of the trigger list is posted so the server decides by its source's mode;
 * 4. a manual run posts a dry run;
 * 5. one retry after a wait when a base-currency change answers 423, then the banner.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import plist from 'plist';

import { AMOUNT_GATE_PATTERNS } from '../../../shared/src/types/ingest/amount-gate.ts';
import { CONVERSATIONAL_APP_GATE_PATTERN } from '../../../shared/src/types/ingest/conversational-apps.ts';
import { SECURITY_GATE_PATTERN } from '../../../shared/src/types/ingest/security-markers.ts';
import {
  type Dict,
  INPUT_CONTENT_ITEM_CLASSES,
  SHORTCUT_ACTIONS,
  SHORTCUT_PARAMS,
  TRIGGER_IDENTIFIERS,
  createShortcutKit,
  importQuestion,
  tokenString,
  uuidFor,
} from './shortcut-plist.ts';

const SEED = 'moneymatter-log-payments-shortcut-v1';
const SHORTCUT_NAME = 'MoneyMatter - Log payments';
const IMPORT_QUESTION = 'Paste the setup code from the iOS Automation page in MoneyMatter (Accounts → iOS Automation).';
const NO_CODE_ERROR =
  'No MoneyMatter setup code was entered. Generate one on the iOS Automation page and add the shortcut again.';
const UNREADABLE_CODE_ERROR =
  'The MoneyMatter setup code could not be read. Generate a new one on the iOS Automation page and add the shortcut again.';
const SOURCE = 'ios-automation';
// To the second: two identical payments inside one minute are two payments, not a retry.
export const KEY_TIME_FORMAT = "yyyy-MM-dd'T'HH:mm:ssZZZZZ";

/** The setup code's url ends in the card-payment route; the event route replaces its last segment. */
export const EVENT_URL_FIND = '[^/]+$';
export const EVENT_URL_REPLACE = 'event';

/** Our own output must not come back in: the Shortcuts app's banners and the MoneyMatter web app's pushes. */
export const OWN_APP_NAMES = { shortcuts: 'Shortcuts', moneymatter: 'MoneyMatter' } as const;

/** Property names of the Wallet Transaction variable, as the device shows them. */
export const TRANSACTION_PROPERTY = {
  merchant: 'Merchant',
  amount: 'Amount',
  card: 'Card or Pass',
  name: 'Name',
} as const;

/**
 * Property names of the Notification variable, as the device shows them. `Sender` and `Recipients` are
 * left out on purpose: a non-chat notification has neither, and reading a missing property aborts the
 * step that uses it.
 */
export const NOTIFICATION_PROPERTY = {
  app: 'App',
  title: 'Title',
  subtitle: 'Subtitle',
  body: 'Body',
  date: 'Date',
} as const;

/**
 * Apps the Notification trigger lists on import. An empty list disables the trigger and iOS has no
 * "any app", so the shortcut ships Wallet and Messages; the user adds the bank and mail apps.
 */
export const PRESELECTED_APPS = [
  { BundleIdentifier: 'com.apple.Passbook', Name: 'Wallet', TeamIdentifier: '0000000000' },
  { BundleIdentifier: 'com.apple.MobileSMS', Name: 'Messages', TeamIdentifier: '0000000000' },
] as const;

const GATE_VARIABLE = 'Gate';

const buildTriggers = (): Dict[] => [
  {
    WFTriggerIdentifier: TRIGGER_IDENTIFIERS.wallet,
    WFTriggerSerializedParameters: {},
    WFTriggerUUID: uuidFor({ seed: SEED, index: 5000 }),
  },
  {
    WFTriggerIdentifier: TRIGGER_IDENTIFIERS.notification,
    WFTriggerSerializedParameters: {
      Conditions: {
        Value: {
          WFActionParameterFilterPrefix: 1,
          WFActionParameterFilterTemplates: [],
          WFContentPredicateBoundedDate: false,
        },
        WFSerializationType: 'WFContentPredicateTableTemplate',
      },
      SelectedApps: PRESELECTED_APPS.map((app) => ({ ...app })),
    },
    WFTriggerUUID: uuidFor({ seed: SEED, index: 5001 }),
  },
];

export const buildPaymentsShortcut = (): Dict => {
  const kit = createShortcutKit({ seed: SEED, name: SHORTCUT_NAME });
  const { actions, add, from, trigger, variable } = kit;
  const transaction = ({ property }: { property: string }) => trigger({ trigger: 'wallet', property });
  const notification = ({ property }: { property?: string } = {}) => trigger({ trigger: 'notification', property });

  // 0-9: the setup code → url, token, the Cloudflare Access pair and the optional gate.
  const setup = kit.decodeSetupCode({
    withGate: true,
    missingCodeError: NO_CODE_ERROR,
    unreadableCodeError: UNREADABLE_CODE_ERROR,
  });

  const eventUrl = add({
    identifier: SHORTCUT_ACTIONS.replaceText,
    name: 'Updated Text',
    parameters: {
      [SHORTCUT_PARAMS.replaceFind]: EVENT_URL_FIND,
      [SHORTCUT_PARAMS.replaceWith]: EVENT_URL_REPLACE,
      [SHORTCUT_PARAMS.replaceRegex]: true,
      [SHORTCUT_PARAMS.replaceCaseSensitive]: true,
      [SHORTCUT_PARAMS.input]: tokenString({ parts: [from({ output: setup.url })] }),
    },
  });

  // The gate: the setup code's regex when it has one, else the built-in standard pattern.
  const standardGate = add({
    identifier: SHORTCUT_ACTIONS.text,
    name: 'Text',
    parameters: { [SHORTCUT_PARAMS.textActionText]: AMOUNT_GATE_PATTERNS.standard },
  });
  const gateGroup = kit.openGroup();
  kit.conditional({ group: gateGroup, mode: 0, subject: from({ output: setup.gate! }), condition: 'Has Any Value' });
  kit.setVariable({ name: GATE_VARIABLE, output: setup.gate! });
  kit.conditional({ group: gateGroup, mode: 1 });
  kit.setVariable({ name: GATE_VARIABLE, output: standardGate });
  kit.conditional({ group: gateGroup, mode: 2 });

  const sender = kit.createSender({ target: from({ output: eventUrl }), setup });

  // A tap carries a merchant; only a notification carries an app. Neither means a manual run.
  const tapGroup = kit.openGroup();
  kit.conditional({
    group: tapGroup,
    mode: 0,
    subject: transaction({ property: TRANSACTION_PROPERTY.merchant }),
    condition: 'Has Any Value',
  });

  // The Transaction has no date of its own, so the run time stands in for the payment time.
  const now = kit.currentDate();
  const tapTime = kit.formatDate({
    date: from({ output: now }),
    parameters: { [SHORTCUT_PARAMS.dateFormatStyle]: 'ISO 8601', [SHORTCUT_PARAMS.isoIncludeTime]: true },
  });
  const tapKeyTime = kit.formatDate({
    date: from({ output: now }),
    parameters: { [SHORTCUT_PARAMS.dateFormatStyle]: 'Custom', [SHORTCUT_PARAMS.dateFormat]: KEY_TIME_FORMAT },
  });
  const tapKey = kit.hashOf({
    parts: [
      'walletTransaction|',
      transaction({ property: TRANSACTION_PROPERTY.card }),
      '|',
      transaction({ property: TRANSACTION_PROPERTY.merchant }),
      '|',
      transaction({ property: TRANSACTION_PROPERTY.amount }),
      '|',
      from({ output: tapKeyTime }),
    ],
  });
  sender.sendWithRetry({
    entries: [
      { key: 'kind', value: ['walletTransaction'] },
      { key: 'amount', value: [transaction({ property: TRANSACTION_PROPERTY.amount })] },
      { key: 'merchant', value: [transaction({ property: TRANSACTION_PROPERTY.merchant })] },
      { key: 'card', value: [transaction({ property: TRANSACTION_PROPERTY.card })] },
      { key: 'name', value: [transaction({ property: TRANSACTION_PROPERTY.name })] },
      { key: 'time', value: [from({ output: tapTime })] },
      { key: 'timeSource', value: ['run'] },
      { key: 'idempotencyKey', value: [from({ output: tapKey })] },
      { key: 'source', value: [SOURCE] },
    ],
  });

  kit.conditional({ group: tapGroup, mode: 1 });

  const notificationGroup = kit.openGroup();
  kit.conditional({
    group: notificationGroup,
    mode: 0,
    subject: notification({ property: NOTIFICATION_PROPERTY.app }),
    condition: 'Has Any Value',
  });

  // Our own banners and pushes must not fire the trigger again, so the app is checked before the text.
  const shortcutsGroup = kit.openGroup();
  kit.conditional({
    group: shortcutsGroup,
    mode: 0,
    subject: notification({ property: NOTIFICATION_PROPERTY.app }),
    condition: 'Is',
    value: OWN_APP_NAMES.shortcuts,
  });
  kit.stop();
  kit.conditional({ group: shortcutsGroup, mode: 2 });

  const webAppGroup = kit.openGroup();
  kit.conditional({
    group: webAppGroup,
    mode: 0,
    subject: notification({ property: NOTIFICATION_PROPERTY.app }),
    condition: 'Contains',
    value: OWN_APP_NAMES.moneymatter,
  });
  kit.stop();
  kit.conditional({ group: webAppGroup, mode: 2 });

  // The privacy gate: only text that shows an amount leaves the phone. Built-in Match Text and If only.
  const gateText = add({
    identifier: SHORTCUT_ACTIONS.text,
    name: 'Text',
    parameters: {
      [SHORTCUT_PARAMS.textActionText]: tokenString({
        parts: [
          notification({ property: NOTIFICATION_PROPERTY.title }),
          '\n',
          notification({ property: NOTIFICATION_PROPERTY.subtitle }),
          '\n',
          notification({ property: NOTIFICATION_PROPERTY.body }),
        ],
      }),
    },
  });
  const matches = add({
    identifier: SHORTCUT_ACTIONS.matchText,
    name: 'Matches',
    parameters: {
      [SHORTCUT_PARAMS.matchText]: tokenString({ parts: [from({ output: gateText })] }),
      [SHORTCUT_PARAMS.matchPattern]: tokenString({ parts: [variable({ name: GATE_VARIABLE })] }),
      [SHORTCUT_PARAMS.matchCaseSensitive]: true,
    },
  });
  // No amount. The notification goes on only when the server wants it, and a one-time code never goes:
  //  1. a text that asks for a one-time code stops, for every app, so a code is never sent;
  //  2. a messaging or mail app first sends only its name and the sender (the title); the shortcut sends the
  //     text only when the server answers `send: yes`, which it does for a sender the owner made a context
  //     source. This is the one rule about chats: change it here and in `probeSender` on the server;
  //  3. any other app of the trigger list goes on, and the server decides by its source's mode (a context
  //     source is read, anything else without an amount is dropped before it is stored).
  const gateMissGroup = kit.openGroup();
  kit.conditional({
    group: gateMissGroup,
    mode: 0,
    subject: from({ output: matches }),
    condition: 'Does Not Have Any Value',
  });
  const stopForSecurityText = () => {
    const security = add({
      identifier: SHORTCUT_ACTIONS.matchText,
      name: 'Matches',
      parameters: {
        [SHORTCUT_PARAMS.matchText]: tokenString({ parts: [from({ output: gateText })] }),
        [SHORTCUT_PARAMS.matchPattern]: SECURITY_GATE_PATTERN,
        [SHORTCUT_PARAMS.matchCaseSensitive]: true,
      },
    });
    const group = kit.openGroup();
    kit.conditional({ group, mode: 0, subject: from({ output: security }), condition: 'Has Any Value' });
    kit.stop();
    kit.conditional({ group, mode: 2 });
  };
  const probeConversationalApps = () => {
    const conversational = add({
      identifier: SHORTCUT_ACTIONS.matchText,
      name: 'Matches',
      parameters: {
        [SHORTCUT_PARAMS.matchText]: tokenString({ parts: [notification({ property: NOTIFICATION_PROPERTY.app })] }),
        [SHORTCUT_PARAMS.matchPattern]: CONVERSATIONAL_APP_GATE_PATTERN,
        [SHORTCUT_PARAMS.matchCaseSensitive]: true,
      },
    });
    const group = kit.openGroup();
    kit.conditional({ group, mode: 0, subject: from({ output: conversational }), condition: 'Has Any Value' });
    sender.send({
      entries: [
        { key: 'kind', value: ['notificationProbe'] },
        { key: 'app', value: [notification({ property: NOTIFICATION_PROPERTY.app })] },
        { key: 'title', value: [notification({ property: NOTIFICATION_PROPERTY.title })] },
        { key: 'source', value: [SOURCE] },
      ],
    });
    const answer = kit.getValue({ key: 'response', source: variable({ name: 'Response' }) });
    const verdict = kit.getValue({ key: 'send', source: from({ output: answer }) });
    const sendGroup = kit.openGroup();
    kit.conditional({
      group: sendGroup,
      mode: 0,
      subject: from({ output: verdict }),
      condition: 'Does Not Have Any Value',
    });
    kit.stop();
    kit.conditional({ group: sendGroup, mode: 2 });
    kit.conditional({ group, mode: 2 });
  };
  stopForSecurityText();
  probeConversationalApps();
  kit.conditional({ group: gateMissGroup, mode: 2 });

  // The notification's own date is its time; the key holds it to the second.
  const notificationTime = kit.formatDate({
    date: notification({ property: NOTIFICATION_PROPERTY.date }),
    parameters: { [SHORTCUT_PARAMS.dateFormatStyle]: 'ISO 8601', [SHORTCUT_PARAMS.isoIncludeTime]: true },
  });
  const notificationKey = kit.hashOf({
    parts: [
      'notification|',
      notification({ property: NOTIFICATION_PROPERTY.app }),
      '|',
      notification({ property: NOTIFICATION_PROPERTY.title }),
      '|',
      notification({ property: NOTIFICATION_PROPERTY.subtitle }),
      '|',
      notification({ property: NOTIFICATION_PROPERTY.body }),
      '|',
      from({ output: notificationTime }),
    ],
  });
  sender.sendWithRetry({
    entries: [
      { key: 'kind', value: ['notification'] },
      { key: 'app', value: [notification({ property: NOTIFICATION_PROPERTY.app })] },
      { key: 'title', value: [notification({ property: NOTIFICATION_PROPERTY.title })] },
      { key: 'subtitle', value: [notification({ property: NOTIFICATION_PROPERTY.subtitle })] },
      { key: 'body', value: [notification({ property: NOTIFICATION_PROPERTY.body })] },
      { key: 'time', value: [from({ output: notificationTime })] },
      { key: 'raw', value: [notification()] },
      { key: 'idempotencyKey', value: [from({ output: notificationKey })] },
      { key: 'source', value: [SOURCE] },
    ],
  });

  kit.conditional({ group: notificationGroup, mode: 1 });
  sender.send({ entries: [{ key: 'dryRun', value: true }] });
  kit.conditional({ group: notificationGroup, mode: 2 });
  kit.conditional({ group: tapGroup, mode: 2 });

  // Only the notifications the server ignores or drops stay silent; errors always show their message.
  kit.showAnswerBanner({ silentWhenEmpty: true });

  return {
    WFQuickActionSurfaces: [],
    WFWorkflowActions: actions,
    WFWorkflowClientVersion: '5037.111',
    WFWorkflowHasOutputFallback: false,
    WFWorkflowHasShortcutInputVariables: true,
    WFWorkflowIcon: { WFWorkflowIconGlyphNumber: 62322, WFWorkflowIconStartColor: 2071128575 },
    WFWorkflowImportQuestions: [importQuestion({ text: IMPORT_QUESTION })],
    WFWorkflowInputContentItemClasses: INPUT_CONTENT_ITEM_CLASSES,
    WFWorkflowMinimumClientVersion: 1106,
    WFWorkflowMinimumClientVersionString: '1106',
    WFWorkflowName: SHORTCUT_NAME,
    WFWorkflowOutputContentItemClasses: [],
    WFWorkflowTriggers: buildTriggers(),
    WFWorkflowTypes: ['WFWorkflowTypeShowInSearch'],
  };
};

export const renderPaymentsShortcutXml = (): string =>
  `${plist.build(buildPaymentsShortcut() as never, { indent: '\t', newline: '\n' })}\n`;

const OUTPUT_PATH = fileURLToPath(new URL('../../shortcuts/log-payments.plist', import.meta.url));

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(OUTPUT_PATH, renderPaymentsShortcutXml());
}
