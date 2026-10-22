import {
  AMOUNT_GATE_PATTERNS,
  AMOUNT_GATE_REGEX_FLAGS,
  AMOUNT_GATE_SAMPLES,
  API_ERROR_CODES,
  CARD_PAYMENT_REQUEST_KEYS,
  CONVERSATIONAL_APP_GATE_PATTERN,
  INGEST_EVENT_KINDS,
  NOTIFICATION_REQUEST_KEYS,
  SECURITY_GATE_PATTERN,
  encodeSetupCode,
} from '@bt/shared/types';
// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import plist from 'plist';
import { describe, expect, it } from 'vitest';

import {
  EVENT_URL_FIND,
  EVENT_URL_REPLACE,
  KEY_TIME_FORMAT,
  TIME_ZONE_FORMAT,
  NOTIFICATION_PROPERTY,
  OWN_APP_NAMES,
  PRESELECTED_APPS,
  TRANSACTION_PROPERTY,
  buildPaymentsShortcut,
  renderPaymentsShortcutXml,
} from './build-payments-shortcut';
import {
  BUSY_ERROR_CODE,
  BUSY_RETRY_WAIT_SECONDS,
  CONDITION_CODES,
  SHORTCUT_ACTIONS,
  SHORTCUT_PARAMS,
  TRIGGER_IDENTIFIERS,
} from './shortcut-plist';

type Dict = Record<string, any>;

const COMMITTED_XML = fileURLToPath(new URL('../../shortcuts/log-payments.plist', import.meta.url));
const TRANSACTION_FIXTURE = fileURLToPath(new URL('./fixtures/transaction-input.xml', import.meta.url));
const TRIGGERS_FIXTURE = fileURLToPath(new URL('./fixtures/triggers-input.xml', import.meta.url));

const shortcut = buildPaymentsShortcut() as Dict;
const actions: Dict[] = shortcut.WFWorkflowActions;
const id = (action: Dict): string => action.WFWorkflowActionIdentifier;
const params = (action: Dict): Dict => action.WFWorkflowActionParameters;
const byId = (identifier: string): Dict[] => actions.filter((action) => id(action) === identifier);
const indexOfAction = (action: Dict): number => actions.indexOf(action);

const dictionaryItems = (value: Dict): Dict[] => value.Value.WFDictionaryFieldValueItems;
const keyOf = (item: Dict): string => item.WFKey.Value.string;
const bodyOf = (request: Dict): Record<string, Dict> =>
  Object.fromEntries(dictionaryItems(params(request)[SHORTCUT_PARAMS.jsonValues]).map((item) => [keyOf(item), item]));

/** Every attachment found anywhere under `node`. */
const attachmentsIn = (node: unknown): Dict[] => {
  const found: Dict[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') {
      const record = value as Dict;
      if (typeof record.Type === 'string') found.push(record);
      Object.values(record).forEach(walk);
    }
  };
  walk(node);

  return found;
};

/** The property names read from the trigger variable of one kind. */
const propertiesOf = ({ trigger }: { trigger: string }): string[] => [
  ...new Set(
    attachmentsIn(actions)
      .filter((record) => record.Type === 'TriggerOutput' && record.TriggerIdentifier === trigger)
      .flatMap((record) =>
        (record.Aggrandizements ?? [])
          .filter((aggr: Dict) => aggr.Type === 'WFPropertyVariableAggrandizement')
          .map((aggr: Dict) => aggr.PropertyName as string),
      ),
  ),
];

const allRequests = byId(SHORTCUT_ACTIONS.downloadUrl);
/** The sender probe of a messaging or mail notification: a request of its own, before the real ones. */
const probeRequest = allRequests.find((action) =>
  JSON.stringify(params(action)[SHORTCUT_PARAMS.jsonValues]).includes('notificationProbe'),
)!;
const requests = allRequests.filter((action) => action !== probeRequest);
// Per branch: the send, then the single resend. The manual run's dry run comes last.
const [tapRequest, tapResend, notificationRequest, notificationResend, dryRunRequest] = requests;

