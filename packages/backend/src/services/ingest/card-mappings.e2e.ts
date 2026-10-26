import { ACCOUNT_STATUSES, API_ERROR_CODES } from '@bt/shared/types';
import { decryptToken } from '@common/utils/encryption';
import { beforeEach, describe, expect, it } from '@jest/globals';
import IngestSettings from '@models/ingest-settings.model';
import { RateLimitService } from '@services/common/rate-limit.service';
import * as helpers from '@tests/helpers';
import type { ErrorResponse } from '@tests/helpers/common';

const CARD_LABEL_MAX_LENGTH = 100;

const errorCode = ({ response }: { response: { body: unknown } }) =>
  ((response.body as { response: ErrorResponse }).response ?? {}).code;

/** An account owned by the second user. Must run inside `asUser`, which supplies that user's session. */
const createSecondUserAccount = async () => {
  await helpers.setBaseCurrencyForActiveUser({ currencyCode: global.BASE_CURRENCY.code });
  const account = await helpers.createAccount({ raw: true });
  expect(account.id).toEqual(expect.any(String));

  return account;
};

/** The owner's Example card: a GEL and a USD account, and the base-currency account as its default. */
const createCurrencyAccounts = async () => {
  await helpers.addUserCurrencies({ currencyCodes: ['GEL', 'USD'] });
  const base = await helpers.createAccount({ payload: helpers.buildAccountPayload({ name: 'Base' }), raw: true });
  const gel = await helpers.createAccount({
    payload: helpers.buildAccountPayload({ name: 'GEL', currencyCode: 'GEL' }),
    raw: true,
  });
  const usd = await helpers.createAccount({
    payload: helpers.buildAccountPayload({ name: 'USD', currencyCode: 'USD' }),
    raw: true,
  });

  return { base, gel, usd };
};

