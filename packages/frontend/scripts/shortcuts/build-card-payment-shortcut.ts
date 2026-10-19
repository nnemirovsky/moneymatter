/**
 * Generates the unsigned "MoneyMatter: log card payment" Shortcut as an XML property list.
 *
 * `npm run shortcuts:build` writes `shortcuts/log-card-payment.plist`; the maintainer signs that
 * file on macOS (`shortcuts sign`, see `public/shortcuts/README.md`). The output is
 * deterministic: every action UUID derives from a fixed seed and its position, so a change to this
 * script shows up as a readable diff of the committed XML, and the spec fails on any drift.
 *
 * The flow is described under "Generic shortcut" in the Apple Pay ingest plan: decode the setup
 * code, then either log the payment of the Wallet automation or, with no input (a manual run),
 * send a dry run.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import plist from 'plist';

type Dict = Record<string, unknown>;

/**
 * Action identifiers and parameter keys, kept in one place. `notification`, the ExtensionInput
 * variable shape and the property names come from a shortcut captured on a device
 * (`fixtures/transaction-input.xml`); the rest follow the public Shortcuts file format and were
 * not checked against an export, so a rejected import starts here.
 */
export const SHORTCUT_ACTIONS = {
  text: 'is.workflow.actions.gettext',
  replaceText: 'is.workflow.actions.text.replace',
  base64: 'is.workflow.actions.base64encode',
  detectDictionary: 'is.workflow.actions.detect.dictionary',
  getValue: 'is.workflow.actions.getvalueforkey',
  conditional: 'is.workflow.actions.conditional',
  currentDate: 'is.workflow.actions.date',
  formatDate: 'is.workflow.actions.format.date',
  hash: 'is.workflow.actions.hash',
  downloadUrl: 'is.workflow.actions.downloadurl',
  setVariable: 'is.workflow.actions.setvariable',
  notification: 'is.workflow.actions.notification',
} as const;

export const SHORTCUT_PARAMS = {
  uuid: 'UUID',
  input: 'WFInput',
  textActionText: 'WFTextActionText',
  replaceFind: 'WFReplaceTextFind',
  replaceWith: 'WFReplaceTextReplace',
  replaceRegex: 'WFReplaceTextRegularExpression',
  replaceCaseSensitive: 'WFReplaceTextCaseSensitive',
  encodeMode: 'WFEncodeMode',
  dictionaryKey: 'WFDictionaryKey',
  valueType: 'WFGetDictionaryValueType',
  controlFlowMode: 'WFControlFlowMode',
  groupingIdentifier: 'GroupingIdentifier',
  condition: 'WFCondition',
  dateActionMode: 'WFDateActionMode',
  date: 'WFDate',
  dateFormatStyle: 'WFDateFormatStyle',
  isoIncludeTime: 'WFISO8601IncludeTime',
  dateFormat: 'WFDateFormat',
  hashType: 'WFHashType',
  url: 'WFURL',
  httpMethod: 'WFHTTPMethod',
  httpBodyType: 'WFHTTPBodyType',
  httpHeaders: 'WFHTTPHeaders',
  jsonValues: 'WFJSONValues',
  variableName: 'WFVariableName',
  notificationBody: 'WFNotificationActionBody',
  notificationTitle: 'WFNotificationActionTitle',
} as const;

/** Shortcuts stores the If condition as a number. */
export const CONDITION_CODES = { 'Has Any Value': 100, 'Does Not Have Any Value': 101 } as const;

/** Placeholder character that stands for each attachment inside a `WFTextTokenString`. */
const PLACEHOLDER = '￼';

const SEED = 'moneymatter-log-card-payment-shortcut-v1';
const SHORTCUT_NAME = 'MoneyMatter: log card payment';
const IMPORT_QUESTION = 'Paste the setup code from the Apple Pay page in MoneyMatter (Accounts → Apple Pay).';
const KEY_TIME_FORMAT = "yyyy-MM-dd'T'HH:mmZZZZZ";
const SOURCE = 'apple-pay';
const IMPORT_QUESTION_ACTION_INDEX = 0;

