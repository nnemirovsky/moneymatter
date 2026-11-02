import { describe, expect, it, jest } from '@jest/globals';
import { z } from 'zod';

// The import chains of the tool handlers open Redis connections; only their input shapes are read here.
jest.mock('@services/categories.service', () => ({ getCategories: jest.fn() }));
jest.mock('@services/accounts.service', () => ({ getAccounts: jest.fn() }));

import { ToolInputError, validateWithRefs } from '../../chat/proposals/placeholders';
import { findToolCatalogEntry, getToolCatalog } from '../tool-catalog';

const ID_FIELD = /^(ids?|\w*(Id|Ids))$/;

/**
 * Id arguments that are not record uuids, so a plain string is right for them. Everything else named
 * like an id must be a uuid, so a malformed one is refused before it reaches a query.
 */
const NOT_RECORD_UUIDS: Record<string, string> = {
  'get_bank_sync_status.jobGroupId': 'a queue job group id',
  'get_transactions.transferId': 'a text column that holds a hash joining two legs',
  'list_share_members.resourceId': 'a household is shared by its owner user id, a number',
  'set_currency_rate_source.config.coinId': 'a CoinGecko coin id',
  'unlink_transfer.transferIds': 'a text column that holds a hash joining two legs',
  'update_user_settings.dashboard.widgets[].widgetId': 'a widget name from the frontend',
  'update_user_settings.fire.returnIndicatorId': 'a market indicator name',
  'update_user_settings.savedPivotViews[].config.accountIds': 'stored in the settings JSON, never queried here',
  'update_user_settings.savedPivotViews[].config.categoryIds': 'stored in the settings JSON, never queried here',
  'update_user_settings.savedPivotViews[].config.payeeIds': 'stored in the settings JSON, never queried here',
  'update_user_settings.savedPivotViews[].id': 'an id the frontend makes for a saved view',
  'update_user_settings.savedTransactionViews[].id': 'an id the frontend makes for a saved view',
  'update_user_settings.ui.transactionsTable.columnWidths[].id': 'a table column name',
};

interface JsonNode {
  type?: string | string[];
  format?: string;
  items?: JsonNode;
  properties?: Record<string, JsonNode>;
  anyOf?: JsonNode[];
  oneOf?: JsonNode[];
  allOf?: JsonNode[];
  additionalProperties?: boolean | JsonNode;
}

/** The string positions of an id field that accept any text, in the schema of that field. */
const hasFreeString = ({ node }: { node: JsonNode }): boolean => {
  if (node.items) return hasFreeString({ node: node.items });
  const options = [...(node.anyOf ?? []), ...(node.oneOf ?? []), ...(node.allOf ?? [])];
  if (options.length > 0) return options.some((option) => hasFreeString({ node: option }));
  return node.type === 'string' && node.format !== 'uuid' && !('const' in node) && !('enum' in node);
};

const collectFreeIdFields = ({ node, path, found }: { node: JsonNode; path: string; found: string[] }): void => {
  for (const [name, child] of Object.entries(node.properties ?? {})) {
    if (ID_FIELD.test(name) && hasFreeString({ node: child })) found.push(`${path}.${name}`);
    collectFreeIdFields({ node: child, path: `${path}.${name}`, found });
  }
  if (node.items) collectFreeIdFields({ node: node.items, path: `${path}[]`, found });
  for (const option of [...(node.anyOf ?? []), ...(node.oneOf ?? []), ...(node.allOf ?? [])]) {
    collectFreeIdFields({ node: option, path, found });
  }
};

describe('id arguments of the MCP tools', () => {
  it('are record uuids, apart from the ids listed as something else', () => {
    const found: string[] = [];
    for (const entry of getToolCatalog()) {
      if (!entry.inputShape) continue;
      const schema = z.toJSONSchema(z.object(entry.inputShape), { io: 'input' }) as JsonNode;
      collectFreeIdFields({ node: schema, path: entry.name, found });
    }

    expect(found.toSorted()).toEqual(Object.keys(NOT_RECORD_UUIDS).toSorted());
  });

  it('refuses the malformed subscription id the model wrote on an update', () => {
    const entry = findToolCatalogEntry({ name: 'update_subscription' })!;

    expect(() => validateWithRefs({ entry, args: { id: '01a14b51-73c8-af44-bc2ce032ca30', name: 'Netflix' } })).toThrow(
      ToolInputError,
    );
  });

  it('still takes a $proposal: ref where a subscription id goes', () => {
    const ref = '$proposal:3f1b9c2e-8d4a-4b6e-9c1d-2a7e5f0b8c11';
    const entry = findToolCatalogEntry({ name: 'unlink_transactions_from_subscription' })!;

    expect(
      validateWithRefs({
        entry,
        args: { subscriptionId: ref, transactionIds: ['00000000-0000-4000-8000-000000000001'] },
      }).refs,
    ).toEqual(['3f1b9c2e-8d4a-4b6e-9c1d-2a7e5f0b8c11']);
  });
});
