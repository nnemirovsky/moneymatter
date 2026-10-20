import { describe, expect, it } from '@jest/globals';

import { buildNullOnRestoreOverrides } from './null-on-restore';

const column = ({ attrName, field = attrName }: { attrName: string; field?: string }) => ({
  attrName,
  field,
  allowNull: true,
  hasDefault: false,
  autoIncrement: false,
});

describe('buildNullOnRestoreOverrides', () => {
  it('nulls each listed column the archive carries', () => {
    const overrides = buildNullOnRestoreOverrides({
      def: { nullOnRestore: ['proposalId'] },
      plan: { columns: [column({ attrName: 'id' }), column({ attrName: 'proposalId' })] },
    });

    expect(overrides).toEqual({ proposalId: null });
  });

  it('keys the override by the database field', () => {
    const overrides = buildNullOnRestoreOverrides({
      def: { nullOnRestore: ['proposalId'] },
      plan: { columns: [column({ attrName: 'proposalId', field: 'proposal_id' })] },
    });

    expect(overrides).toEqual({ proposal_id: null });
  });

  it('leaves out a column the archive lacks', () => {
    const overrides = buildNullOnRestoreOverrides({
      def: { nullOnRestore: ['proposalId'] },
      plan: { columns: [column({ attrName: 'id' })] },
    });

    expect(overrides).toEqual({});
  });

  it('returns nothing for a table with no such columns', () => {
    const overrides = buildNullOnRestoreOverrides({
      def: {},
      plan: { columns: [column({ attrName: 'proposalId' })] },
    });

    expect(overrides).toEqual({});
  });
});