/** The generic default of Shortcuts' own input classes: the Wallet transaction has no class of its own. */
const INPUT_CONTENT_ITEM_CLASSES = [
  'WFAppContentItem',
  'WFAppStoreAppContentItem',
  'WFArticleContentItem',
  'WFContactContentItem',
  'WFDateContentItem',
  'WFEmailAddressContentItem',
  'WFFolderContentItem',
  'WFGenericFileContentItem',
  'WFImageContentItem',
  'WFiTunesProductContentItem',
  'WFLocationContentItem',
  'WFDCMapsLinkContentItem',
  'WFAVAssetContentItem',
  'WFPDFContentItem',
  'WFPhoneNumberContentItem',
  'WFRichTextContentItem',
  'WFSafariWebPageContentItem',
  'WFStringContentItem',
  'WFURLContentItem',
];

/** Property names of the Wallet transaction input, as the device shows them. */
const INPUT_PROPERTY = {
  merchant: 'Merchant',
  amount: 'Amount',
  card: 'Card or Pass',
  name: 'Name',
} as const;

interface Output {
  uuid: string;
  name: string;
}

/** One attachment of a text token: an action output, a named variable or the Shortcut Input. */
type Reference =
  | { kind: 'output'; output: Output; property?: string }
  | { kind: 'variable'; name: string }
  | { kind: 'input'; property?: string; userInfo?: string };

const uuidFor = ({ index }: { index: number }): string => {
  const hex = createHash('sha256').update(`${SEED}:${index}`).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = '89ab'[parseInt(hex[16]!, 16) % 4]!;
  const flat = hex.join('').toUpperCase();

  return `${flat.slice(0, 8)}-${flat.slice(8, 12)}-${flat.slice(12, 16)}-${flat.slice(16, 20)}-${flat.slice(20)}`;
};

const aggrandizements = ({ property, userInfo }: { property?: string; userInfo?: string }): Dict[] | undefined =>
  property
    ? [
        {
          ...(userInfo ? { PropertyUserInfo: userInfo } : {}),
          PropertyName: property,
          Type: 'WFPropertyVariableAggrandizement',
        },
      ]
    : undefined;

const attachment = ({ reference }: { reference: Reference }): Dict => {
  if (reference.kind === 'variable') return { Type: 'Variable', VariableName: reference.name };

  const aggr = aggrandizements({
    property: reference.property,
    userInfo: reference.kind === 'input' ? reference.userInfo : undefined,
  });

  return reference.kind === 'input'
    ? { ...(aggr ? { Aggrandizements: aggr } : {}), Type: 'ExtensionInput' }
    : {
        ...(aggr ? { Aggrandizements: aggr } : {}),
        OutputName: reference.output.name,
        OutputUUID: reference.output.uuid,
        Type: 'ActionOutput',
      };
};

/** A text value made of literal pieces and references, in order. */
const tokenString = ({ parts }: { parts: (string | Reference)[] }): Dict => {
  let string = '';
  const attachmentsByRange: Dict = {};

  for (const part of parts) {
    if (typeof part === 'string') {
      string += part;
    } else {
      attachmentsByRange[`{${string.length}, 1}`] = attachment({ reference: part });
      string += PLACEHOLDER;
    }
  }

  return {
    Value: { ...(Object.keys(attachmentsByRange).length ? { attachmentsByRange } : {}), string },
    WFSerializationType: 'WFTextTokenString',
  };
};

/** A parameter that is exactly one reference (an action's input). */
const tokenAttachment = ({ reference }: { reference: Reference }): Dict => ({
  Value: attachment({ reference }),
  WFSerializationType: 'WFTextTokenAttachment',
});