describe('Card links', () => {
  describe('GET /user/settings/card-mappings', () => {
    it('is empty for a fresh user', async () => {
      expect(await helpers.listCardMappings({ raw: true })).toEqual([]);
    });

    it("does not list another user's links", async () => {
      const account = await helpers.createAccount({ raw: true });
      await helpers.createCardMapping({ payload: { cardLabel: 'Example Visa', accountId: account.id }, raw: true });
      const other = await helpers.signUpSecondUser();

      const otherList = await helpers.asUser({
        cookies: other.cookies,
        fn: () => helpers.listCardMappings({ raw: true }),
      });

      expect(otherList).toEqual([]);
    });

    it('lists the links ordered by their normalized label', async () => {
      const account = await helpers.createAccount({ raw: true });
      await helpers.createCardMapping({ payload: { cardLabel: 'Zeta', accountId: account.id }, raw: true });
      await helpers.createCardMapping({ payload: { cardLabel: 'alpha', accountId: account.id }, raw: true });

      const labels = (await helpers.listCardMappings({ raw: true })).map((mapping) => mapping.cardLabel);

      expect(labels).toEqual(['alpha', 'Zeta']);
    });
  });

  describe('POST /user/settings/card-mappings', () => {
    it('creates a link and lists it with the label as typed', async () => {
      const account = await helpers.createAccount({ raw: true });

      const response = await helpers.createCardMapping({
        payload: { cardLabel: '  Example Visa  ', accountId: account.id },
      });

      expect(response.statusCode).toBe(201);
      expect(response.body.response).toEqual({
        id: expect.any(String),
        cardLabel: 'Example Visa',
        lastDigits: null,
        currencyCode: null,
        accountId: account.id,
        createdAt: expect.any(String),
      });
      expect(await helpers.listCardMappings({ raw: true })).toEqual([response.body.response]);
    });

    it('answers 409 for a label that normalizes to an existing one', async () => {
      const account = await helpers.createAccount({ raw: true });
      await helpers.createCardMapping({ payload: { cardLabel: 'Example Visa', accountId: account.id }, raw: true });

      const duplicate = await helpers.createCardMapping({
        payload: { cardLabel: '  example   VISA •••• 1234', accountId: account.id },
      });

      expect(duplicate.statusCode).toBe(409);
      expect(errorCode({ response: duplicate })).toBe(API_ERROR_CODES.conflict);
      expect(await helpers.listCardMappings({ raw: true })).toHaveLength(1);
    });

    it('lets two users link the same card name', async () => {
      const account = await helpers.createAccount({ raw: true });
      await helpers.createCardMapping({ payload: { cardLabel: 'Example Visa', accountId: account.id }, raw: true });
      const other = await helpers.signUpSecondUser();

      const created = await helpers.asUser({
        cookies: other.cookies,
        fn: async () => {
          const otherAccount = await createSecondUserAccount();
          return helpers.createCardMapping({ payload: { cardLabel: 'Example Visa', accountId: otherAccount.id } });
        },
      });

      expect(created.statusCode).toBe(201);
    });

    it("answers 422 for another user's account and leaves nothing behind", async () => {
      const other = await helpers.signUpSecondUser();
      const foreignAccount = await helpers.asUser({ cookies: other.cookies, fn: createSecondUserAccount });

      const response = await helpers.createCardMapping({
        payload: { cardLabel: 'Example Visa', accountId: foreignAccount.id },
      });

      expect(response.statusCode).toBe(422);
      expect(errorCode({ response })).toBe(API_ERROR_CODES.validationError);
      expect(await helpers.listCardMappings({ raw: true })).toEqual([]);
    });

    it('answers 422 for an account that does not exist', async () => {
      const response = await helpers.createCardMapping({
        payload: { cardLabel: 'Example Visa', accountId: '0192f0c2-0000-7000-8000-000000000000' },
      });

      expect(response.statusCode).toBe(422);
    });

    it('answers 422 for an archived account', async () => {
      const account = await helpers.createAccount({ raw: true });
      await helpers.updateAccount({ id: account.id, payload: { status: ACCOUNT_STATUSES.archived } });

      const response = await helpers.createCardMapping({
        payload: { cardLabel: 'Example Visa', accountId: account.id },
      });

      expect(response.statusCode).toBe(422);
      expect(await helpers.listCardMappings({ raw: true })).toEqual([]);
    });

    it('answers 422 for a loan account', async () => {
      const loan = await helpers.createLoan({
        payload: helpers.buildCreateLoanPayload({ currencyCode: global.BASE_CURRENCY_CODE }),
        raw: true,
      });

      const response = await helpers.createCardMapping({ payload: { cardLabel: 'Example Visa', accountId: loan.id } });

      expect(response.statusCode).toBe(422);
      expect(await helpers.listCardMappings({ raw: true })).toEqual([]);
    });

    it.each([
      ['a blank label', { cardLabel: '   ' }],
      ['a label over the limit', { cardLabel: 'x'.repeat(CARD_LABEL_MAX_LENGTH + 1) }],
      ['a missing label', {}],
      ['a malformed account id', { cardLabel: 'Example Visa', accountId: 'not-an-id' }],
    ])('answers 422 for %s', async (_name, overrides) => {
      const account = await helpers.createAccount({ raw: true });

      const response = await helpers.createCardMapping({ payload: { accountId: account.id, ...overrides } });

      expect(response.statusCode).toBe(422);
    });
  });

  describe('one card in several currencies', () => {
    it('holds a default row and one row per currency under one label', async () => {
      const { base, gel, usd } = await createCurrencyAccounts();

      const fallback = await helpers.createCardMapping({
        payload: { cardLabel: 'Example Visa', accountId: base.id },
        raw: true,
      });
      const gelRow = await helpers.createCardMapping({
        payload: { cardLabel: 'Example Visa', accountId: gel.id, currencyCode: 'GEL' },
        raw: true,
      });
      const usdRow = await helpers.createCardMapping({
        payload: { cardLabel: 'example visa', accountId: usd.id, currencyCode: 'usd' },
        raw: true,
      });

      expect(fallback).toMatchObject({ currencyCode: null, accountId: base.id });
      expect(gelRow).toMatchObject({ currencyCode: 'GEL', accountId: gel.id, cardLabel: 'Example Visa' });
      // A row joins the card as it is spelled: the case of the first label wins.
      expect(usdRow).toMatchObject({ currencyCode: 'USD', accountId: usd.id, cardLabel: 'Example Visa' });
      expect((await helpers.listCardMappings({ raw: true })).map((row) => row.currencyCode)).toEqual([
        null,
        'GEL',
        'USD',
      ]);
    });

    it('answers 409 for a second row of the same card and currency, and for a second default', async () => {
      const { base, gel } = await createCurrencyAccounts();
      await helpers.createCardMapping({ payload: { cardLabel: 'Example Visa', accountId: base.id }, raw: true });
      await helpers.createCardMapping({
        payload: { cardLabel: 'Example Visa', accountId: gel.id, currencyCode: 'GEL' },
        raw: true,
      });

      const secondGel = await helpers.createCardMapping({
        payload: { cardLabel: ' Example  visa •••• 1234', accountId: gel.id, currencyCode: 'GEL' },
      });
      const secondDefault = await helpers.createCardMapping({
        payload: { cardLabel: 'Example Visa', accountId: base.id },
      });

      expect(secondGel.statusCode).toBe(409);
      expect(secondDefault.statusCode).toBe(409);
      expect(await helpers.listCardMappings({ raw: true })).toHaveLength(2);
    });

    it('keeps the cards of two labels apart', async () => {
      const { base, gel } = await createCurrencyAccounts();

      const created = await Promise.all(
        [
          { cardLabel: 'Example Visa', accountId: gel.id, currencyCode: 'GEL' },
          { cardLabel: 'Revolut', accountId: gel.id, currencyCode: 'GEL' },
          { cardLabel: 'Revolut', accountId: base.id },
        ].map((payload) => helpers.createCardMapping({ payload })),
      );

      expect(created.map((response) => response.statusCode)).toEqual([201, 201, 201]);
    });

    it('answers 422 for a currency row whose account is in another currency', async () => {
      const { gel } = await createCurrencyAccounts();

      const response = await helpers.createCardMapping({
        payload: { cardLabel: 'Example Visa', accountId: gel.id, currencyCode: 'USD' },
      });

      expect(response.statusCode).toBe(422);
      expect(await helpers.listCardMappings({ raw: true })).toEqual([]);
    });

    it('lets the default row point at an account in any currency', async () => {
      const { usd } = await createCurrencyAccounts();

      const response = await helpers.createCardMapping({ payload: { cardLabel: 'Example Visa', accountId: usd.id } });

      expect(response.statusCode).toBe(201);
    });

    it.each([
      ['a code that is not shaped like one', 'us dollars'],
      ['an empty code', ''],
    ])('answers 422 for %s', async (_name, currencyCode) => {
      const { usd } = await createCurrencyAccounts();

      const response = await helpers.createCardMapping({
        payload: { cardLabel: 'Example Visa', accountId: usd.id, currencyCode },
      });

      expect(response.statusCode).toBe(422);
    });

    it('removes one currency and leaves the rest of the card', async () => {
      const { base, gel } = await createCurrencyAccounts();
      await helpers.createCardMapping({ payload: { cardLabel: 'Example Visa', accountId: base.id }, raw: true });
      const gelRow = await helpers.createCardMapping({
        payload: { cardLabel: 'Example Visa', accountId: gel.id, currencyCode: 'GEL' },
        raw: true,
      });

      expect((await helpers.deleteCardMapping({ id: gelRow.id })).statusCode).toBe(200);

      expect(await helpers.listCardMappings({ raw: true })).toEqual([
        expect.objectContaining({ currencyCode: null, accountId: base.id }),
      ]);
    });

    it('renames the whole card and keeps its currencies', async () => {
      const { base, gel } = await createCurrencyAccounts();
      const fallback = await helpers.createCardMapping({
        payload: { cardLabel: 'Example Visa', accountId: base.id },
        raw: true,
      });
      await helpers.createCardMapping({
        payload: { cardLabel: 'Example Visa', accountId: gel.id, currencyCode: 'GEL' },
        raw: true,
      });

      const renamed = await helpers.updateCardMapping({ id: fallback.id, payload: { cardLabel: 'Example Platinum' } });

      expect(renamed.statusCode).toBe(200);
      expect((await helpers.listCardMappings({ raw: true })).map((row) => row.cardLabel)).toEqual([
        'Example Platinum',
        'Example Platinum',
      ]);
    });

    it('answers 409 when renaming a card to the label of another card', async () => {
      const { base, gel } = await createCurrencyAccounts();
      const visa = await helpers.createCardMapping({
        payload: { cardLabel: 'Example Visa', accountId: gel.id, currencyCode: 'GEL' },
        raw: true,
      });
      await helpers.createCardMapping({ payload: { cardLabel: 'Revolut', accountId: base.id }, raw: true });

      const response = await helpers.updateCardMapping({ id: visa.id, payload: { cardLabel: 'revolut' } });

      expect(response.statusCode).toBe(409);
    });

    it('points a currency row only at an account in its currency', async () => {
      const { base, gel, usd } = await createCurrencyAccounts();
      const gelRow = await helpers.createCardMapping({
        payload: { cardLabel: 'Example Visa', accountId: gel.id, currencyCode: 'GEL' },
        raw: true,
      });

      const wrong = await helpers.updateCardMapping({ id: gelRow.id, payload: { accountId: usd.id } });
      const alsoWrong = await helpers.updateCardMapping({ id: gelRow.id, payload: { accountId: base.id } });

      expect(wrong.statusCode).toBe(422);
      expect(alsoWrong.statusCode).toBe(422);
      expect((await helpers.listCardMappings({ raw: true }))[0]!.accountId).toBe(gel.id);
    });

    it('cannot change the currency of a row', async () => {
      const { gel } = await createCurrencyAccounts();
      const gelRow = await helpers.createCardMapping({
        payload: { cardLabel: 'Example Visa', accountId: gel.id, currencyCode: 'GEL' },
        raw: true,
      });

      const response = await helpers.updateCardMapping({ id: gelRow.id, payload: { currencyCode: 'USD' } });

      expect(response.statusCode).toBe(422);
      expect((await helpers.listCardMappings({ raw: true }))[0]!.currencyCode).toBe('GEL');
    });
  });

  describe('the last digits of a card', () => {
    it('stores the digits on a new link and answers with them', async () => {
      const account = await helpers.createAccount({ raw: true });

      const created = await helpers.createCardMapping({
        payload: { cardLabel: 'Example Visa', accountId: account.id, lastDigits: ' 1234 ' },
        raw: true,
      });

      expect(created.lastDigits).toBe('1234');
      expect(await helpers.listCardMappings({ raw: true })).toEqual([created]);
    });

    it('sets and clears the digits of an existing link', async () => {
      const account = await helpers.createAccount({ raw: true });
      const mapping = await helpers.createCardMapping({
        payload: { cardLabel: 'Example Visa', accountId: account.id },
        raw: true,
      });

      const set = await helpers.updateCardMapping({ id: mapping.id, payload: { lastDigits: '5678' }, raw: true });
      const cleared = await helpers.updateCardMapping({ id: mapping.id, payload: { lastDigits: null }, raw: true });

      expect(set.lastDigits).toBe('5678');
      expect(cleared.lastDigits).toBeNull();
    });

    it('shares the digits between the rows of one card', async () => {
      await helpers.addUserCurrencies({ currencyCodes: ['GEL'] });
      const base = await helpers.createAccount({ payload: helpers.buildAccountPayload({ name: 'Base' }), raw: true });
      const gel = await helpers.createAccount({
        payload: helpers.buildAccountPayload({ name: 'GEL', currencyCode: 'GEL' }),
        raw: true,
      });
      const fallback = await helpers.createCardMapping({
        payload: { cardLabel: 'Example Visa', accountId: base.id, lastDigits: '1234' },
        raw: true,
      });

      // The new row inherits the card's digits; a change on one row reaches both.
      const gelRow = await helpers.createCardMapping({
        payload: { cardLabel: 'Example Visa', accountId: gel.id, currencyCode: 'GEL' },
        raw: true,
      });
      await helpers.updateCardMapping({ id: fallback.id, payload: { lastDigits: '9999' }, raw: true });

      expect(gelRow.lastDigits).toBe('1234');
      expect((await helpers.listCardMappings({ raw: true })).map((row) => row.lastDigits)).toEqual(['9999', '9999']);
    });

    it('answers 409 when the digits belong to another card', async () => {
      const account = await helpers.createAccount({ raw: true });
      await helpers.createCardMapping({
        payload: { cardLabel: 'Example Visa', accountId: account.id, lastDigits: '1234' },
        raw: true,
      });
      const other = await helpers.createCardMapping({
        payload: { cardLabel: 'Revolut', accountId: account.id },
        raw: true,
      });

      const onCreate = await helpers.createCardMapping({
        payload: { cardLabel: 'Monobank', accountId: account.id, lastDigits: '1234' },
      });
      const onUpdate = await helpers.updateCardMapping({ id: other.id, payload: { lastDigits: '1234' } });

      expect(onCreate.statusCode).toBe(409);
      expect(onUpdate.statusCode).toBe(409);
      expect(await helpers.listCardMappings({ raw: true })).toHaveLength(2);
    });

    it('lets two users hold the same digits', async () => {
      const account = await helpers.createAccount({ raw: true });
      await helpers.createCardMapping({
        payload: { cardLabel: 'Example Visa', accountId: account.id, lastDigits: '1234' },
        raw: true,
      });
      const other = await helpers.signUpSecondUser();

      const created = await helpers.asUser({
        cookies: other.cookies,
        fn: async () => {
          const otherAccount = await createSecondUserAccount();
          return helpers.createCardMapping({
            payload: { cardLabel: 'Example Visa', accountId: otherAccount.id, lastDigits: '1234' },
          });
        },
      });

      expect(created.statusCode).toBe(201);
    });

    it.each([
      ['letters', 'abcd'],
      ['too few digits', '123'],
      ['too many digits', '123456789'],
      ['a masked number', '**** 1234'],
    ])('answers 422 for %s', async (_name, lastDigits) => {
      const account = await helpers.createAccount({ raw: true });

      const response = await helpers.createCardMapping({
        payload: { cardLabel: 'Example Visa', accountId: account.id, lastDigits },
      });

      expect(response.statusCode).toBe(422);
      expect(await helpers.listCardMappings({ raw: true })).toEqual([]);
    });
  });

  describe('PATCH /user/settings/card-mappings/:id', () => {
    it('renames the label and keeps the account', async () => {
      const account = await helpers.createAccount({ raw: true });
      const mapping = await helpers.createCardMapping({
        payload: { cardLabel: 'Example Visa', accountId: account.id },
        raw: true,
      });

      const response = await helpers.updateCardMapping({
        id: mapping.id,
        payload: { cardLabel: 'Example Mastercard' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body.response).toEqual({ ...mapping, cardLabel: 'Example Mastercard' });
    });

    it('lets a link change only the letter case of its own label', async () => {
      const account = await helpers.createAccount({ raw: true });
      const mapping = await helpers.createCardMapping({
        payload: { cardLabel: 'example visa', accountId: account.id },
        raw: true,
      });

      const response = await helpers.updateCardMapping({ id: mapping.id, payload: { cardLabel: 'Example Visa' } });

      expect(response.statusCode).toBe(200);
      expect(response.body.response.cardLabel).toBe('Example Visa');
    });

    it('points the link at another account', async () => {
      const first = await helpers.createAccount({ raw: true });
      const second = await helpers.createAccount({
        payload: helpers.buildAccountPayload({ name: 'Second' }),
        raw: true,
      });
      const mapping = await helpers.createCardMapping({
        payload: { cardLabel: 'Example Visa', accountId: first.id },
        raw: true,
      });

      const updated = await helpers.updateCardMapping({ id: mapping.id, payload: { accountId: second.id }, raw: true });

      expect(updated.accountId).toBe(second.id);
      expect(await helpers.listCardMappings({ raw: true })).toEqual([updated]);
    });

    it('answers 409 when the new label belongs to another link', async () => {
      const account = await helpers.createAccount({ raw: true });
      await helpers.createCardMapping({ payload: { cardLabel: 'Example Visa', accountId: account.id }, raw: true });
      const other = await helpers.createCardMapping({
        payload: { cardLabel: 'Monobank', accountId: account.id },
        raw: true,
      });

      const response = await helpers.updateCardMapping({ id: other.id, payload: { cardLabel: 'example visa' } });

      expect(response.statusCode).toBe(409);
      expect((await helpers.listCardMappings({ raw: true })).map((row) => row.cardLabel).toSorted()).toEqual([
        'Example Visa',
        'Monobank',
      ]);
    });

    it('answers 422 when the new account is archived', async () => {
      const first = await helpers.createAccount({ raw: true });
      const second = await helpers.createAccount({
        payload: helpers.buildAccountPayload({ name: 'Second' }),
        raw: true,
      });
      await helpers.updateAccount({ id: second.id, payload: { status: ACCOUNT_STATUSES.archived } });
      const mapping = await helpers.createCardMapping({
        payload: { cardLabel: 'Example Visa', accountId: first.id },
        raw: true,
      });

      const response = await helpers.updateCardMapping({ id: mapping.id, payload: { accountId: second.id } });

      expect(response.statusCode).toBe(422);
      expect((await helpers.listCardMappings({ raw: true }))[0]!.accountId).toBe(first.id);
    });

    it('answers 422 for a body with no fields', async () => {
      const account = await helpers.createAccount({ raw: true });
      const mapping = await helpers.createCardMapping({
        payload: { cardLabel: 'Example Visa', accountId: account.id },
        raw: true,
      });

      const response = await helpers.updateCardMapping({ id: mapping.id, payload: {} });

      expect(response.statusCode).toBe(422);
    });

    it("answers 404 for another user's link", async () => {
      const account = await helpers.createAccount({ raw: true });
      const mapping = await helpers.createCardMapping({
        payload: { cardLabel: 'Example Visa', accountId: account.id },
        raw: true,
      });
      const other = await helpers.signUpSecondUser();

      const response = await helpers.asUser({
        cookies: other.cookies,
        fn: () => helpers.updateCardMapping({ id: mapping.id, payload: { cardLabel: 'Hijacked' } }),
      });

      expect(response.statusCode).toBe(404);
      expect((await helpers.listCardMappings({ raw: true }))[0]!.cardLabel).toBe('Example Visa');
    });
  });

  describe('DELETE /user/settings/card-mappings/:id', () => {
    it('removes the link and answers 404 the second time', async () => {
      const account = await helpers.createAccount({ raw: true });
      const mapping = await helpers.createCardMapping({
        payload: { cardLabel: 'Example Visa', accountId: account.id },
        raw: true,
      });

      const first = await helpers.deleteCardMapping({ id: mapping.id });
      const second = await helpers.deleteCardMapping({ id: mapping.id });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(404);
      expect(await helpers.listCardMappings({ raw: true })).toEqual([]);
    });

    it("answers 404 for another user's link and keeps it", async () => {
      const account = await helpers.createAccount({ raw: true });
      const mapping = await helpers.createCardMapping({
        payload: { cardLabel: 'Example Visa', accountId: account.id },
        raw: true,
      });
      const other = await helpers.signUpSecondUser();

      const response = await helpers.asUser({
        cookies: other.cookies,
        fn: () => helpers.deleteCardMapping({ id: mapping.id }),
      });

      expect(response.statusCode).toBe(404);
      expect(await helpers.listCardMappings({ raw: true })).toHaveLength(1);
    });

    it('is implied by deleting the account: its links go with it', async () => {
      const kept = await helpers.createAccount({ raw: true });
      const removed = await helpers.createAccount({
        payload: helpers.buildAccountPayload({ name: 'Removed' }),
        raw: true,
      });
      await helpers.createCardMapping({ payload: { cardLabel: 'Kept', accountId: kept.id }, raw: true });
      await helpers.createCardMapping({ payload: { cardLabel: 'Removed', accountId: removed.id }, raw: true });

      await helpers.deleteAccount({ id: removed.id, raw: true });

      expect((await helpers.listCardMappings({ raw: true })).map((mapping) => mapping.cardLabel)).toEqual(['Kept']);
    });
  });
});

describe('Cloudflare Access headers', () => {
  const CLIENT_ID = 'abc123def456.access-a1b2';
  const CLIENT_SECRET = 'f00dfacecafebeef0123456789abcdef0123456789abcdef0123456789abcdef';

  beforeEach(async () => {
    const { id } = await helpers.getUserInfo({ raw: true });
    await RateLimitService.resetRateLimit(`ingest-settings-write:user:${id}`);
  });

  it('reports not configured for a fresh user', async () => {
    expect(await helpers.getAccessHeaders({ raw: true })).toEqual({ configured: false, clientIdHint: null });
  });

  it('stores the pair and answers with a hint, never the secret', async () => {
    const put = await helpers.setAccessHeaders({ payload: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET } });
    const get = await helpers.getAccessHeaders();

    expect(put.statusCode).toBe(200);
    expect(put.body.response).toEqual({ configured: true, clientIdHint: '…a1b2' });
    expect(get.statusCode).toBe(200);
    expect(get.body.response).toEqual({ configured: true, clientIdHint: '…a1b2' });
    expect(JSON.stringify([put.body, get.body])).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify([put.body, get.body])).not.toContain(CLIENT_ID);
  });

  it('keeps both values encrypted at rest', async () => {
    await helpers.setAccessHeaders({ payload: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }, raw: true });
    const { id } = await helpers.getUserInfo({ raw: true });

    const stored = await IngestSettings.findByPk(id);

    expect(stored!.accessClientIdEnc).not.toContain(CLIENT_ID);
    expect(stored!.accessClientSecretEnc).not.toContain(CLIENT_SECRET);
    expect(decryptToken(stored!.accessClientIdEnc!)).toBe(CLIENT_ID);
    expect(decryptToken(stored!.accessClientSecretEnc!)).toBe(CLIENT_SECRET);
  });

  it('replaces a stored pair', async () => {
    await helpers.setAccessHeaders({ payload: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }, raw: true });

    const replaced = await helpers.setAccessHeaders({
      payload: { clientId: 'other.access-zz99', clientSecret: 'another-secret' },
      raw: true,
    });

    expect(replaced).toEqual({ configured: true, clientIdHint: '…zz99' });
    expect(await helpers.getAccessHeaders({ raw: true })).toEqual(replaced);
  });

  it('clears the pair when both values are null', async () => {
    await helpers.setAccessHeaders({ payload: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }, raw: true });

    const cleared = await helpers.setAccessHeaders({ payload: { clientId: null, clientSecret: null }, raw: true });

    expect(cleared).toEqual({ configured: false, clientIdHint: null });
    expect(await helpers.getAccessHeaders({ raw: true })).toEqual({ configured: false, clientIdHint: null });
  });

  it('answers 422 for one value without the other and keeps the stored pair', async () => {
    await helpers.setAccessHeaders({ payload: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }, raw: true });

    const onlyId = await helpers.setAccessHeaders({ payload: { clientId: 'x.access', clientSecret: null } });
    const onlySecret = await helpers.setAccessHeaders({ payload: { clientId: null, clientSecret: 'secret' } });

    expect(onlyId.statusCode).toBe(422);
    expect(onlySecret.statusCode).toBe(422);
    expect(await helpers.getAccessHeaders({ raw: true })).toEqual({ configured: true, clientIdHint: '…a1b2' });
  });

  it.each([
    ['blank values', { clientId: '  ', clientSecret: ' ' }],
    ['missing fields', {}],
    ['an oversized value', { clientId: 'x'.repeat(256), clientSecret: 'secret' }],
  ])('answers 422 for %s', async (_name, payload) => {
    const response = await helpers.setAccessHeaders({ payload });

    expect(response.statusCode).toBe(422);
    expect(await helpers.getAccessHeaders({ raw: true })).toEqual({ configured: false, clientIdHint: null });
  });

  it("does not show one user's headers to another", async () => {
    await helpers.setAccessHeaders({ payload: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }, raw: true });
    const other = await helpers.signUpSecondUser();

    const otherStatus = await helpers.asUser({
      cookies: other.cookies,
      fn: () => helpers.getAccessHeaders({ raw: true }),
    });

    expect(otherStatus).toEqual({ configured: false, clientIdHint: null });
  });
});
