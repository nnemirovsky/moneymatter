import { describe, expect, it } from '@jest/globals';
import * as helpers from '@tests/helpers';
import * as ingestHelpers from '@tests/helpers/ingest-tokens';

const TEST_AUTH_USER_ID = 'test-user-id';

describe('password reset revokes ingest tokens', () => {
  it("deletes every token of the user whose password was reset and leaves other users' tokens", async () => {
    await helpers.createIngestToken({ payload: { name: 'Phone' }, raw: true });
    await helpers.createIngestToken({ payload: { name: 'Laptop' }, raw: true });

    const other = await helpers.signUpSecondUser();
    const listOtherTokens = () =>
      helpers.asUser({ cookies: other.cookies, fn: () => helpers.listIngestTokens({ raw: true }) });
    await helpers.asUser({
      cookies: other.cookies,
      fn: () => helpers.createIngestToken({ payload: { name: 'Other' }, raw: true }),
    });

    expect(await helpers.listIngestTokens({ raw: true })).toHaveLength(2);

    const res = await helpers.resetPasswordForTests({ authUserId: TEST_AUTH_USER_ID });

    expect(res.status).toBe(200);
    expect(await helpers.listIngestTokens({ raw: true })).toEqual([]);
    expect(await listOtherTokens()).toHaveLength(1);
  });

  it('answers 401 to a token whose owner reset their password', async () => {
    const { secret } = await ingestHelpers.createTestIngestToken();
    await helpers.resetPasswordForTests({ authUserId: TEST_AUTH_USER_ID });

    const res = await ingestHelpers.requestWithoutSession({
      method: 'post',
      url: '/ingest/card-payment',
      headers: ingestHelpers.bearer({ secret }),
      body: { amount: 10, merchant: 'Test', card: 'Test card', idempotencyKey: 'test-key-0001' },
    });

    expect(res.status).toBe(401);
  });
});