describe('payments shortcut generator', () => {
  it('carries the MoneyMatter icon', () => {
    expect(shortcut.WFWorkflowIcon).toEqual({ WFWorkflowIconGlyphNumber: 62322, WFWorkflowIconStartColor: 2071128575 });
  });
  it('reads the subject of every text comparison as text', () => {
    const textConditions: number[] = [CONDITION_CODES.Is, CONDITION_CODES.Contains];
    const comparisons = byId(SHORTCUT_ACTIONS.conditional).filter((action) =>
      textConditions.includes(params(action)[SHORTCUT_PARAMS.condition]),
    );

    expect(comparisons.length).toBeGreaterThan(0);
    for (const comparison of comparisons) {
      const subject = params(comparison)[SHORTCUT_PARAMS.input].Variable.Value;
      const chain: Dict[] = subject.Aggrandizements ?? [];

      // iOS offers `Is` and `Contains` only for text, so the property read comes first and the coercion last.
      expect(chain.at(-1)).toEqual({
        CoercionItemClass: 'WFStringContentItem',
        Type: 'WFCoercionVariableAggrandizement',
      });
    }
  });

  it('coerces the app of a notification and the busy code, which are not text on their own', () => {
    const subjects = byId(SHORTCUT_ACTIONS.conditional)
      .filter((action) => params(action)[SHORTCUT_PARAMS.condition] === CONDITION_CODES.Is)
      .map((action) => params(action)[SHORTCUT_PARAMS.input].Variable.Value.Aggrandizements.map((a: Dict) => a.Type));

    for (const types of subjects) expect(types.at(-1)).toBe('WFCoercionVariableAggrandizement');
  });
  it('matches the committed XML (run `npm run shortcuts:build` after a change)', () => {
    expect(readFileSync(COMMITTED_XML, 'utf8')).toBe(renderPaymentsShortcutXml());
  });

  it('is deterministic', () => {
    expect(renderPaymentsShortcutXml()).toBe(renderPaymentsShortcutXml());
  });

  it('has exactly one import question, bound to the first Text action', () => {
    const questions: Dict[] = shortcut.WFWorkflowImportQuestions;

    expect(questions).toHaveLength(1);
    expect(questions[0]!.ActionIndex).toBe(0);
    expect(questions[0]!.ParameterKey).toBe(SHORTCUT_PARAMS.textActionText);
    expect(id(actions[0]!)).toBe(SHORTCUT_ACTIONS.text);
  });

  describe('the triggers', () => {
    const fixture = plist.parse(readFileSync(TRIGGERS_FIXTURE, 'utf8')) as Dict;
    const triggers: Dict[] = shortcut.WFWorkflowTriggers;
    const wallet = triggers.find((item) => item.WFTriggerIdentifier === TRIGGER_IDENTIFIERS.wallet)!;
    const notification = triggers.find((item) => item.WFTriggerIdentifier === TRIGGER_IDENTIFIERS.notification)!;

    it('holds the Wallet Transaction trigger and a Notification trigger, each with its own UUID', () => {
      expect(triggers).toHaveLength(2);
      expect(wallet).toBeDefined();
      expect(notification).toBeDefined();
      expect(wallet.WFTriggerUUID).not.toBe(notification.WFTriggerUUID);
      expect(wallet.WFTriggerSerializedParameters).toEqual({});
    });

    it('uses the identifiers and parameter shapes of the trigger captured on an iPhone', () => {
      const captured: Dict[] = fixture.WFWorkflowTriggers;
      const capturedNotification = captured.find((item) => item.WFTriggerIdentifier === 'WFNotificationTrigger')!;

      expect(captured.map((item) => item.WFTriggerIdentifier).sort()).toEqual(
        [TRIGGER_IDENTIFIERS.notification, TRIGGER_IDENTIFIERS.wallet].sort(),
      );
      expect(Object.keys(notification.WFTriggerSerializedParameters).sort()).toEqual(
        Object.keys(capturedNotification.WFTriggerSerializedParameters).sort(),
      );
      expect(notification.WFTriggerSerializedParameters.Conditions).toEqual(
        capturedNotification.WFTriggerSerializedParameters.Conditions,
      );
    });

    it('lists Wallet and Messages, since an empty app list disables the trigger and there is no any-app', () => {
      const apps: Dict[] = notification.WFTriggerSerializedParameters.SelectedApps;

      expect(apps.length).toBeGreaterThan(0);
      expect(apps.map((app) => app.BundleIdentifier)).toEqual(['com.apple.Passbook', 'com.apple.MobileSMS']);
      expect(PRESELECTED_APPS).toHaveLength(apps.length);

      // The entries have the same keys as the ones the phone exported.
      const captured: Dict[] = fixture.WFWorkflowTriggers.find(
        (item: Dict) => item.WFTriggerIdentifier === TRIGGER_IDENTIFIERS.notification,
      ).WFTriggerSerializedParameters.SelectedApps;
      for (const app of apps) {
        const same = captured.find((item) => item.BundleIdentifier === app.BundleIdentifier)!;

        expect(same).toEqual(app);
      }
    });

    it('is in the plist that is written, which the macOS signer would drop', () => {
      const parsed = plist.parse(renderPaymentsShortcutXml()) as Dict;

      expect(parsed.WFWorkflowTriggers.map((item: Dict) => item.WFTriggerIdentifier)).toEqual([
        TRIGGER_IDENTIFIERS.wallet,
        TRIGGER_IDENTIFIERS.notification,
      ]);
    });
  });

  describe('the trigger variables', () => {
    it('reads Wallet Transaction properties the device shows', () => {
      const fixture = readFileSync(TRANSACTION_FIXTURE, 'utf8');
      const names = propertiesOf({ trigger: TRIGGER_IDENTIFIERS.wallet });

      expect(names.sort()).toEqual(['Amount', 'Card or Pass', 'Merchant', 'Name']);
      for (const name of Object.values(TRANSACTION_PROPERTY)) expect(fixture).toContain(`<string>${name}</string>`);
    });

    it('reads Notification properties, never Sender or Recipients', () => {
      const names = propertiesOf({ trigger: TRIGGER_IDENTIFIERS.notification });

      expect(names.sort()).toEqual(['App', 'Body', 'Date', 'Subtitle', 'Title']);
      expect(Object.values(NOTIFICATION_PROPERTY).sort()).toEqual(names);
      // A non-chat notification has neither, and reading a missing one aborts the step.
      expect(names).not.toContain('Sender');
      expect(names).not.toContain('Recipients');
    });

    it('does not read the Shortcut Input, which is not the same for the two triggers', () => {
      const inputs = attachmentsIn(actions).filter((record) => record.Type === 'ExtensionInput');

      expect(inputs).toEqual([]);
    });
  });

  describe('the event url', () => {
    const rewrite = byId(SHORTCUT_ACTIONS.replaceText).find(
      (action) => params(action)[SHORTCUT_PARAMS.replaceFind] === EVENT_URL_FIND,
    )!;

    it('replaces the last segment of the setup code url with `event`', () => {
      const pattern = new RegExp(params(rewrite)[SHORTCUT_PARAMS.replaceFind]);

      expect(params(rewrite)[SHORTCUT_PARAMS.replaceRegex]).toBe(true);
      expect(params(rewrite)[SHORTCUT_PARAMS.replaceWith]).toBe(EVENT_URL_REPLACE);
      expect('https://money.example.com/api/v1/ingest/card-payment'.replace(pattern, EVENT_URL_REPLACE)).toBe(
        'https://money.example.com/api/v1/ingest/event',
      );
    });

    it('is the url every request goes to', () => {
      for (const request of requests) {
        const attachment = Object.values(params(request)[SHORTCUT_PARAMS.url].Value.attachmentsByRange)[0] as Dict;

        expect(attachment.OutputUUID).toBe(params(rewrite).UUID);
      }
    });

    it('also decodes a setup code that carries a gate', () => {
      const code = encodeSetupCode({
        url: 'https://money.example.com/api/v1/ingest/card-payment',
        token: 'mm_ingest_secret',
        gate: AMOUNT_GATE_PATTERNS.strict,
      });
      const decoded = JSON.parse(Buffer.from(code.replace(/^v1\./, ''), 'base64').toString('utf8')) as Dict;
      const keys = byId(SHORTCUT_ACTIONS.getValue)
        .slice(0, 5)
        .map((action) => params(action)[SHORTCUT_PARAMS.dictionaryKey]);

      expect(keys).toEqual(['url', 'token', 'cfAccessId', 'cfAccessSecret', 'gate']);
      expect(decoded.gate).toBe(AMOUNT_GATE_PATTERNS.strict);
    });
  });

  describe('the gate', () => {
    const [standardGate] = byId(SHORTCUT_ACTIONS.text).filter(
      (action) => params(action)[SHORTCUT_PARAMS.textActionText] === AMOUNT_GATE_PATTERNS.standard,
    );
    const [match] = byId(SHORTCUT_ACTIONS.matchText);

    it('falls back to the standard pattern when the setup code has no gate', () => {
      const gateAction = byId(SHORTCUT_ACTIONS.getValue).find(
        (action) => params(action)[SHORTCUT_PARAMS.dictionaryKey] === 'gate',
      )!;
      const setVariables = byId(SHORTCUT_ACTIONS.setVariable).filter(
        (action) => params(action)[SHORTCUT_PARAMS.variableName] === 'Gate',
      );

      expect(standardGate).toBeDefined();
      expect(setVariables).toHaveLength(2);
      expect(params(setVariables[0]!)[SHORTCUT_PARAMS.input].Value.OutputUUID).toBe(params(gateAction).UUID);
      expect(params(setVariables[1]!)[SHORTCUT_PARAMS.input].Value.OutputUUID).toBe(params(standardGate!).UUID);
      // The If that picks between them tests the setup code's gate.
      const choice = actions[indexOfAction(setVariables[0]!) - 1]!;

      expect(params(choice)[SHORTCUT_PARAMS.condition]).toBe(CONDITION_CODES['Has Any Value']);
      expect(params(choice)[SHORTCUT_PARAMS.input].Variable.Value.OutputUUID).toBe(params(gateAction).UUID);
    });

    it('matches the pattern in the variable Gate against the title, subtitle and body', () => {
      expect(params(match!)[SHORTCUT_PARAMS.matchPattern].Value.attachmentsByRange['{0, 1}']).toEqual({
        Type: 'Variable',
        VariableName: 'Gate',
      });
      expect(params(match!)[SHORTCUT_PARAMS.matchCaseSensitive]).toBe(true);

      const text = actions.find(
        (action) =>
          params(action).UUID ===
          Object.values<Dict>(params(match!)[SHORTCUT_PARAMS.matchText].Value.attachmentsByRange)[0]!.OutputUUID,
      )!;
      const value = params(text)[SHORTCUT_PARAMS.textActionText];
      const names = Object.values<Dict>(value.Value.attachmentsByRange).map(
        (item) => item.Aggrandizements[0].PropertyName,
      );

      expect(value.Value.string).toBe('￼\n￼\n￼');
      expect(names).toEqual(['Title', 'Subtitle', 'Body']);
    });

    it('stops a text that asks for a one-time code, for every app, before anything is sent', () => {
      const index = indexOfAction(match!);
      const check = actions[index + 1]!;
      const securityMatch = actions[index + 2]!;
      const securityCheck = actions[index + 3]!;

      expect(id(check)).toBe(SHORTCUT_ACTIONS.conditional);
      expect(params(check)[SHORTCUT_PARAMS.condition]).toBe(CONDITION_CODES['Does Not Have Any Value']);
      expect(params(check)[SHORTCUT_PARAMS.input].Variable.Value.OutputUUID).toBe(params(match!).UUID);

      expect(id(securityMatch)).toBe(SHORTCUT_ACTIONS.matchText);
      expect(params(securityMatch)[SHORTCUT_PARAMS.matchPattern]).toBe(SECURITY_GATE_PATTERN);
      expect(params(securityCheck)[SHORTCUT_PARAMS.condition]).toBe(CONDITION_CODES['Has Any Value']);
      expect(params(securityCheck)[SHORTCUT_PARAMS.input].Variable.Value.OutputUUID).toBe(params(securityMatch).UUID);
      expect(id(actions[index + 4]!)).toBe(SHORTCUT_ACTIONS.exit);
      expect(index + 4).toBeLessThan(indexOfAction(notificationRequest!));
    });

    describe('a messaging or mail app without an amount', () => {
      const probe = () => probeRequest;

      it('checks the app name against the messaging and mail apps after the code check', () => {
        const appMatch = byId(SHORTCUT_ACTIONS.matchText).find(
          (action) => params(action)[SHORTCUT_PARAMS.matchPattern] === CONVERSATIONAL_APP_GATE_PATTERN,
        )!;
        const input = Object.values<Dict>(params(appMatch)[SHORTCUT_PARAMS.matchText].Value.attachmentsByRange)[0]!;

        expect(input.Aggrandizements[0].PropertyName).toBe('App');
        expect(indexOfAction(appMatch)).toBeGreaterThan(indexOfAction(byId(SHORTCUT_ACTIONS.matchText)[1]!));
        expect(indexOfAction(probe())).toBeGreaterThan(indexOfAction(appMatch));
      });

      it('sends only the app and the sender first, and never the text', () => {
        const body = JSON.stringify(params(probe())[SHORTCUT_PARAMS.jsonValues]);

        for (const key of ['kind', 'app', 'title']) expect(body).toContain(`"${key}"`);
        for (const key of ['subtitle', 'body', 'raw']) expect(body).not.toContain(`"${key}"`);
        expect(indexOfAction(probe())).toBeLessThan(indexOfAction(notificationRequest!));
      });

      it('stops unless the answer says to send', () => {
        const after = actions.slice(indexOfAction(probe()), indexOfAction(notificationRequest!));
        const sendKey = after.find(
          (action) =>
            id(action) === SHORTCUT_ACTIONS.getValue && params(action)[SHORTCUT_PARAMS.dictionaryKey] === 'send',
        )!;
        const check = after[after.indexOf(sendKey) + 1]!;

        expect(params(check)[SHORTCUT_PARAMS.condition]).toBe(CONDITION_CODES['Does Not Have Any Value']);
        expect(params(check)[SHORTCUT_PARAMS.input].Variable.Value.OutputUUID).toBe(params(sendKey).UUID);
        expect(id(after[after.indexOf(check) + 1]!)).toBe(SHORTCUT_ACTIONS.exit);
      });
    });

    it('reads the security pattern the way the server does', () => {
      const pattern = new RegExp(SECURITY_GATE_PATTERN, 'u');

      expect(pattern.test('Your code is 123456. Do not share it with anyone')).toBe(true);
      expect(pattern.test('Enter the code 482913 to confirm the login')).toBe(true);
      expect(pattern.test('Код 5521, никому не сообщайте')).toBe(true);
      expect(pattern.test('Purchase approved. Auth code 123456')).toBe(false);
      expect(pattern.test('Order confirmed! Urban Roastery has accepted your order')).toBe(false);
      expect(pattern.test('Do not share your card with anyone')).toBe(false);
    });

    it('has no other stop between the gate and the request than the code check and the probe', () => {
      const stops = actions
        .slice(indexOfAction(match!), indexOfAction(notificationRequest!))
        .filter((action) => id(action) === SHORTCUT_ACTIONS.exit);

      expect(stops).toHaveLength(2);
    });

    it('lets the shared samples through the same regex as the server does', () => {
      const pattern = new RegExp(params(standardGate!)[SHORTCUT_PARAMS.textActionText], AMOUNT_GATE_REGEX_FLAGS);

      for (const sample of AMOUNT_GATE_SAMPLES) {
        // `standard` takes every sample that needs `strict` or `standard`.
        const passes = sample.minLevel === 'strict' || sample.minLevel === 'standard';

        expect(pattern.test(sample.text), sample.text).toBe(passes);
      }
    });

    it('uses only Match Text and If: no Apple Intelligence action', () => {
      const identifiers = new Set(actions.map(id));
      const allowed = new Set<string>(Object.values(SHORTCUT_ACTIONS));

      for (const identifier of identifiers) {
        expect(allowed.has(identifier), identifier).toBe(true);
        expect(identifier).not.toMatch(/intelligence|askllm|generative|usemodel|summariz|rewrite/i);
      }
      expect(JSON.stringify(shortcut)).not.toMatch(/Apple Intelligence|UseModel|AskLLM/i);
    });

    it('is not applied to a Wallet tap', () => {
      expect(indexOfAction(match!)).toBeGreaterThan(indexOfAction(tapResend!));
    });
  });

  describe('our own output', () => {
    it('stops for the Shortcuts app and the MoneyMatter web app before Match Text', () => {
      const [match] = byId(SHORTCUT_ACTIONS.matchText);
      const checks = actions.filter(
        (action) =>
          id(action) === SHORTCUT_ACTIONS.conditional &&
          params(action)[SHORTCUT_PARAMS.conditionString] !== undefined &&
          params(action)[SHORTCUT_PARAMS.conditionString] !== BUSY_ERROR_CODE,
      );

      expect(checks.map((action) => params(action)[SHORTCUT_PARAMS.conditionString])).toEqual([
        OWN_APP_NAMES.shortcuts,
        OWN_APP_NAMES.moneymatter,
      ]);
      expect(checks.map((action) => params(action)[SHORTCUT_PARAMS.condition])).toEqual([
        CONDITION_CODES.Is,
        CONDITION_CODES.Contains,
      ]);

      for (const check of checks) {
        const index = indexOfAction(check);
        const subject = params(check)[SHORTCUT_PARAMS.input].Variable.Value;

        expect(subject.TriggerIdentifier).toBe(TRIGGER_IDENTIFIERS.notification);
        expect(subject.Aggrandizements[0].PropertyName).toBe('App');
        expect(id(actions[index + 1]!)).toBe(SHORTCUT_ACTIONS.exit);
        expect(index).toBeLessThan(indexOfAction(match!));
      }
    });
  });

  describe('the branches', () => {
    it('tells a tap from a notification by typed properties, not by the whole trigger variable', () => {
      const branching = actions.filter(
        (action) =>
          id(action) === SHORTCUT_ACTIONS.conditional &&
          params(action)[SHORTCUT_PARAMS.condition] === CONDITION_CODES['Has Any Value'] &&
          params(action)[SHORTCUT_PARAMS.input].Variable.Value.Type === 'TriggerOutput',
      );
      const subjects = branching.map((action) => {
        const subject = params(action)[SHORTCUT_PARAMS.input].Variable.Value;

        return [subject.TriggerIdentifier, subject.Aggrandizements[0].PropertyName];
      });

      expect(subjects).toEqual([
        [TRIGGER_IDENTIFIERS.wallet, 'Merchant'],
        [TRIGGER_IDENTIFIERS.notification, 'App'],
      ]);
    });

    it('sends a dry run when neither trigger fired', () => {
      const items = dictionaryItems(params(dryRunRequest!)[SHORTCUT_PARAMS.jsonValues]);

      expect(items.map(keyOf)).toEqual(['dryRun']);
      expect(items[0]!.WFValue.Value).toBe(true);
      expect(indexOfAction(dryRunRequest!)).toBeGreaterThan(indexOfAction(notificationResend!));
    });
  });

  describe('the requests', () => {
    it('are POST with JSON and carry the authorization and Cloudflare Access headers', () => {
      expect(requests).toHaveLength(5);

      for (const request of requests) {
        expect(params(request)[SHORTCUT_PARAMS.httpMethod]).toBe('POST');
        expect(params(request)[SHORTCUT_PARAMS.httpBodyType]).toBe('JSON');
        expect(dictionaryItems(params(request)[SHORTCUT_PARAMS.httpHeaders]).map(keyOf)).toEqual([
          'Authorization',
          'CF-Access-Client-Id',
          'CF-Access-Client-Secret',
        ]);
      }
    });

    it('send a walletTransaction with the payment keys, timed by the run', () => {
      const body = bodyOf(tapRequest!);

      expect(Object.keys(body).sort()).toEqual(
        [
          'amount',
          'card',
          'idempotencyKey',
          'kind',
          'merchant',
          'name',
          'source',
          'time',
          'timeSource',
          'timeZone',
        ].sort(),
      );
      expect(body.kind!.WFValue.Value.string).toBe('walletTransaction');
      // The Transaction has no date, so the run time goes with `timeSource: run`.
      expect(body.timeSource!.WFValue.Value.string).toBe('run');
      expect(INGEST_EVENT_KINDS).toContain('walletTransaction');

      const timeSource = Object.values<Dict>(body.time!.WFValue.Value.attachmentsByRange)[0]!;
      const timeAction = actions.find((action) => params(action).UUID === timeSource.OutputUUID)!;

      expect(id(timeAction)).toBe(SHORTCUT_ACTIONS.formatDate);
      expect(params(timeAction)[SHORTCUT_PARAMS.dateFormatStyle]).toBe('ISO 8601');
      expect(params(timeAction)[SHORTCUT_PARAMS.isoIncludeTime]).toBe(true);
    });

    it('send a notification with the text the device read, timed by the notification itself', () => {
      const body = bodyOf(notificationRequest!);

      expect(Object.keys(body).sort()).toEqual(
        ['app', 'body', 'idempotencyKey', 'kind', 'raw', 'source', 'subtitle', 'time', 'timeZone', 'title'].sort(),
      );
      expect(body.kind!.WFValue.Value.string).toBe('notification');
      // The notification carries its own date; there is no `timeSource` for it, so the server reads the time as its own.
      expect(body).not.toHaveProperty('timeSource');

      const timeSource = Object.values<Dict>(body.time!.WFValue.Value.attachmentsByRange)[0]!;
      const timeAction = actions.find((action) => params(action).UUID === timeSource.OutputUUID)!;
      const date = Object.values<Dict>(params(timeAction)[SHORTCUT_PARAMS.date].Value.attachmentsByRange)[0]!;

      expect(date.TriggerIdentifier).toBe(TRIGGER_IDENTIFIERS.notification);
      expect(date.Aggrandizements[0].PropertyName).toBe('Date');
      expect(params(timeAction)[SHORTCUT_PARAMS.dateFormatStyle]).toBe('ISO 8601');
    });

    it('send the IANA zone formatted with VV on both paths', () => {
      for (const request of [tapRequest!, notificationRequest!]) {
        const zone = Object.values<Dict>(bodyOf(request).timeZone!.WFValue.Value.attachmentsByRange)[0]!;
        const zoneAction = actions.find((action) => params(action).UUID === zone.OutputUUID)!;

        expect(id(zoneAction)).toBe(SHORTCUT_ACTIONS.formatDate);
        expect(params(zoneAction)[SHORTCUT_PARAMS.dateFormatStyle]).toBe('Custom');
        expect(params(zoneAction)[SHORTCUT_PARAMS.dateFormat]).toBe(TIME_ZONE_FORMAT);
      }
    });

    it('use only keys the server schema knows', () => {
      const known = new Set<string>([...CARD_PAYMENT_REQUEST_KEYS, ...NOTIFICATION_REQUEST_KEYS]);

      for (const request of requests) {
        for (const key of Object.keys(bodyOf(request))) expect(known.has(key), key).toBe(true);
      }
    });

    it('send every notification field the device exposes, so nothing of the text is lost', () => {
      const body = bodyOf(notificationRequest!);
      const names = (key: string) =>
        Object.values<Dict>(body[key]!.WFValue.Value.attachmentsByRange).map(
          (item) => item.Aggrandizements?.[0]?.PropertyName ?? null,
        );

      expect(names('app')).toEqual(['App']);
      expect(names('title')).toEqual(['Title']);
      expect(names('subtitle')).toEqual(['Subtitle']);
      expect(names('body')).toEqual(['Body']);
      // `raw` is the whole variable, with no property.
      expect(names('raw')).toEqual([null]);
    });
  });

  describe('the idempotency key', () => {
    const hashes = byId(SHORTCUT_ACTIONS.hash);

    const keyParts = ({ hash }: { hash: Dict }) => {
      const text = actions.find(
        (action) => params(action).UUID === params(hash)[SHORTCUT_PARAMS.input].Value.OutputUUID,
      )!;
      const value = params(text)[SHORTCUT_PARAMS.textActionText];

      return { text, value, attachments: Object.values<Dict>(value.Value.attachmentsByRange) };
    };

    it('is a SHA-256 hash, one per kind, and is the idempotencyKey of its request', () => {
      expect(hashes).toHaveLength(2);

      [tapRequest, notificationRequest].forEach((request, position) => {
        const key = bodyOf(request!).idempotencyKey!;

        expect(params(hashes[position]!)[SHORTCUT_PARAMS.hashType]).toBe('SHA256');
        expect(Object.values<Dict>(key.WFValue.Value.attachmentsByRange)[0]!.OutputUUID).toBe(
          params(hashes[position]!).UUID,
        );
      });
    });

    it('includes the time to the second', () => {
      expect(KEY_TIME_FORMAT).toBe("yyyy-MM-dd'T'HH:mm:ssZZZZZ");

      const tap = keyParts({ hash: hashes[0]! });
      const last = tap.attachments[tap.attachments.length - 1]!;
      const timeAction = actions.find((action) => params(action).UUID === last.OutputUUID)!;

      expect(params(timeAction)[SHORTCUT_PARAMS.dateFormat]).toBe(KEY_TIME_FORMAT);
      expect(tap.value.Value.string).toBe('walletTransaction|￼|￼|￼|￼');

      // A notification keys on its own date, formatted to the second by ISO 8601 with time.
      const notification = keyParts({ hash: hashes[1]! });
      const notificationLast = notification.attachments[notification.attachments.length - 1]!;
      const notificationTime = actions.find((action) => params(action).UUID === notificationLast.OutputUUID)!;

      expect(params(notificationTime)[SHORTCUT_PARAMS.dateFormatStyle]).toBe('ISO 8601');
      expect(params(notificationTime)[SHORTCUT_PARAMS.isoIncludeTime]).toBe(true);
      expect(notification.value.Value.string).toBe('notification|￼|￼|￼|￼|￼');
    });
  });

  describe('the banner', () => {
    it('shows `summary`, falls back to `message` on an error and stays silent on neither', () => {
      const keys = byId(SHORTCUT_ACTIONS.getValue).map((action) => params(action)[SHORTCUT_PARAMS.dictionaryKey]);

      expect(keys.slice(-3)).toEqual(['response', 'summary', 'message']);

      const last = actions[actions.length - 1]!;
      const shown = byId(SHORTCUT_ACTIONS.notification).pop()!;

      // The notification is wrapped in an If on Summary having any value.
      expect(id(last)).toBe(SHORTCUT_ACTIONS.conditional);
      expect(params(last)[SHORTCUT_PARAMS.controlFlowMode]).toBe(2);
      expect(indexOfAction(shown)).toBe(actions.length - 2);
      expect(params(actions[actions.length - 3]!)[SHORTCUT_PARAMS.condition]).toBe(CONDITION_CODES['Has Any Value']);
      expect(params(shown)[SHORTCUT_PARAMS.notificationBody].Value.attachmentsByRange['{0, 1}']).toEqual({
        Type: 'Variable',
        VariableName: 'Summary',
      });
    });
  });

  describe('the 423 retry', () => {
    it.each([
      { name: 'a tap', first: tapRequest, again: tapResend },
      { name: 'a notification', first: notificationRequest, again: notificationResend },
    ])('waits exactly once for $name and resends the same body and key', ({ first, again }) => {
      const between = actions.slice(indexOfAction(first!), indexOfAction(again!));
      const waits = between.filter((action) => id(action) === SHORTCUT_ACTIONS.wait);

      expect(waits).toHaveLength(1);
      expect(params(waits[0]!)[SHORTCUT_PARAMS.waitTime]).toBe(BUSY_RETRY_WAIT_SECONDS);
      expect(params(again!)[SHORTCUT_PARAMS.jsonValues]).toEqual(params(first!)[SHORTCUT_PARAMS.jsonValues]);
      expect(bodyOf(again!).idempotencyKey).toEqual(bodyOf(first!).idempotencyKey);
    });

    it('waits 20 seconds, and only on the base-currency error code', () => {
      expect(byId(SHORTCUT_ACTIONS.wait)).toHaveLength(2);
      expect(BUSY_RETRY_WAIT_SECONDS).toBe(20);
      expect(BUSY_ERROR_CODE).toBe(API_ERROR_CODES.baseCurrencyChangeInProgress);

      const checks = actions.filter((action) => params(action)[SHORTCUT_PARAMS.conditionString] === BUSY_ERROR_CODE);

      expect(checks).toHaveLength(2);
      for (const check of checks) expect(params(check)[SHORTCUT_PARAMS.condition]).toBe(CONDITION_CODES.Is);
    });

    it('shows the second answer, which carries the busy message when the change still runs', () => {
      // The answer is read from the variable Response after the retry, whichever request set it last.
      const setters = byId(SHORTCUT_ACTIONS.setVariable).filter(
        (action) => params(action)[SHORTCUT_PARAMS.variableName] === 'Response',
      );

      // The probe's answer is read at once, before the notification is sent.
      expect(setters).toHaveLength(6);
      expect(setters.map((action) => params(action)[SHORTCUT_PARAMS.input].Value.OutputUUID)).toEqual(
        allRequests.map((request) => params(request).UUID),
      );
    });
  });

  it('keeps the input classes of the captured shortcut', () => {
    const fixture = readFileSync(TRIGGERS_FIXTURE, 'utf8');
    const classes: string[] = shortcut.WFWorkflowInputContentItemClasses;

    expect(classes.length).toBeGreaterThan(0);
    for (const itemClass of classes) expect(fixture).toContain(`<string>${itemClass}</string>`);
  });
});
