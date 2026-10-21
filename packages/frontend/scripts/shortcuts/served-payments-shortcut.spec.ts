// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { buildPaymentsShortcut } from './build-payments-shortcut';

type Dict = Record<string, any>;

const SERVED_FILE = fileURLToPath(new URL('../../public/shortcuts/log-payments.shortcut', import.meta.url));

const hasTool = ({ tool }: { tool: string }): boolean => {
  try {
    execFileSync('which', [tool], { stdio: 'ignore' });

    return true;
  } catch {
    return false;
  }
};

/**
 * Decodes an AEA-signed `.shortcut` (the AEA1 header, the signing certificate in the auth data, then
 * `aea decrypt` and `aa extract`). Needs macOS tools; the spec skips elsewhere.
 */
const decodeSignedShortcut = ({ file }: { file: string }): Dict => {
  const dir = mkdtempSync(join(tmpdir(), 'signed-shortcut-'));

  try {
    const bytes = readFileSync(file);
    const authLength = bytes.readUInt32LE(8);
    const authPath = join(dir, 'auth.bplist');
    writeFileSync(authPath, bytes.subarray(12, 12 + authLength));

    const auth = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', authPath]).toString()) as Dict;
    const leaf = Buffer.from(auth.SigningCertificateChain[0], 'base64');
    writeFileSync(join(dir, 'leaf.der'), leaf);
    const pub = execFileSync('openssl', ['x509', '-inform', 'der', '-in', join(dir, 'leaf.der'), '-pubkey', '-noout']);
    writeFileSync(join(dir, 'pub.pem'), pub);

    execFileSync('aea', ['decrypt', '-i', file, '-o', join(dir, 'out.aar'), '-sign-pub', join(dir, 'pub.pem')]);
    execFileSync('aa', ['extract', '-i', join(dir, 'out.aar'), '-d', dir]);

    return JSON.parse(
      execFileSync('plutil', ['-convert', 'json', '-o', '-', join(dir, 'Shortcut.wflow')]).toString(),
    ) as Dict;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const canDecode = existsSync(SERVED_FILE) && ['plutil', 'openssl', 'aea', 'aa'].every((tool) => hasTool({ tool }));

/** The iPhone re-signs the shortcut, so bytes differ; actions and triggers are what must survive. */
describe.skipIf(!canDecode)('the served iOS 27 shortcut (public/shortcuts/log-payments.shortcut)', () => {
  const generated = buildPaymentsShortcut() as Dict;
  const served = canDecode ? decodeSignedShortcut({ file: SERVED_FILE }) : {};

  const triggerSummary = (shortcut: Dict) =>
    (shortcut.WFWorkflowTriggers as Dict[]).map((trigger) => ({
      id: trigger.WFTriggerIdentifier,
      apps: ((trigger.WFTriggerSerializedParameters?.SelectedApps ?? []) as Dict[]).map((app) => app.BundleIdentifier),
    }));

  it('has the same actions, in the same order, as the generated plist', () => {
    const identifiers = (shortcut: Dict) =>
      (shortcut.WFWorkflowActions as Dict[]).map((action) => action.WFWorkflowActionIdentifier);

    expect(identifiers(served)).toEqual(identifiers(generated));
  });

  it('keeps both triggers, with Wallet and Messages in the Notification trigger', () => {
    const summary = triggerSummary(served);
    const notification = summary.find((trigger) => trigger.id === 'WFNotificationTrigger');

    expect(summary.map((trigger) => trigger.id).sort()).toEqual([
      'WFNotificationTrigger',
      'WFWalletTransactionTrigger',
    ]);
    expect(notification?.apps).toEqual(expect.arrayContaining(['com.apple.Passbook', 'com.apple.MobileSMS']));
  });
});