type DictionaryEntry = { key: string; value: (string | Reference)[] | boolean };

const dictionaryValue = ({ entries }: { entries: DictionaryEntry[] }): Dict => ({
  Value: {
    WFDictionaryFieldValueItems: entries.map(({ key, value }) =>
      typeof value === 'boolean'
        ? {
            WFItemType: 4,
            WFKey: tokenString({ parts: [key] }),
            WFValue: { Value: value, WFSerializationType: 'WFNumberSubstitutableState' },
          }
        : { WFItemType: 0, WFKey: tokenString({ parts: [key] }), WFValue: tokenString({ parts: value }) },
    ),
  },
  WFSerializationType: 'WFDictionaryFieldValue',
});

/** Builds the actions in order, each with a seeded UUID and a handle for later references. */
const createBuilder = () => {
  const actions: Dict[] = [];

  const add = ({
    identifier,
    name,
    parameters,
  }: {
    identifier: string;
    name: string;
    parameters: Dict;
  }): Output & { index: number } => {
    const index = actions.length;
    const uuid = uuidFor({ index });

    actions.push({
      WFWorkflowActionIdentifier: identifier,
      WFWorkflowActionParameters: { ...parameters, [SHORTCUT_PARAMS.uuid]: uuid },
    });

    return { uuid, name, index };
  };

  return { actions, add };
};

