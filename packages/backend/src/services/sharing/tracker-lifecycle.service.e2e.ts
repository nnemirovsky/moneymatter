/**
 * Tracker sharing lifecycle — cleanup sweeps on revoke, leave, and tracker deletion.
 *
 * Verifies that recipient-attached TrackerTransactions rows are swept when access
 * is removed, and that tracker deletion cleans up ResourceShares + ShareInvitations
 * while leaving the recipient's underlying Transactions intact.
 */

import { RESOURCE_TYPES, SHARE_INVITATION_STATUSES, SHARE_PERMISSIONS } from '@bt/shared/types';
import { describe, expect, it } from '@jest/globals';
import ResourceShares from '@models/resource-shares.model';
import ShareInvitations from '@models/share-invitations.model';
import TrackerTransactions from '@models/tracker-transactions.model';
import Transactions from '@models/transactions.model';
import * as helpers from '@tests/helpers';

// ---------------------------------------------------------------------------
// Scaffold helpers
// ---------------------------------------------------------------------------

interface RecipientHandle extends helpers.SecondUserHandle {}

async function provisionRecipient(): Promise<RecipientHandle> {
  const handle = await helpers.signUpSecondUser();
  await helpers.asUser({
    cookies: handle.cookies,
    fn: async () => {
      const res = await helpers.setBaseCurrencyForActiveUser({
        currencyCode: global.BASE_CURRENCY.code,
      });
      if (res.statusCode !== 200) {
        throw new Error(`Failed to set base currency: ${res.statusCode} ${JSON.stringify(res.body)}`);
      }
    },
  });
  return handle;
}

async function shareTrackerAndAccept({
  trackerId,
  recipient,
  permission = SHARE_PERMISSIONS.write,
}: {
  trackerId: string;
  recipient: RecipientHandle;
  permission?: (typeof SHARE_PERMISSIONS)[keyof typeof SHARE_PERMISSIONS];
}): Promise<void> {
  const invitation = await helpers.createShareInvitation({
    inviteeEmail: recipient.email,
    resourceType: RESOURCE_TYPES.tracker,
    resourceId: trackerId,
    permission,
    raw: true,
  });
  await helpers.asUser({
    cookies: recipient.cookies,
    fn: () => helpers.acceptShareInvitation({ token: invitation.token, raw: true }),
  });
}

/**
 * Recipient attaches N of their own transactions to a tracker.
 * Returns the transaction ids that were attached.
 */
