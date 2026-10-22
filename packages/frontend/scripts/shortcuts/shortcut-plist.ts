/**
 * Building blocks shared by the Shortcut generators: the action and parameter names, the token
 * serialization, and a kit that adds the steps both shortcuts have in common (decode the setup
 * code, send a request with one retry while a base-currency change runs, show the banner).
 *
 * Every action UUID derives from a seed and its position, so the output is deterministic and a change
 * shows up as a readable diff of the committed XML.
 */
import { createHash } from 'node:crypto';

export type Dict = Record<string, unknown>;

/**
 * Action identifiers and parameter keys, kept in one place. `notification`, the ExtensionInput
 * variable shape and the property names come from shortcuts captured on a device
 * (`fixtures/transaction-input.xml`, `fixtures/triggers-input.xml`); the rest follow the public
 * Shortcuts file format and were not checked against an export, so a rejected import starts here.
 */
export const SHORTCUT_ACTIONS = {
  text: 'is.workflow.actions.gettext',
  replaceText: 'is.workflow.actions.text.replace',
  matchText: 'is.workflow.actions.text.match',
  base64: 'is.workflow.actions.base64encode',
  detectText: 'is.workflow.actions.detect.text',
  detectDictionary: 'is.workflow.actions.detect.dictionary',
  getValue: 'is.workflow.actions.getvalueforkey',
  conditional: 'is.workflow.actions.conditional',
  currentDate: 'is.workflow.actions.date',
  formatDate: 'is.workflow.actions.format.date',
  hash: 'is.workflow.actions.hash',
  downloadUrl: 'is.workflow.actions.downloadurl',
  setVariable: 'is.workflow.actions.setvariable',
  notification: 'is.workflow.actions.notification',
  wait: 'is.workflow.actions.delay',
  exit: 'is.workflow.actions.exit',
} as const;

export const SHORTCUT_PARAMS = {
  uuid: 'UUID',
  input: 'WFInput',
  textActionText: 'WFTextActionText',
  replaceFind: 'WFReplaceTextFind',
  replaceWith: 'WFReplaceTextReplace',
  replaceRegex: 'WFReplaceTextRegularExpression',
  replaceCaseSensitive: 'WFReplaceTextCaseSensitive',
  matchPattern: 'WFMatchTextPattern',
  matchCaseSensitive: 'WFMatchTextCaseSensitive',
  matchText: 'text',
  encodeMode: 'WFEncodeMode',
  dictionaryKey: 'WFDictionaryKey',
  valueType: 'WFGetDictionaryValueType',
  controlFlowMode: 'WFControlFlowMode',
  groupingIdentifier: 'GroupingIdentifier',
  condition: 'WFCondition',
  conditionString: 'WFConditionalActionString',
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
  waitTime: 'WFDelayTime',
  notificationBody: 'WFNotificationActionBody',
} as const;

/** Shortcuts stores the If condition as a number. */
export const CONDITION_CODES = {
  Is: 4,
  Contains: 99,
  'Has Any Value': 100,
  'Does Not Have Any Value': 101,
} as const;

/** Placeholder character that stands for each attachment inside a `WFTextTokenString`. */
const PLACEHOLDER = '￼';

/** How long the shortcut waits before it sends a request again after a 423. */
export const BUSY_RETRY_WAIT_SECONDS = 20;

/** The `code` of the 423 answer while a base-currency change runs. Matches `API_ERROR_CODES.baseCurrencyChangeInProgress`. */
export const BUSY_ERROR_CODE = 'BASE_CURRENCY_CHANGE_IN_PROGRESS';