export const buildCardPaymentShortcut = (): Dict => {
  const { actions, add } = createBuilder();
  const from = ({ output, property }: { output: Output; property?: string }): Reference => ({
    kind: 'output',
    output,
    property,
  });
  const shortcutInput = ({ property, userInfo }: { property?: string; userInfo?: string } = {}): Reference => ({
    kind: 'input',
    property,
    userInfo,
  });

  // 1-8: the setup code → url, token and the Cloudflare Access pair.
  const code = add({
    identifier: SHORTCUT_ACTIONS.text,
    name: 'Text',
    parameters: { [SHORTCUT_PARAMS.textActionText]: '' },
  });
  // `.` is not a base64 character, so the `v1.` prefix has to go before decoding.
  const stripped = add({
    identifier: SHORTCUT_ACTIONS.replaceText,
    name: 'Updated Text',
    parameters: {
      [SHORTCUT_PARAMS.replaceFind]: '^v1\\.',
      [SHORTCUT_PARAMS.replaceWith]: '',
      [SHORTCUT_PARAMS.replaceRegex]: true,
      [SHORTCUT_PARAMS.replaceCaseSensitive]: true,
      [SHORTCUT_PARAMS.input]: tokenAttachment({ reference: from({ output: code }) }),
    },
  });
  const decoded = add({
    identifier: SHORTCUT_ACTIONS.base64,
    name: 'Base64 Encoded',
    parameters: {
      [SHORTCUT_PARAMS.encodeMode]: 'Decode',
      [SHORTCUT_PARAMS.input]: tokenAttachment({ reference: from({ output: stripped }) }),
    },
  });
  const setup = add({
    identifier: SHORTCUT_ACTIONS.detectDictionary,
    name: 'Dictionary',
    parameters: { [SHORTCUT_PARAMS.input]: tokenAttachment({ reference: from({ output: decoded }) }) },
  });
  const getSetupValue = ({ key }: { key: string }) =>
    add({
      identifier: SHORTCUT_ACTIONS.getValue,
      name: 'Dictionary Value',
      parameters: {
        [SHORTCUT_PARAMS.dictionaryKey]: key,
        [SHORTCUT_PARAMS.valueType]: 'Value',
        [SHORTCUT_PARAMS.input]: tokenAttachment({ reference: from({ output: setup }) }),
      },
    });
  const url = getSetupValue({ key: 'url' });
  const token = getSetupValue({ key: 'token' });
  const accessId = getSetupValue({ key: 'cfAccessId' });
  const accessSecret = getSetupValue({ key: 'cfAccessSecret' });

  const headers = (): Dict =>
    dictionaryValue({
      entries: [
        { key: 'Authorization', value: ['Bearer ', from({ output: token })] },
        { key: 'CF-Access-Client-Id', value: [from({ output: accessId })] },
        { key: 'CF-Access-Client-Secret', value: [from({ output: accessSecret })] },
      ],
    });

  const request = ({ entries }: { entries: DictionaryEntry[] }) =>
    add({
      identifier: SHORTCUT_ACTIONS.downloadUrl,
      name: 'Contents of URL',
      parameters: {
        [SHORTCUT_PARAMS.url]: tokenString({ parts: [from({ output: url })] }),
        [SHORTCUT_PARAMS.httpMethod]: 'POST',
        [SHORTCUT_PARAMS.httpBodyType]: 'JSON',
        [SHORTCUT_PARAMS.httpHeaders]: headers(),
        [SHORTCUT_PARAMS.jsonValues]: dictionaryValue({ entries }),
      },
    });

  // Each If ... End If block shares one grouping identifier.
  const conditional = ({
    group,
    mode,
    subject,
    condition,
  }: {
    group: number;
    mode: 0 | 1 | 2;
    subject?: Reference;
    condition?: keyof typeof CONDITION_CODES;
  }) =>
    add({
      identifier: SHORTCUT_ACTIONS.conditional,
      name: 'If Result',
      parameters: {
        [SHORTCUT_PARAMS.groupingIdentifier]: uuidFor({ index: group }),
        [SHORTCUT_PARAMS.controlFlowMode]: mode,
        ...(condition && subject
          ? {
              [SHORTCUT_PARAMS.condition]: CONDITION_CODES[condition],
              [SHORTCUT_PARAMS.input]: { Type: 'Variable', Variable: tokenAttachment({ reference: subject }) },
            }
          : {}),
      },
    });

  // 9-..: the Wallet automation passes the payment as Shortcut Input; a manual run has none.
  conditional({ group: 1000, mode: 0, subject: shortcutInput(), condition: 'Has Any Value' });

  const now = add({
    identifier: SHORTCUT_ACTIONS.currentDate,
    name: 'Date',
    parameters: { [SHORTCUT_PARAMS.dateActionMode]: 'Current Date' },
  });
  const formatDate = ({ name, parameters }: { name: string; parameters: Dict }) =>
    add({
      identifier: SHORTCUT_ACTIONS.formatDate,
      name,
      parameters: { ...parameters, [SHORTCUT_PARAMS.date]: tokenAttachment({ reference: from({ output: now }) }) },
    });
  // The input carries no date, so the run time stands in for the payment time.
  const isoTime = formatDate({
    name: 'Formatted Date',
    parameters: { [SHORTCUT_PARAMS.dateFormatStyle]: 'ISO 8601', [SHORTCUT_PARAMS.isoIncludeTime]: true },
  });
  const keyTime = formatDate({
    name: 'Formatted Date',
    parameters: { [SHORTCUT_PARAMS.dateFormatStyle]: 'Custom', [SHORTCUT_PARAMS.dateFormat]: KEY_TIME_FORMAT },
  });
  const keyText = add({
    identifier: SHORTCUT_ACTIONS.text,
    name: 'Text',
    parameters: {
      [SHORTCUT_PARAMS.textActionText]: tokenString({
        parts: [
          shortcutInput({ property: INPUT_PROPERTY.card }),
          '|',
          shortcutInput({ property: INPUT_PROPERTY.merchant }),
          '|',
          shortcutInput({ property: INPUT_PROPERTY.amount }),
          '|',
          from({ output: keyTime }),
        ],
      }),
    },
  });
  const idempotencyKey = add({
    identifier: SHORTCUT_ACTIONS.hash,
    name: 'Hash',
    parameters: {
      [SHORTCUT_PARAMS.hashType]: 'SHA256',
      [SHORTCUT_PARAMS.input]: tokenAttachment({ reference: from({ output: keyText }) }),
    },
  });
  const paymentResponse = request({
    entries: [
      { key: 'amount', value: [shortcutInput({ property: INPUT_PROPERTY.amount })] },
      { key: 'merchant', value: [shortcutInput({ property: INPUT_PROPERTY.merchant })] },
      { key: 'card', value: [shortcutInput({ property: INPUT_PROPERTY.card })] },
      { key: 'name', value: [shortcutInput({ property: INPUT_PROPERTY.name, userInfo: 'WFItemName' })] },
      { key: 'time', value: [from({ output: isoTime })] },
      { key: 'idempotencyKey', value: [from({ output: idempotencyKey })] },
      { key: 'source', value: [SOURCE] },
    ],
  });
  const setResponse = ({ output }: { output: Output }) =>
    add({
      identifier: SHORTCUT_ACTIONS.setVariable,
      name: 'Response',
      parameters: {
        [SHORTCUT_PARAMS.variableName]: 'Response',
        [SHORTCUT_PARAMS.input]: tokenAttachment({ reference: from({ output }) }),
      },
    });
  setResponse({ output: paymentResponse });

  conditional({ group: 1000, mode: 1 });
  setResponse({ output: request({ entries: [{ key: 'dryRun', value: true }] }) });
  conditional({ group: 1000, mode: 2 });

  // The answer wraps its fields in `response`; an error carries `message` instead of `summary`.
  const getResponseValue = ({ key, source }: { key: string; source: Reference }) =>
    add({
      identifier: SHORTCUT_ACTIONS.getValue,
      name: 'Dictionary Value',
      parameters: {
        [SHORTCUT_PARAMS.dictionaryKey]: key,
        [SHORTCUT_PARAMS.valueType]: 'Value',
        [SHORTCUT_PARAMS.input]: tokenAttachment({ reference: source }),
      },
    });
  const setVariable = ({ name, output }: { name: string; output: Output }) =>
    add({
      identifier: SHORTCUT_ACTIONS.setVariable,
      name,
      parameters: {
        [SHORTCUT_PARAMS.variableName]: name,
        [SHORTCUT_PARAMS.input]: tokenAttachment({ reference: from({ output }) }),
      },
    });

  const response = getResponseValue({ key: 'response', source: { kind: 'variable', name: 'Response' } });
  setVariable({ name: 'Summary', output: getResponseValue({ key: 'summary', source: from({ output: response }) }) });
  conditional({
    group: 1001,
    mode: 0,
    subject: { kind: 'variable', name: 'Summary' },
    condition: 'Does Not Have Any Value',
  });
  setVariable({ name: 'Summary', output: getResponseValue({ key: 'message', source: from({ output: response }) }) });
  conditional({ group: 1001, mode: 2 });

  add({
    identifier: SHORTCUT_ACTIONS.notification,
    name: 'Notification',
    parameters: {
      [SHORTCUT_PARAMS.notificationTitle]: SHORTCUT_NAME,
      [SHORTCUT_PARAMS.notificationBody]: tokenString({ parts: [{ kind: 'variable', name: 'Summary' }] }),
    },
  });

  return {
    WFQuickActionSurfaces: [],
    WFWorkflowActions: actions,
    WFWorkflowClientVersion: '4711',
    WFWorkflowHasOutputFallback: false,
    WFWorkflowHasShortcutInputVariables: true,
    WFWorkflowIcon: { WFWorkflowIconGlyphNumber: 61440, WFWorkflowIconStartColor: -23508481 },
    WFWorkflowImportQuestions: [
      {
        ActionIndex: IMPORT_QUESTION_ACTION_INDEX,
        Category: 'Parameter',
        DefaultValue: '',
        ParameterKey: SHORTCUT_PARAMS.textActionText,
        Text: IMPORT_QUESTION,
      },
    ],
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
