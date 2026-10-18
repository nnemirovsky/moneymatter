import {
  CHAT_CARD_KINDS,
  CHAT_ENTITY_KINDS,
  CHAT_FIELD_LABEL_KEYS,
  chatCardTitleKey,
  chatEntityLabelKey,
} from '@bt/shared/types';
import { describe, expect, it, jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';

// The import chains of these services open Redis connections.
jest.mock('@services/categories.service', () => ({ getCategories: jest.fn() }));
jest.mock('@services/accounts.service', () => ({ getAccounts: jest.fn() }));

import { makeChatRun } from '@tests/helpers/chat-toolkit';

import { getToolCatalog, type ToolCatalogEntry } from '../../mcp/tool-catalog';
import { CONDITIONAL_DELETE_TOOLS, DESTRUCTIVE_TOOLS, READ_TOOL_NAME } from '../../mcp/tool-classification';
import { buildChatToolkit } from '../toolkit/build-toolkit';
import { CHAT_CORE_TOOL_REASONS, CHAT_CORE_TOOLS } from './core-tools';
import { UNMAPPED_ID_FIELDS } from './entity-fields';
import { CHAT_ARGS_ONLY_TOOLS, CHAT_EXCLUDED_TOOLS } from './excluded';
import {
  EGRESS_TOOLS,
  ENTITY_LOADER_KINDS,
  EXPLICIT_POLICIES,
  READ_TOOL_PAGINATION,
  STANDALONE_TOOLS,
  THIRD_PARTY_READ_TOOLS,
} from './explicit';
import { getToolPolicy, resolveToolPolicy } from './index';
import { HIGH_IMPACT_TOOLS, PREVIEW_RESOLVER_NAMES } from './rules';

const EN_CHAT_PATH = path.resolve(__dirname, '../../../../../frontend/src/i18n/locales/chunks/en/pages/chat.json');

/** The schema budget for the tools every chat step sends; the rest is found through `find_capabilities`. */
const CORE_SCHEMA_BUDGET_BYTES = 60 * 1024;

/** Arguments that take each conditional-delete tool down its delete path. */
const CONDITIONAL_DELETE_FIXTURES: Record<string, unknown> = {
  ignore_payee_name: { rawName: 'ACME', force: true },
  revert_subscription_period: { subscriptionId: 'x', periodId: 'y' },
};

const catalog = (): readonly ToolCatalogEntry[] => getToolCatalog();
const writeTools = () => catalog().filter((tool) => tool.access === 'write');
const capabilities = () => writeTools().filter((tool) => !(tool.name in CHAT_EXCLUDED_TOOLS));
const toolNames = () => new Set(catalog().map((tool) => tool.name));
const shapeKeys = ({ tool }: { tool: ToolCatalogEntry }) => Object.keys(tool.inputShape ?? {});
const policyOf = ({ name }: { name: string }) => getToolPolicy({ name })!;

describe('chat capability drift', () => {
  // Check 1
  it('treats every tool as a read, a write capability or an excluded write, and nothing else', () => {
    for (const tool of catalog()) {
      const excluded = tool.name in CHAT_EXCLUDED_TOOLS;
      if (tool.access === 'read') {
        expect([tool.name, excluded]).toEqual([tool.name, false]);
      } else if (excluded) {
        expect([tool.name, getToolPolicy({ name: tool.name })]).toEqual([tool.name, null]);
      }
    }
  });

  it('gives every exclusion a reason and names a write tool', () => {
    for (const [name, reason] of Object.entries(CHAT_EXCLUDED_TOOLS)) {
      expect(toolNames().has(name)).toBe(true);
      expect(READ_TOOL_NAME.test(name)).toBe(false);
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  // Check 2
  it('resolves a policy for every write capability', () => {
    const without = capabilities()
      .filter((tool) => getToolPolicy({ name: tool.name }) === null)
      .map((tool) => tool.name);

    expect(without).toEqual([]);
  });

  it('keeps a policy name equal to its tool name and its entity and kind in the shared lists', () => {
    for (const tool of capabilities()) {
      const policy = policyOf({ name: tool.name });

      expect(policy.name).toBe(tool.name);
      expect(CHAT_ENTITY_KINDS).toContain(policy.entity);
      expect(CHAT_CARD_KINDS).toContain(policy.kind);
    }
  });

  // Check 3
  it('makes every delete, bulk, merge, destructive and high-impact tool red with a real resolver', () => {
    const red = capabilities().filter(
      (tool) =>
        tool.name.startsWith('delete_') ||
        tool.name.startsWith('bulk_') ||
        tool.name.startsWith('merge_') ||
        DESTRUCTIVE_TOOLS.includes(tool.name) ||
        HIGH_IMPACT_TOOLS.includes(tool.name),
    );
    expect(red.length).toBeGreaterThan(30);

    for (const tool of red) {
      const policy = policyOf({ name: tool.name });

      expect([tool.name, policy.danger !== 'none']).toEqual([tool.name, true]);
      expect([tool.name, policy.previewResolver !== null]).toEqual([tool.name, true]);
      expect([tool.name, CHAT_ARGS_ONLY_TOOLS.includes(tool.name)]).toEqual([tool.name, false]);
    }
  });

  it('makes every conditional-delete tool red on its delete path', () => {
    for (const name of CONDITIONAL_DELETE_TOOLS) {
      expect([name, name in CONDITIONAL_DELETE_FIXTURES]).toEqual([name, true]);
      expect([name, resolveToolPolicy({ name, args: CONDITIONAL_DELETE_FIXTURES[name] })!.danger !== 'none']).toEqual([
        name,
        true,
      ]);
      expect([name, policyOf({ name }).previewResolver !== null]).toEqual([name, true]);
    }
  });

  it('keeps a red tool out of the args-only list', () => {
    for (const name of CHAT_ARGS_ONLY_TOOLS) {
      expect([name, policyOf({ name }).danger]).toEqual([name, 'none']);
    }
  });

  it('lists a tool as args-only exactly when its policy declares no preview resolver', () => {
    const declared = capabilities()
      .filter((tool) => policyOf({ name: tool.name }).previewResolver === null)
      .map((tool) => tool.name)
      .toSorted();

    expect([...CHAT_ARGS_ONLY_TOOLS].toSorted()).toEqual(declared);
  });

  it('declares only resolver names the resolver registry lists, and uses each of them', () => {
    const used = new Set<string>();
    for (const tool of capabilities()) {
      const { previewResolver } = policyOf({ name: tool.name });
      if (previewResolver === null) continue;

      expect(PREVIEW_RESOLVER_NAMES).toContain(previewResolver);
      used.add(previewResolver);
    }

    expect([...used].toSorted()).toEqual([...PREVIEW_RESOLVER_NAMES].toSorted());
  });

  it('names a target field the tool takes for every entity-loader policy, on an entity that has a loader', () => {
    for (const tool of capabilities()) {
      const policy = policyOf({ name: tool.name });
      if (policy.previewResolver !== 'entity') {
        expect([tool.name, policy.targetFields]).toEqual([tool.name, []]);
        continue;
      }

      expect(ENTITY_LOADER_KINDS).toContain(policy.entity);
      expect([tool.name, policy.targetFields.length > 0]).toEqual([tool.name, true]);
      for (const field of policy.targetFields) {
        expect([tool.name, field, shapeKeys({ tool }).includes(field)]).toEqual([tool.name, field, true]);
      }
    }
  });

  it('keeps standalone tools red, because they pass the stricter confirmation', () => {
    for (const name of STANDALONE_TOOLS) {
      expect(policyOf({ name })).toMatchObject({ standalone: true, danger: 'highImpact' });
    }
    const standalone = capabilities().filter((tool) => policyOf({ name: tool.name }).standalone);
    expect(standalone.map((tool) => tool.name).toSorted()).toEqual([...STANDALONE_TOOLS].toSorted());
  });

  // Check 4
  it('names an existing tool in every explicit entry and list', () => {
    const existing = toolNames();
    const named: Record<string, string[]> = {
      EXPLICIT_POLICIES: Object.keys(EXPLICIT_POLICIES),
      CHAT_EXCLUDED_TOOLS: Object.keys(CHAT_EXCLUDED_TOOLS),
      CHAT_ARGS_ONLY_TOOLS: [...CHAT_ARGS_ONLY_TOOLS],
      HIGH_IMPACT_TOOLS: [...HIGH_IMPACT_TOOLS],
      STANDALONE_TOOLS: [...STANDALONE_TOOLS],
      EGRESS_TOOLS: Object.keys(EGRESS_TOOLS),
      THIRD_PARTY_READ_TOOLS: [...THIRD_PARTY_READ_TOOLS],
      READ_TOOL_PAGINATION: Object.keys(READ_TOOL_PAGINATION),
      CHAT_CORE_TOOLS: [...CHAT_CORE_TOOLS],
      UNMAPPED_ID_FIELDS: Object.keys(UNMAPPED_ID_FIELDS),
    };

    for (const [list, names] of Object.entries(named)) {
      expect([list, names.filter((name) => !existing.has(name))]).toEqual([list, []]);
    }
  });

  it('keeps the hand-kept lists of reads on read tools and of writes on write tools', () => {
    for (const name of [...THIRD_PARTY_READ_TOOLS, ...Object.keys(READ_TOOL_PAGINATION)]) {
      expect([name, READ_TOOL_NAME.test(name)]).toEqual([name, true]);
    }
    for (const name of [
      ...Object.keys(EGRESS_TOOLS),
      ...STANDALONE_TOOLS,
      ...HIGH_IMPACT_TOOLS,
      ...CHAT_ARGS_ONLY_TOOLS,
    ]) {
      expect([name, READ_TOOL_NAME.test(name)]).toEqual([name, false]);
      expect([name, name in CHAT_EXCLUDED_TOOLS]).toEqual([name, false]);
    }
  });

  it('names pagination arguments the read tool takes', () => {
    const byName = new Map(catalog().map((tool) => [tool.name, tool]));

    for (const [name, pagination] of Object.entries(READ_TOOL_PAGINATION)) {
      const keys = shapeKeys({ tool: byName.get(name)! });
      const args = [pagination.limitArg, pagination.offsetArg, pagination.pageArg].filter(
        (arg): arg is string => !!arg,
      );

      expect(args.length).toBeGreaterThanOrEqual(2);
      for (const arg of args) expect([name, arg, keys.includes(arg)]).toEqual([name, arg, true]);
      expect(pagination.maxLimit).toBeGreaterThan(0);
    }
    expect(Object.keys(READ_TOOL_PAGINATION)).toContain('search_transactions');
  });

  it('gives an egress function to every egress tool, and an egress card to no other', () => {
    for (const name of Object.keys(EGRESS_TOOLS)) {
      expect([name, typeof EGRESS_TOOLS[name]]).toEqual([name, 'function']);
    }
    for (const tool of capabilities()) {
      if (tool.name in EGRESS_TOOLS) continue;

      expect([tool.name, resolveToolPolicy({ name: tool.name, args: {} })!.egress]).toEqual([tool.name, null]);
    }
  });

  // Check 5
  it('lists a reason for every core tool and keeps the list about 35 tools long', () => {
    expect([...CHAT_CORE_TOOLS].toSorted()).toEqual(Object.keys(CHAT_CORE_TOOL_REASONS).toSorted());
    expect(CHAT_CORE_TOOLS.length).toBeGreaterThanOrEqual(30);
    expect(CHAT_CORE_TOOLS.length).toBeLessThanOrEqual(40);
    expect(new Set(CHAT_CORE_TOOLS).size).toBe(CHAT_CORE_TOOLS.length);
    for (const name of CHAT_CORE_TOOLS) {
      expect([name, CHAT_CORE_TOOL_REASONS[name]!.length > 10]).toEqual([name, true]);
      expect([name, name in CHAT_EXCLUDED_TOOLS]).toEqual([name, false]);
    }
  });

  it('keeps the model-facing schemas of the tools every step offers within 60 KB', () => {
    const toolkit = buildChatToolkit({ run: makeChatRun().run });
    const active = new Set(toolkit.activeToolNames());
    const offered = toolkit.tools.filter((tool) => active.has(tool.name));
    const bytes = Buffer.byteLength(
      JSON.stringify(
        offered.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.modelSchema })),
      ),
      'utf8',
    );

    for (const name of CHAT_CORE_TOOLS) expect([name, active.has(name)]).toEqual([name, true]);
    expect(offered.length).toBe(CHAT_CORE_TOOLS.length + offered.filter((tool) => tool.kind === 'native').length);
    expect(bytes).toBeGreaterThan(5_000);
    expect(bytes).toBeLessThanOrEqual(CORE_SCHEMA_BUDGET_BYTES);
  });

  // Check 6
  it('has a label key for every top-level field of every write capability', () => {
    const missing = capabilities().flatMap((tool) =>
      shapeKeys({ tool })
        .filter((field) => !(field in CHAT_FIELD_LABEL_KEYS))
        .map((field) => `${tool.name}.${field}`),
    );

    expect(missing).toEqual([]);
  });

  it('keeps every label key under chat.fields and drops a label no capability uses', () => {
    const used = new Set(capabilities().flatMap((tool) => shapeKeys({ tool })));

    for (const [field, key] of Object.entries(CHAT_FIELD_LABEL_KEYS)) {
      expect(key).toBe(`chat.fields.${field}`);
      expect([field, used.has(field)]).toEqual([field, true]);
    }
  });

  // Check 7
  it('has a title key for every card kind and a name for every entity the policies use', () => {
    const en = JSON.parse(fs.readFileSync(EN_CHAT_PATH, 'utf-8')) as unknown;
    const read = ({ key }: { key: string }) =>
      key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], en);

    const kinds = new Set(capabilities().map((tool) => policyOf({ name: tool.name }).kind));
    const entities = new Set(capabilities().map((tool) => policyOf({ name: tool.name }).entity));

    for (const kind of kinds)
      expect([kind, typeof read({ key: chatCardTitleKey({ kind }) })]).toEqual([kind, 'string']);
    for (const entity of entities) {
      expect([entity, typeof read({ key: chatEntityLabelKey({ entity }) })]).toEqual([entity, 'string']);
    }
  });

  // Entity pickers
  it('maps every id-like argument of a write capability to an entity, or acknowledges that it names none', () => {
    const unmapped: string[] = [];

    for (const tool of capabilities()) {
      const policy = policyOf({ name: tool.name });

      for (const field of shapeKeys({ tool })) {
        if (!/(^ids?$|Ids?$|TxId$)/.test(field)) continue;
        if (field in policy.entityFields) continue;
        if (UNMAPPED_ID_FIELDS[tool.name]?.includes(field)) continue;

        unmapped.push(`${tool.name}.${field}`);
      }
    }

    expect(unmapped).toEqual([]);
  });

  it('acknowledges only unmapped id arguments that a tool really takes and that have no mapping', () => {
    for (const [name, fields] of Object.entries(UNMAPPED_ID_FIELDS)) {
      const tool = catalog().find((entry) => entry.name === name)!;
      const policy = policyOf({ name });

      for (const field of fields) {
        expect([name, field, shapeKeys({ tool }).includes(field)]).toEqual([name, field, true]);
        expect([name, field, field in policy.entityFields]).toEqual([name, field, false]);
      }
    }
  });

  it('covers every write capability with a card kind, so none falls through to an unnamed type', () => {
    const kinds = new Map<string, number>();
    for (const tool of capabilities()) {
      const { kind } = policyOf({ name: tool.name });
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    }

    expect([...kinds.keys()].toSorted()).toEqual([...CHAT_CARD_KINDS].toSorted());
    expect(capabilities().length).toBe(writeTools().length - Object.keys(CHAT_EXCLUDED_TOOLS).length);
  });
});
