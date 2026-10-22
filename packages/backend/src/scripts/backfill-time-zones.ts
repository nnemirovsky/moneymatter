import '../bootstrap';

import { logger } from '@js/utils/logger';

import { connection } from '../models';
import { DEFAULT_GROUPS } from '../services/time-zone-backfill/groups';
import { formatReport, runTimeZoneBackfill } from '../services/time-zone-backfill/run';

/**
 * One-off: gives the rows imported from the Google Sheets ledger the zone of the period they were
 * entered in, and moves their stored instants from the sheet's Istanbul anchoring to the real wall
 * clock in that zone. Amounts are not touched. See `services/time-zone-backfill`.
 *
 * Dry run (default, writes nothing):  node dist/scripts/backfill-time-zones.js
 * Apply (one transaction):            node dist/scripts/backfill-time-zones.js --apply
 *
 * `--expect key=count[,key=count]` overrides a group's expected row count. Without a match the run
 * aborts, which is the point of the counts: they were taken from the data when the groups were approved.
 * `--import-created-from` / `--import-created-to` (ISO) bound when the imported rows were created.
 */
const readFlag = ({ name }: { name: string }): string | undefined => {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);

  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const parseExpected = ({ raw }: { raw: string | undefined }): Map<string, number> =>
  new Map(
    (raw ?? '')
      .split(',')
      .filter(Boolean)
      .map((pair) => {
        const [key, count] = pair.split('=');
        return [key!, Number(count)] as const;
      }),
  );

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  if (apply && process.argv.includes('--dry-run')) throw new Error('Pass either --apply or --dry-run, not both');

  const expected = parseExpected({ raw: readFlag({ name: 'expect' }) });
  const groups = DEFAULT_GROUPS.map((group) => ({
    ...group,
    expectedRows: expected.get(group.key) ?? group.expectedRows,
  }));
  for (const key of expected.keys()) {
    if (!groups.some((group) => group.key === key)) throw new Error(`--expect names an unknown group: ${key}`);
  }

  const from = readFlag({ name: 'import-created-from' });
  const to = readFlag({ name: 'import-created-to' });

  const report = await runTimeZoneBackfill({
    apply,
    groups,
    ...(from && { importCreatedFrom: new Date(from) }),
    ...(to && { importCreatedTo: new Date(to) }),
  });

  logger.info(`\n${formatReport({ report })}`);
  process.exitCode = report.problems.length ? 2 : 0;
}

main()
  .then(async () => {
    await connection.sequelize.close();
    process.exit(process.exitCode ?? 0);
  })
  .catch(async (error) => {
    logger.error({ message: '[Backfill Time Zones] failed', error });
    try {
      await connection.sequelize.close();
    } catch {
      // best-effort cleanup
    }
    process.exit(1);
  });
