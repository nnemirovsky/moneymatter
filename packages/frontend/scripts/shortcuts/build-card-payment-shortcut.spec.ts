import { API_ERROR_CODES, CARD_PAYMENT_REQUEST_KEYS, encodeSetupCode } from '@bt/shared/types';
// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { KEY_TIME_FORMAT, buildCardPaymentShortcut, renderCardPaymentShortcutXml } from './build-card-payment-shortcut';
import {
  BUSY_ERROR_CODE,
  BUSY_RETRY_WAIT_SECONDS,
  CONDITION_CODES,
  SHORTCUT_ACTIONS,
  SHORTCUT_PARAMS,
} from './shortcut-plist';

type Dict = Record<string, any>;

const COMMITTED_XML = fileURLToPath(new URL('../../shortcuts/log-card-payment.plist', import.meta.url));
const FIXTURE_XML = fileURLToPath(new URL('./fixtures/transaction-input.xml', import.meta.url));

const shortcut = buildCardPaymentShortcut() as Dict;
const actions: Dict[] = shortcut.WFWorkflowActions;
const id = (action: Dict): string => action.WFWorkflowActionIdentifier;
const params = (action: Dict): Dict => action.WFWorkflowActionParameters;
const byId = (identifier: string): Dict[] => actions.filter((action) => id(action) === identifier);