/** The generic default of Shortcuts' own input classes. */
export const INPUT_CONTENT_ITEM_CLASSES = [
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

interface Output {
  uuid: string;
  name: string;
}

/** The trigger variables of a shortcut that carries `WFWorkflowTriggers`. */
type TriggerName = 'notification' | 'wallet';

export const TRIGGER_IDENTIFIERS = {
  notification: 'WFNotificationTrigger',
  wallet: 'WFWalletTransactionTrigger',
} as const satisfies Record<TriggerName, string>;

/** One attachment of a text token: an action output, a named variable, a trigger variable or the Shortcut Input. */
type Reference = (
  | { kind: 'output'; output: Output; property?: string }
  | { kind: 'variable'; name: string }
  | { kind: 'trigger'; trigger: TriggerName; property?: string }
  | { kind: 'input'; property?: string; userInfo?: string }
) & {
  /** Reads the value as text ("... as Text"), the only type iOS offers `Is` and `Contains` for. */
  asText?: boolean;
};

/** The conditions that compare against text, and so need a text subject. */
const STRING_CONDITIONS = ['Is', 'Contains'] as const satisfies ReadonlyArray<keyof typeof CONDITION_CODES>;

const TEXT_COERCION: Dict = { CoercionItemClass: 'WFStringContentItem', Type: 'WFCoercionVariableAggrandizement' };

export const uuidFor = ({ seed, index }: { seed: string; index: number }): string => {
  const hex = createHash('sha256').update(`${seed}:${index}`).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = '89ab'[parseInt(hex[16]!, 16) % 4]!;
  const flat = hex.join('').toUpperCase();

  return `${flat.slice(0, 8)}-${flat.slice(8, 12)}-${flat.slice(12, 16)}-${flat.slice(16, 20)}-${flat.slice(20)}`;
};

/** The property read comes first, the coercion to text after it, as iOS writes "App as Text". */
const aggrandizements = ({
  property,
  userInfo,
  asText,
}: {
  property?: string;
  userInfo?: string;
  asText?: boolean;
}): Dict[] | undefined => {
  const chain: Dict[] = [
    ...(property
      ? [
          {
            ...(userInfo ? { PropertyUserInfo: userInfo } : {}),
            PropertyName: property,
            Type: 'WFPropertyVariableAggrandizement',
          },
        ]
      : []),
    ...(asText ? [TEXT_COERCION] : []),
  ];

  return chain.length ? chain : undefined;
};

const attachment = ({ reference }: { reference: Reference }): Dict => {
  const aggr = aggrandizements({
    property: reference.kind === 'variable' ? undefined : reference.property,
    userInfo: reference.kind === 'input' ? reference.userInfo : undefined,
    asText: reference.asText,
  });
  const withAggr = aggr ? { Aggrandizements: aggr } : {};

  if (reference.kind === 'variable') return { ...withAggr, Type: 'Variable', VariableName: reference.name };
  if (reference.kind === 'input') return { ...withAggr, Type: 'ExtensionInput' };
  if (reference.kind === 'trigger') {
    return { ...withAggr, TriggerIdentifier: TRIGGER_IDENTIFIERS[reference.trigger], Type: 'TriggerOutput' };
  }

  return { ...withAggr, OutputName: reference.output.name, OutputUUID: reference.output.uuid, Type: 'ActionOutput' };
};

/** A text value made of literal pieces and references, in order. */
export const tokenString = ({ parts }: { parts: (string | Reference)[] }): Dict => {
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

/** Index of the action the import question fills in: the setup-code Text action is always first. */
const IMPORT_QUESTION_ACTION_INDEX = 0;

export const importQuestion = ({ text }: { text: string }): Dict => ({
  ActionIndex: IMPORT_QUESTION_ACTION_INDEX,
  Category: 'Parameter',
  DefaultValue: '',
  ParameterKey: SHORTCUT_PARAMS.textActionText,
  Text: text,
});

/** Builds the actions in order, each with a seeded UUID and a handle for later references. */
export const createShortcutKit = ({ seed, name }: { seed: string; name: string }) => {
  const actions: Dict[] = [];
  let nextGroup = 0;

  const add = ({
    identifier,
    name: outputName,
    parameters,
  }: {
    identifier: string;
    name: string;
    parameters: Dict;
  }): Output & { index: number } => {
    const index = actions.length;
    const uuid = uuidFor({ seed, index });

    actions.push({
      WFWorkflowActionIdentifier: identifier,
      WFWorkflowActionParameters: { ...parameters, [SHORTCUT_PARAMS.uuid]: uuid },
    });

    return { uuid, name: outputName, index };
  };

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
  const trigger = ({ trigger: triggerName, property }: { trigger: TriggerName; property?: string }): Reference => ({
    kind: 'trigger',
    trigger: triggerName,
    property,
  });
  const variable = ({ name: variableName }: { name: string }): Reference => ({ kind: 'variable', name: variableName });

  /** Each If ... End If block shares one grouping identifier; `openGroup` hands out the next one. */
  const openGroup = (): number => 10_000 + nextGroup++;

  /** A text comparison reads its subject as text: iOS offers `Is` and `Contains` only for text, and a dictionary value or an app is not. */
  const subjectFor = ({
    subject,
    condition,
  }: {
    subject: Reference;
    condition: keyof typeof CONDITION_CODES;
  }): Reference =>
    (STRING_CONDITIONS as ReadonlyArray<string>).includes(condition) ? { ...subject, asText: true } : subject;

  const conditional = ({
    group,
    mode,
    subject,
    condition,
    value,
  }: {
    group: number;
    mode: 0 | 1 | 2;
    subject?: Reference;
    condition?: keyof typeof CONDITION_CODES;
    value?: string;
  }) =>
    add({
      identifier: SHORTCUT_ACTIONS.conditional,
      name: 'If Result',
      parameters: {
        [SHORTCUT_PARAMS.groupingIdentifier]: uuidFor({ seed, index: group }),
        [SHORTCUT_PARAMS.controlFlowMode]: mode,
        ...(condition && subject
          ? {
              [SHORTCUT_PARAMS.condition]: CONDITION_CODES[condition],
              [SHORTCUT_PARAMS.input]: {
                Type: 'Variable',
                Variable: tokenAttachment({ reference: subjectFor({ subject, condition }) }),
              },
              ...(value === undefined ? {} : { [SHORTCUT_PARAMS.conditionString]: value }),
            }
          : {}),
      },
    });

  const setVariable = ({ name: variableName, output }: { name: string; output: Output }) =>
    add({
      identifier: SHORTCUT_ACTIONS.setVariable,
      name: variableName,
      parameters: {
        [SHORTCUT_PARAMS.variableName]: variableName,
        [SHORTCUT_PARAMS.input]: tokenAttachment({ reference: from({ output }) }),
      },
    });

  const getValue = ({ key, source }: { key: string; source: Reference }) =>
    add({
      identifier: SHORTCUT_ACTIONS.getValue,
      name: 'Dictionary Value',
      parameters: {
        [SHORTCUT_PARAMS.dictionaryKey]: key,
        [SHORTCUT_PARAMS.valueType]: 'Value',
        [SHORTCUT_PARAMS.input]: tokenAttachment({ reference: source }),
      },
    });

  const showBanner = ({ parts }: { parts: (string | Reference)[] }) =>
    add({
      identifier: SHORTCUT_ACTIONS.notification,
      name: 'Notification',
      parameters: {
        // No title: iOS names the shortcut once in the banner's header, and a title would say it again.
        [SHORTCUT_PARAMS.notificationBody]: tokenString({ parts }),
      },
    });

  const stop = () => add({ identifier: SHORTCUT_ACTIONS.exit, name: 'Stop', parameters: {} });

  /** Shows `message` and stops when `value` is empty. */
  const stopWhenEmpty = ({ value, message }: { value: Output; message: string }) => {
    const group = openGroup();

    conditional({ group, mode: 0, subject: from({ output: value }), condition: 'Does Not Have Any Value' });
    showBanner({ parts: [message] });
    stop();
    conditional({ group, mode: 2 });
  };

  /** Formats a date reference; a typed-into field, so Shortcuts serializes it as a text token. */
  const formatDate = ({ date, parameters }: { date: Reference; parameters: Dict }) =>
    add({
      identifier: SHORTCUT_ACTIONS.formatDate,
      name: 'Formatted Date',
      parameters: { ...parameters, [SHORTCUT_PARAMS.date]: tokenString({ parts: [date] }) },
    });

  const currentDate = () =>
    add({
      identifier: SHORTCUT_ACTIONS.currentDate,
      name: 'Date',
      parameters: { [SHORTCUT_PARAMS.dateActionMode]: 'Current Date' },
    });

  const hashOf = ({ parts }: { parts: (string | Reference)[] }) => {
    const keyText = add({
      identifier: SHORTCUT_ACTIONS.text,
      name: 'Text',
      parameters: { [SHORTCUT_PARAMS.textActionText]: tokenString({ parts }) },
    });

    return add({
      identifier: SHORTCUT_ACTIONS.hash,
      name: 'Hash',
      parameters: {
        [SHORTCUT_PARAMS.hashType]: 'SHA256',
        [SHORTCUT_PARAMS.input]: tokenAttachment({ reference: from({ output: keyText }) }),
      },
    });
  };

  /**
   * The setup code → url, token, the Cloudflare Access pair and, when asked for, the optional gate.
   * The first action is the Text action the import question fills in.
   */
  const decodeSetupCode = ({ withGate, missingCodeError, unreadableCodeError }: DecodeSetupParams) => {
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
        // A typed-into slot: Shortcuts serializes it as a text token, like `WFDate`. Pure variable slots
        // (Decode, Get Text, Get Dictionary, Get Value, Hash, Set Variable) take a bare attachment.
        [SHORTCUT_PARAMS.input]: tokenString({ parts: [from({ output: code })] }),
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
    // Base64 Decode yields untyped data; reading it as text first makes the next step parse JSON.
    const decodedText = add({
      identifier: SHORTCUT_ACTIONS.detectText,
      name: 'Text',
      parameters: { [SHORTCUT_PARAMS.input]: tokenAttachment({ reference: from({ output: decoded }) }) },
    });
    const setup = add({
      identifier: SHORTCUT_ACTIONS.detectDictionary,
      name: 'Dictionary',
      parameters: { [SHORTCUT_PARAMS.input]: tokenAttachment({ reference: from({ output: decodedText }) }) },
    });
    const setupValue = ({ key }: { key: string }) => getValue({ key, source: from({ output: setup }) });
    const url = setupValue({ key: 'url' });
    const token = setupValue({ key: 'token' });
    const accessId = setupValue({ key: 'cfAccessId' });
    const accessSecret = setupValue({ key: 'cfAccessSecret' });
    const gate = withGate ? setupValue({ key: 'gate' }) : undefined;

    // No setup code, or one that cannot be read, leaves `url` or `token` empty; stop with a message instead of
    // letting Get Contents of URL fail with "No URL Specified". The Cloudflare pair and the gate are optional.
    stopWhenEmpty({ value: code, message: missingCodeError });
    stopWhenEmpty({ value: url, message: unreadableCodeError });
    stopWhenEmpty({ value: token, message: unreadableCodeError });

    return { code, url, token, accessId, accessSecret, gate };
  };

  const headers = ({ token, accessId, accessSecret }: Pick<SetupOutputs, 'token' | 'accessId' | 'accessSecret'>) =>
    dictionaryValue({
      entries: [
        { key: 'Authorization', value: ['Bearer ', from({ output: token })] },
        { key: 'CF-Access-Client-Id', value: [from({ output: accessId })] },
        { key: 'CF-Access-Client-Secret', value: [from({ output: accessSecret })] },
      ],
    });

  /**
   * Adds the POST requests and the banner steps for one setup. `send` posts a body and sets the variable
   * `Response`; `sendWithRetry` does so and, when the answer is the 423 of a running base-currency
   * change, waits once and sends the same body (and key) again.
   */
  const createSender = ({ target, setup }: { target: Reference; setup: SetupOutputs }) => {
    const request = ({ entries }: { entries: DictionaryEntry[] }) =>
      add({
        identifier: SHORTCUT_ACTIONS.downloadUrl,
        name: 'Contents of URL',
        parameters: {
          [SHORTCUT_PARAMS.url]: tokenString({ parts: [target] }),
          [SHORTCUT_PARAMS.httpMethod]: 'POST',
          [SHORTCUT_PARAMS.httpBodyType]: 'JSON',
          [SHORTCUT_PARAMS.httpHeaders]: headers(setup),
          [SHORTCUT_PARAMS.jsonValues]: dictionaryValue({ entries }),
        },
      });

    const send = ({ entries }: { entries: DictionaryEntry[] }) =>
      setVariable({ name: 'Response', output: request({ entries }) });

    const sendWithRetry = ({ entries }: { entries: DictionaryEntry[] }) => {
      send({ entries });

      // The answer wraps its fields in `response`; an error carries `code` and `message`.
      const answer = getValue({ key: 'response', source: variable({ name: 'Response' }) });
      const errorCode = getValue({ key: 'code', source: from({ output: answer }) });
      const group = openGroup();

      conditional({ group, mode: 0, subject: from({ output: errorCode }), condition: 'Is', value: BUSY_ERROR_CODE });
      add({
        identifier: SHORTCUT_ACTIONS.wait,
        name: 'Wait',
        parameters: { [SHORTCUT_PARAMS.waitTime]: BUSY_RETRY_WAIT_SECONDS },
      });
      send({ entries });
      conditional({ group, mode: 2 });
    };

    return { send, sendWithRetry };
  };

  /**
   * Shows the answer's `summary`, or its `message` when it is an error. With `silentWhenEmpty` an answer
   * with neither (an ignored notification) shows nothing.
   */
  const showAnswerBanner = ({ silentWhenEmpty }: { silentWhenEmpty: boolean }) => {
    const response = getValue({ key: 'response', source: variable({ name: 'Response' }) });

    setVariable({ name: 'Summary', output: getValue({ key: 'summary', source: from({ output: response }) }) });

    const group = openGroup();

    conditional({ group, mode: 0, subject: variable({ name: 'Summary' }), condition: 'Does Not Have Any Value' });
    setVariable({ name: 'Summary', output: getValue({ key: 'message', source: from({ output: response }) }) });
    conditional({ group, mode: 2 });

    if (!silentWhenEmpty) {
      showBanner({ parts: [variable({ name: 'Summary' })] });

      return;
    }

    const showGroup = openGroup();

    conditional({ group: showGroup, mode: 0, subject: variable({ name: 'Summary' }), condition: 'Has Any Value' });
    showBanner({ parts: [variable({ name: 'Summary' })] });
    conditional({ group: showGroup, mode: 2 });
  };

  return {
    actions,
    add,
    from,
    shortcutInput,
    trigger,
    variable,
    openGroup,
    conditional,
    setVariable,
    getValue,
    showBanner,
    stop,
    stopWhenEmpty,
    formatDate,
    currentDate,
    hashOf,
    decodeSetupCode,
    createSender,
    showAnswerBanner,
  };
};

interface DecodeSetupParams {
  withGate: boolean;
  missingCodeError: string;
  unreadableCodeError: string;
}

interface SetupOutputs {
  url: Output;
  token: Output;
  accessId: Output;
  accessSecret: Output;
}
