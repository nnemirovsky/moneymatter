import { UserInfoResponse } from '@bt/shared/types';

import { makeAuthRequest, makeRequest } from './common';

/**
 * `GET /user` returns the authenticated user's row enriched with `email` and
 * `isAdmin`. Tests use it to read server-derived defaults (e.g.
 * `defaultCategoryId`) instead of assuming what the seed produced.
 */
export async function getUserInfo<R extends boolean | undefined = undefined>({ raw }: { raw?: R } = {}) {
  return makeRequest<UserInfoResponse, R>({
    method: 'get',
    url: '/user',
    raw,
  });
}

/**
 * Runs the password-reset flow through the better-auth mock. The mock's reset token is the auth
 * user id, and the configured `onPasswordReset` hook runs exactly as it does after a real reset.
 */
export async function resetPasswordForTests({ authUserId }: { authUserId: string }) {
  return makeAuthRequest({
    method: 'post',
    url: '/auth/reset-password',
    payload: { token: authUserId, newPassword: 'a-new-test-password-123' },
  });
}