/** The attachments of a `WFTextTokenString`, ordered by the position of their placeholder in the text. */
const tokenAttachments = (value: Dict): Dict[] => {
  const ranges = value.Value.attachmentsByRange as Dict;

  return Object.keys(ranges)
    .sort((a, b) => Number(/\{(\d+)/.exec(a)![1]) - Number(/\{(\d+)/.exec(b)![1]))
    .map((key) => ranges[key]);
};

const dictionaryItems = (value: Dict): Dict[] => value.Value.WFDictionaryFieldValueItems;
const keyOf = (item: Dict): string => item.WFKey.Value.string;

describe('card-payment shortcut generator', () => {
  it('has exactly one import question, bound to the first Text action', () => {
    const questions: Dict[] = shortcut.WFWorkflowImportQuestions;

    expect(questions).toHaveLength(1);
    expect(questions[0]!.ActionIndex).toBe(0);
    expect(questions[0]!.ParameterKey).toBe(SHORTCUT_PARAMS.textActionText);
    expect(id(actions[0]!)).toBe(SHORTCUT_ACTIONS.text);
    expect(params(actions[0]!)).toHaveProperty(SHORTCUT_PARAMS.textActionText);
  });

  it('uses the input classes of the captured Wallet transaction shortcut', () => {
    const fixture = readFileSync(FIXTURE_XML, 'utf8');
    const classes: string[] = shortcut.WFWorkflowInputContentItemClasses;

    expect(classes.length).toBeGreaterThan(0);
    for (const itemClass of classes) expect(fixture).toContain(`<string>${itemClass}</string>`);
  });

  it('orders the setup actions as in the plan', () => {
    expect(actions.slice(0, 9).map(id)).toEqual([
      SHORTCUT_ACTIONS.text,
      SHORTCUT_ACTIONS.replaceText,
      SHORTCUT_ACTIONS.base64,
      SHORTCUT_ACTIONS.detectText,
      SHORTCUT_ACTIONS.detectDictionary,
      SHORTCUT_ACTIONS.getValue,
      SHORTCUT_ACTIONS.getValue,
      SHORTCUT_ACTIONS.getValue,
      SHORTCUT_ACTIONS.getValue,
    ]);
    // Three setup guards (code, url, token) come before the payment branch.
    const guard = [
      SHORTCUT_ACTIONS.conditional,
      SHORTCUT_ACTIONS.notification,
      SHORTCUT_ACTIONS.exit,
      SHORTCUT_ACTIONS.conditional,
    ];
    expect(actions.slice(9, 21).map(id)).toEqual([...guard, ...guard, ...guard]);
    expect(actions[21] && id(actions[21])).toBe(SHORTCUT_ACTIONS.conditional);
    expect(byId(SHORTCUT_ACTIONS.notification)).toHaveLength(4);
    expect(id(actions[actions.length - 1]!)).toBe(SHORTCUT_ACTIONS.notification);
  });

  it('reads the property names the Wallet transaction input exposes', () => {
    const fixture = readFileSync(FIXTURE_XML, 'utf8');
    const names = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === 'object') {
        const record = node as Dict;
        if (record.Type === 'ExtensionInput' && record.Aggrandizements) {
          for (const aggrandizement of record.Aggrandizements) names.add(aggrandizement.PropertyName);
        }
        Object.values(record).forEach(walk);
      }
    };
    walk(actions);

    expect([...names].sort()).toEqual(['Amount', 'Card or Pass', 'Merchant', 'Name']);
    for (const name of names) expect(fixture).toContain(`<string>${name}</string>`);
  });

  describe('the request', () => {
    const requests = byId(SHORTCUT_ACTIONS.downloadUrl);
    // The payment, its single resend after a 423, then the dry run.
    const paymentRequest = requests[0];
    const dryRunRequest = requests[2];

    it('has one request per branch plus the resend, all POST with JSON', () => {
      expect(requests).toHaveLength(3);
      for (const request of requests) {
        expect(params(request)[SHORTCUT_PARAMS.httpMethod]).toBe('POST');
        expect(params(request)[SHORTCUT_PARAMS.httpBodyType]).toBe('JSON');
      }
    });

    it('sends keys the server schema knows, with the payment keys it needs', () => {
      const keys = dictionaryItems(params(paymentRequest!)[SHORTCUT_PARAMS.jsonValues]).map(keyOf);

      for (const key of keys) expect(CARD_PAYMENT_REQUEST_KEYS).toContain(key);
      expect(keys.sort()).toEqual(['amount', 'card', 'idempotencyKey', 'merchant', 'name', 'source', 'time']);
    });

    it('sends the authorization and Cloudflare Access headers', () => {
      for (const request of requests) {
        const keys = dictionaryItems(params(request)[SHORTCUT_PARAMS.httpHeaders]).map(keyOf);

        expect(keys).toEqual(['Authorization', 'CF-Access-Client-Id', 'CF-Access-Client-Secret']);
      }
    });

    it('sends only dryRun: true when the shortcut has no input', () => {
      const items = dictionaryItems(params(dryRunRequest!)[SHORTCUT_PARAMS.jsonValues]);

      expect(items.map(keyOf)).toEqual(['dryRun']);
      expect(items[0]!.WFValue.Value).toBe(true);
      for (const key of items.map(keyOf)) expect(CARD_PAYMENT_REQUEST_KEYS).toContain(key);
    });

    it('sends the payment time with its time of day and offset', () => {
      const isoAction = actions.find((action) => params(action)[SHORTCUT_PARAMS.dateFormatStyle] === 'ISO 8601')!;

      expect(params(isoAction)[SHORTCUT_PARAMS.isoIncludeTime]).toBe(true);

      const time = dictionaryItems(params(paymentRequest!)[SHORTCUT_PARAMS.jsonValues]).find(
        (entry) => keyOf(entry) === 'time',
      )!;
      expect(tokenAttachments(time.WFValue)[0]!.OutputUUID).toBe(params(isoAction).UUID);
    });

    it('binds the date of both Format Date actions as a text token on the current date', () => {
      const formatActions = byId(SHORTCUT_ACTIONS.formatDate);
      const [now] = byId(SHORTCUT_ACTIONS.currentDate);

      expect(formatActions).toHaveLength(2);
      for (const action of formatActions) {
        const date = params(action)[SHORTCUT_PARAMS.date];

        expect(date.WFSerializationType).toBe('WFTextTokenString');
        expect(date.Value.string).toBe('\uFFFC');
        expect(Object.keys(date.Value.attachmentsByRange)).toEqual(['{0, 1}']);
        expect(tokenAttachments(date)[0]!.OutputUUID).toBe(params(now!).UUID);
      }
    });

    it('encodes both If conditions as the numbers Shortcuts stores', () => {
      const conditions = byId(SHORTCUT_ACTIONS.conditional)
        .map((action) => params(action)[SHORTCUT_PARAMS.condition])
        .filter((value) => value !== undefined);

      expect(CONDITION_CODES).toEqual({ Is: 4, Contains: 99, 'Has Any Value': 100, 'Does Not Have Any Value': 101 });
      // Three setup guards, the input check, the 423 check (Is) and the summary fallback.
      expect(conditions).toEqual([101, 101, 101, 100, 4, 101]);
    });

    it('guards the payment branch with a has-any-value check on the shortcut input', () => {
      const conditional = actions[21]!;

      expect(params(conditional)[SHORTCUT_PARAMS.controlFlowMode]).toBe(0);
      expect(params(conditional)[SHORTCUT_PARAMS.condition]).toBe(100);
      expect(params(conditional)[SHORTCUT_PARAMS.input].Variable.Value.Type).toBe('ExtensionInput');
    });
  });

  describe('the setup-code decode chain', () => {
    const replace = byId(SHORTCUT_ACTIONS.replaceText)[0]!;
    const getValues = byId(SHORTCUT_ACTIONS.getValue).slice(0, 4);

    it('runs between the Text action and Base64 Decode, as a regex replace of ^v1.', () => {
      expect(actions.indexOf(replace)).toBe(1);
      expect(params(replace)[SHORTCUT_PARAMS.replaceFind]).toBe('^v1\\.');
      expect(params(replace)[SHORTCUT_PARAMS.replaceWith]).toBe('');
      expect(params(replace)[SHORTCUT_PARAMS.replaceRegex]).toBe(true);
      expect(params(actions[2]!)[SHORTCUT_PARAMS.encodeMode]).toBe('Decode');
    });

    const code = encodeSetupCode({
      url: 'https://money.example.com/api/v1/ingest/card-payment',
      token: 'mm_ingest_secret',
      cfAccessId: 'id.access',
      cfAccessSecret: 'cf-secret',
    });

    // Emulates the shortcut without the shared decoder: the Replace Text action's own pattern,
    // standard base64, JSON, then the keys the Get Dictionary Value actions name.
    const runChain = ({ withReplace }: { withReplace: boolean }): Record<string, unknown> => {
      const pattern = new RegExp(params(replace)[SHORTCUT_PARAMS.replaceFind]);
      const text = withReplace ? code.replace(pattern, params(replace)[SHORTCUT_PARAMS.replaceWith]) : code;
      const decoded = JSON.parse(Buffer.from(text, 'base64').toString('utf8')) as Dict;

      return Object.fromEntries(
        getValues.map((action) => [
          params(action)[SHORTCUT_PARAMS.dictionaryKey],
          decoded[params(action)[SHORTCUT_PARAMS.dictionaryKey]],
        ]),
      );
    };

    it('yields url, token and the Cloudflare Access pair', () => {
      expect(getValues.map((action) => params(action)[SHORTCUT_PARAMS.dictionaryKey])).toEqual([
        'url',
        'token',
        'cfAccessId',
        'cfAccessSecret',
      ]);
      expect(runChain({ withReplace: true })).toEqual({
        url: 'https://money.example.com/api/v1/ingest/card-payment',
        token: 'mm_ingest_secret',
        cfAccessId: 'id.access',
        cfAccessSecret: 'cf-secret',
      });
    });

    it('serializes each variable slot the way Shortcuts reads it', () => {
      const serialization = (identifier: string, key: string) =>
        byId(identifier).map((action) => params(action)[key].WFSerializationType);

      // Typed-into slots take a text token; variable-only slots take a bare attachment.
      expect(serialization(SHORTCUT_ACTIONS.replaceText, SHORTCUT_PARAMS.input)).toEqual(['WFTextTokenString']);
      expect(serialization(SHORTCUT_ACTIONS.formatDate, SHORTCUT_PARAMS.date)).toEqual([
        'WFTextTokenString',
        'WFTextTokenString',
      ]);
      expect(serialization(SHORTCUT_ACTIONS.base64, SHORTCUT_PARAMS.input)).toEqual(['WFTextTokenAttachment']);
      expect(serialization(SHORTCUT_ACTIONS.detectText, SHORTCUT_PARAMS.input)).toEqual(['WFTextTokenAttachment']);
      expect(serialization(SHORTCUT_ACTIONS.detectDictionary, SHORTCUT_PARAMS.input)).toEqual([
        'WFTextTokenAttachment',
      ]);
      expect(new Set(serialization(SHORTCUT_ACTIONS.getValue, SHORTCUT_PARAMS.input))).toEqual(
        new Set(['WFTextTokenAttachment']),
      );
      expect(serialization(SHORTCUT_ACTIONS.hash, SHORTCUT_PARAMS.input)).toEqual(['WFTextTokenAttachment']);
      expect(new Set(serialization(SHORTCUT_ACTIONS.setVariable, SHORTCUT_PARAMS.input))).toEqual(
        new Set(['WFTextTokenAttachment']),
      );
      expect(serialization(SHORTCUT_ACTIONS.downloadUrl, SHORTCUT_PARAMS.url)).toEqual(
        Array(3).fill('WFTextTokenString'),
      );
      expect(serialization(SHORTCUT_ACTIONS.notification, SHORTCUT_PARAMS.notificationBody)).toEqual(
        Array(4).fill('WFTextTokenString'),
      );
    });

    it('reads the decoded bytes as text before parsing them as a dictionary', () => {
      const [, , decode, text, dictionary] = actions;
      const reads = (action: Dict) => {
        const input = params(action)[SHORTCUT_PARAMS.input];

        return input.WFSerializationType === 'WFTextTokenString'
          ? tokenAttachments(input)[0]!.OutputUUID
          : input.Value.OutputUUID;
      };

      expect(actions.slice(1, 5).map(id)).toEqual([
        SHORTCUT_ACTIONS.replaceText,
        SHORTCUT_ACTIONS.base64,
        SHORTCUT_ACTIONS.detectText,
        SHORTCUT_ACTIONS.detectDictionary,
      ]);
      expect(reads(actions[1]!)).toBe(params(actions[0]!).UUID);
      expect(reads(decode!)).toBe(params(actions[1]!).UUID);
      expect(reads(text!)).toBe(params(decode!).UUID);
      expect(reads(dictionary!)).toBe(params(text!).UUID);
    });

    it('stops with a message that names what failed when the code, url or token is empty', () => {
      const guards = [actions[9]!, actions[13]!, actions[17]!];
      const [urlValue, tokenValue] = getValues;

      expect(guards.map((g) => params(g)[SHORTCUT_PARAMS.condition])).toEqual([101, 101, 101]);
      expect(guards.map((g) => params(g)[SHORTCUT_PARAMS.input].Variable.Value.OutputUUID)).toEqual([
        params(actions[0]!).UUID,
        params(urlValue!).UUID,
        params(tokenValue!).UUID,
      ]);

      const messages = [9, 13, 17].map(
        (index) => params(actions[index + 1]!)[SHORTCUT_PARAMS.notificationBody].Value.string,
      );
      expect(messages[0]).toContain('No MoneyMatter setup code was entered');
      expect(messages[1]).toContain('setup code could not be read');
      expect(messages[2]).toBe(messages[1]);

      for (const index of [9, 13, 17]) {
        expect(id(actions[index + 2]!)).toBe(SHORTCUT_ACTIONS.exit);
        // Each guard is closed before the next block starts.
        expect(params(actions[index + 3]!)[SHORTCUT_PARAMS.controlFlowMode]).toBe(2);
      }
      expect(params(actions[8]!)[SHORTCUT_PARAMS.dictionaryKey]).toBe('cfAccessSecret');
    });

    it('builds a code the strict iOS Base64 Decode accepts', () => {
      const payload = code.replace(new RegExp(params(replace)[SHORTCUT_PARAMS.replaceFind]), '');

      expect(code.startsWith('v1.')).toBe(true);
      // Standard base64 only (no URL-safe characters, no stray prefix characters), padded to a multiple of 4.
      expect(payload).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
      expect(payload.length % 4).toBe(0);
      // Node's decoder is lenient; a canonical round trip proves nothing was skipped.
      expect(Buffer.from(payload, 'base64').toString('base64')).toBe(payload);
    });

    it('fails without the Replace Text step, so the step is needed', () => {
      expect(() => runChain({ withReplace: false })).toThrow();
    });
  });

  describe('the idempotency key', () => {
    const hash = byId(SHORTCUT_ACTIONS.hash)[0]!;

    it('is a SHA-256 hash of a Text action joining card, merchant, amount and the key time', () => {
      expect(params(hash)[SHORTCUT_PARAMS.hashType]).toBe('SHA256');

      const sourceUuid = params(hash)[SHORTCUT_PARAMS.input].Value.OutputUUID;
      const text = actions.find((action) => params(action).UUID === sourceUuid)!;

      expect(id(text)).toBe(SHORTCUT_ACTIONS.text);

      const value = params(text)[SHORTCUT_PARAMS.textActionText];
      expect(value.Value.string).toBe('￼|￼|￼|￼');

      const [card, merchant, amount, time] = tokenAttachments(value);
      expect(card!.Aggrandizements[0].PropertyName).toBe('Card or Pass');
      expect(merchant!.Aggrandizements[0].PropertyName).toBe('Merchant');
      expect(amount!.Aggrandizements[0].PropertyName).toBe('Amount');
      expect(time!.Type).toBe('ActionOutput');

      const timeAction = actions.find((action) => params(action).UUID === time!.OutputUUID)!;
      expect(id(timeAction)).toBe(SHORTCUT_ACTIONS.formatDate);
      // To the second, so two identical taps inside one minute are not one request.
      expect(params(timeAction)[SHORTCUT_PARAMS.dateFormat]).toBe("yyyy-MM-dd'T'HH:mm:ssZZZZZ");
      expect(KEY_TIME_FORMAT).toContain(':ss');
    });

    it('is the idempotencyKey of the request body', () => {
      const item = dictionaryItems(params(byId(SHORTCUT_ACTIONS.downloadUrl)[0]!)[SHORTCUT_PARAMS.jsonValues]).find(
        (entry) => keyOf(entry) === 'idempotencyKey',
      )!;

      expect(tokenAttachments(item.WFValue)[0]!.OutputUUID).toBe(params(hash).UUID);
    });
  });

  describe('the 423 retry', () => {
    const [paymentRequest, resendRequest] = byId(SHORTCUT_ACTIONS.downloadUrl);
    const body = (request: Dict) => params(request)[SHORTCUT_PARAMS.jsonValues];

    it('waits once and sends the same body again when a base-currency change answers', () => {
      const waits = byId(SHORTCUT_ACTIONS.wait);
      const paymentIndex = actions.indexOf(paymentRequest!);
      const resendIndex = actions.indexOf(resendRequest!);

      expect(waits).toHaveLength(1);
      expect(params(waits[0]!)[SHORTCUT_PARAMS.waitTime]).toBe(BUSY_RETRY_WAIT_SECONDS);
      expect(BUSY_RETRY_WAIT_SECONDS).toBe(20);
      expect(actions.indexOf(waits[0]!)).toBeGreaterThan(paymentIndex);
      expect(actions.indexOf(waits[0]!)).toBeLessThan(resendIndex);
      // Same body, so the same idempotency key.
      expect(body(resendRequest!)).toEqual(body(paymentRequest!));
    });

    it('only resends when the error code is the base-currency one', () => {
      const check = actions.find((action) => params(action)[SHORTCUT_PARAMS.condition] === CONDITION_CODES.Is)!;

      expect(params(check)[SHORTCUT_PARAMS.conditionString]).toBe(BUSY_ERROR_CODE);
      expect(BUSY_ERROR_CODE).toBe(API_ERROR_CODES.baseCurrencyChangeInProgress);
    });
  });

  it('names the iOS Automation page, not Apple Pay, in the text a user reads', () => {
    const texts = JSON.stringify(actions) + JSON.stringify(shortcut.WFWorkflowImportQuestions);

    expect(texts).toContain('iOS Automation');
    expect(texts).not.toContain('Apple Pay page');
  });

  it('is deterministic', () => {
    expect(renderCardPaymentShortcutXml()).toBe(renderCardPaymentShortcutXml());
  });

  it('matches the committed XML (run `npm run shortcuts:build` after a change)', () => {
    expect(readFileSync(COMMITTED_XML, 'utf8')).toBe(renderCardPaymentShortcutXml());
  });
});