async function recipientAttachesTxs({
  trackerId,
  recipientCookies,
  count,
}: {
  trackerId: string;
  recipientCookies: string;
  count: number;
}): Promise<string[]> {
  // Create a recipient-owned account and category so the transactions are valid for the recipient.
  const recipientAccount = await helpers.asUser({
    cookies: recipientCookies,
    fn: () => helpers.createAccount({ raw: true }),
  });
  const recipientCategory = await helpers.asUser({
    cookies: recipientCookies,
    fn: () =>
      helpers.addCustomCategory({
        name: 'Recipient lifecycle cat',
        color: '#AABBCC',
        raw: true,
      }),
  });

  const txIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const [tx] = await helpers.asUser({
      cookies: recipientCookies,
      fn: () =>
        helpers.createTransaction({
          payload: helpers.buildTransactionPayload({
            accountId: recipientAccount.id,
            categoryId: recipientCategory.id,
          }),
          raw: true,
        }),
    });
    txIds.push(tx!.id);
  }

  await helpers.asUser({
    cookies: recipientCookies,
    fn: () =>
      helpers.addTransactionsToTracker({
        id: trackerId,
        payload: { transactionIds: txIds },
        raw: true,
      }),
  });

  return txIds;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Tracker sharing lifecycle', () => {
  describe('Revoke share', () => {
    it("sweeps recipient's TrackerTransactions rows; owner's rows and recipient's Transactions rows untouched", async () => {
      const account = await helpers.createAccount({ raw: true });
      const tracker = await helpers.createTracker({
        name: 'Revoke sweep',
        raw: true,
      });

      // Owner attaches their own tx first
      const [ownerTx] = await helpers.createTransaction({
        payload: helpers.buildTransactionPayload({
          accountId: account.id,
          amount: 100,
        }),
        raw: true,
      });
      await helpers.addTransactionsToTracker({
        id: tracker.id,
        payload: { transactionIds: [ownerTx!.id] },
        raw: true,
      });

      const recipient = await provisionRecipient();
      await shareTrackerAndAccept({ trackerId: tracker.id, recipient });

      // Recipient attaches 2 of their own txs
      const recipientTxIds = await recipientAttachesTxs({
        trackerId: tracker.id,
        recipientCookies: recipient.cookies,
        count: 2,
      });

      // Confirm rows exist before revoke
      const beforeRecipientRows = await TrackerTransactions.findAll({
        where: { trackerId: tracker.id, transactionId: recipientTxIds },
      });
      expect(beforeRecipientRows).toHaveLength(2);

      // Owner revokes the share
      const recipientApp = await helpers.findAppUserByEmail({
        email: recipient.email,
      });
      await helpers.revokeShareMember({
        resourceType: RESOURCE_TYPES.tracker,
        resourceId: tracker.id,
        memberUserId: recipientApp.id,
        raw: true,
      });

      // ResourceShares row gone
      const shareRow = await ResourceShares.findOne({
        where: {
          resourceType: RESOURCE_TYPES.tracker,
          resourceId: tracker.id,
          sharedWithUserId: recipientApp.id,
        },
      });
      expect(shareRow).toBeNull();

      // Recipient's TrackerTransactions rows swept
      const afterRecipientRows = await TrackerTransactions.findAll({
        where: { trackerId: tracker.id, transactionId: recipientTxIds },
      });
      expect(afterRecipientRows).toHaveLength(0);

      // Owner's TrackerTransactions row still present
      const ownerRow = await TrackerTransactions.findOne({
        where: { trackerId: tracker.id, transactionId: ownerTx!.id },
      });
      expect(ownerRow).not.toBeNull();

      // Recipient's underlying Transactions rows are untouched
      for (const txId of recipientTxIds) {
        const tx = await Transactions.findByPk(txId);
        expect(tx).not.toBeNull();
      }
    });
  });

  describe('Leave share', () => {
    it("sweeps recipient's TrackerTransactions rows when recipient leaves", async () => {
      const tracker = await helpers.createTracker({
        name: 'Leave sweep',
        raw: true,
      });

      const recipient = await provisionRecipient();
      await shareTrackerAndAccept({ trackerId: tracker.id, recipient });

      const recipientTxIds = await recipientAttachesTxs({
        trackerId: tracker.id,
        recipientCookies: recipient.cookies,
        count: 2,
      });

      const recipientApp = await helpers.findAppUserByEmail({
        email: recipient.email,
      });

      // Recipient leaves
      await helpers.asUser({
        cookies: recipient.cookies,
        fn: () =>
          helpers.leaveShare({
            resourceType: RESOURCE_TYPES.tracker,
            resourceId: tracker.id,
            raw: true,
          }),
      });

      // ResourceShares row gone
      const shareRow = await ResourceShares.findOne({
        where: {
          resourceType: RESOURCE_TYPES.tracker,
          resourceId: tracker.id,
          sharedWithUserId: recipientApp.id,
        },
      });
      expect(shareRow).toBeNull();

      // Recipient's TrackerTransactions rows swept
      const afterRows = await TrackerTransactions.findAll({
        where: { trackerId: tracker.id, transactionId: recipientTxIds },
      });
      expect(afterRows).toHaveLength(0);

      // Underlying Transactions rows survive
      for (const txId of recipientTxIds) {
        const tx = await Transactions.findByPk(txId);
        expect(tx).not.toBeNull();
      }
    });
  });

  describe('Tracker deletion', () => {
    it('deletes tracker, sweeps ResourceShares, revokes pending invitation, cascades TrackerTransactions', async () => {
      const tracker = await helpers.createTracker({
        name: 'Delete sweep single',
        raw: true,
      });

      // 1 accepted recipient
      const recipient = await provisionRecipient();
      await shareTrackerAndAccept({ trackerId: tracker.id, recipient });
      const recipientApp = await helpers.findAppUserByEmail({
        email: recipient.email,
      });

      const recipientTxIds = await recipientAttachesTxs({
        trackerId: tracker.id,
        recipientCookies: recipient.cookies,
        count: 1,
      });

      // 1 pending invitation
      const pendingUser = await provisionRecipient();
      const pendingInvitation = await helpers.createShareInvitation({
        inviteeEmail: pendingUser.email,
        resourceType: RESOURCE_TYPES.tracker,
        resourceId: tracker.id,
        permission: SHARE_PERMISSIONS.read,
        raw: true,
      });

      // Delete the tracker
      const res = await helpers.deleteTracker({ id: tracker.id, raw: false });
      expect(res.statusCode).toBe(200);

      // Tracker gone
      const trackerRow = await helpers.getTrackerById({
        id: tracker.id,
        raw: false,
      });
      expect(trackerRow.statusCode).toBe(404);

      // ResourceShares row gone
      const shareRow = await ResourceShares.findOne({
        where: {
          resourceType: RESOURCE_TYPES.tracker,
          resourceId: tracker.id,
          sharedWithUserId: recipientApp.id,
        },
      });
      expect(shareRow).toBeNull();

      // Pending invitation flipped to revoked
      const invitationAfter = await ShareInvitations.findByPk(pendingInvitation.id);
      expect(invitationAfter).not.toBeNull();
      expect(invitationAfter!.status).toBe(SHARE_INVITATION_STATUSES.revoked);
      expect(invitationAfter!.revokedAt).not.toBeNull();

      // TrackerTransactions rows gone (cascade)
      const btRows = await TrackerTransactions.findAll({
        where: { trackerId: tracker.id },
      });
      expect(btRows).toHaveLength(0);

      // Recipient's underlying Transactions rows survive
      for (const txId of recipientTxIds) {
        const tx = await Transactions.findByPk(txId);
        expect(tx).not.toBeNull();
      }
    });

    it('deletes tracker with 2 recipients — both recipients rows gone, both shares gone', async () => {
      const tracker = await helpers.createTracker({
        name: 'Delete sweep two recipients',
        raw: true,
      });

      const recipientA = await provisionRecipient();
      const recipientB = await provisionRecipient();
      await shareTrackerAndAccept({
        trackerId: tracker.id,
        recipient: recipientA,
      });
      await shareTrackerAndAccept({
        trackerId: tracker.id,
        recipient: recipientB,
      });

      const recipientAApp = await helpers.findAppUserByEmail({
        email: recipientA.email,
      });
      const recipientBApp = await helpers.findAppUserByEmail({
        email: recipientB.email,
      });

      const txIdsA = await recipientAttachesTxs({
        trackerId: tracker.id,
        recipientCookies: recipientA.cookies,
        count: 1,
      });
      const txIdsB = await recipientAttachesTxs({
        trackerId: tracker.id,
        recipientCookies: recipientB.cookies,
        count: 1,
      });

      await helpers.deleteTracker({ id: tracker.id, raw: true });

      // Both ResourceShares rows gone
      const shareA = await ResourceShares.findOne({
        where: {
          resourceType: RESOURCE_TYPES.tracker,
          resourceId: tracker.id,
          sharedWithUserId: recipientAApp.id,
        },
      });
      const shareB = await ResourceShares.findOne({
        where: {
          resourceType: RESOURCE_TYPES.tracker,
          resourceId: tracker.id,
          sharedWithUserId: recipientBApp.id,
        },
      });
      expect(shareA).toBeNull();
      expect(shareB).toBeNull();

      // All TrackerTransactions rows gone
      const btRows = await TrackerTransactions.findAll({
        where: { trackerId: tracker.id },
      });
      expect(btRows).toHaveLength(0);

      // Both recipients' underlying Transactions survive
      for (const txId of [...txIdsA, ...txIdsB]) {
        const tx = await Transactions.findByPk(txId);
        expect(tx).not.toBeNull();
      }
    });
  });
});
