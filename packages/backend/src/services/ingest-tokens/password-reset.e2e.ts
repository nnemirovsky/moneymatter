import { describe, expect, it } from '@jest/globals';
import * as helpers from '@tests/helpers';
import * as ingestHelpers from '@tests/helpers/ingest-tokens';

const TEST_AUTH_USER_ID = 'test-user-id';

describe('password reset revokes ingest tokens', () => {
  it("deletes every token of the user whose password was reset and leaves other users' tokens", async () => {
    const owner = await helpers.getUserInfo({ raw: true });
    await ingestHelpers.createTestIngestToken({ name: 'Phone' });
    await ingestHelpers.createTestIngestToken({ name: 'Laptop' });

    const other = await helpers.signUpSecondUser();
    const otherApp = await helpers.findAppUserByEmail({ email: other.email });
    await ingestHelpers.createTestIngestToken({ userId: otherApp.id, name: 'Other' });

    expect(await ingestHelpers.countTestIngestTokens({ userId: owner.id })).toBe(2);

    const res = await helpers.resetPasswordForTests({ authUserId: TEST_AUTH_USER_ID });

    expect(res.status).toBe(200);
    expect(await ingestHelpers.countTestIngestTokens({ userId: owner.id })).toBe(0);
    expect(await ingestHelpers.countTestIngestTokens({ userId: otherApp.id })).toBe(1);
  });

  // The 401 on the ingest route needs Task 5's route; it passes once that exists.
  it.skip('answers 401 to a token whose owner reset their password (passes at Task 5)', async () => {
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
