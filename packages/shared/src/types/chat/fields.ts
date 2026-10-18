/**
 * Entities a card or a table cell can name. The tool policies derive the entity from the tool name
 * (`create_budget_plan_line` becomes `budgetPlanLine`), so this list holds every entity the write
 * tools touch.
 */
export const CHAT_ENTITY_KINDS = [
  'transaction',
  'account',
  'accountGroup',
  'category',
  'tag',
  'tagReminder',
  'payee',
  'payeeAlias',
  'budget',
  'budgetPlan',
  'budgetPlanGroup',
  'budgetPlanLine',
  'subscription',
  'loan',
  'vehicle',
  'portfolio',
  'holding',
  'investmentTransaction',
  'transactionGroup',
  'transactionAutomation',
  'transactionTemplate',
  'customCurrency',
  'userCurrency',
  'exchangeRate',
  'venturePlatform',
  'ventureDeal',
  'ventureEvent',
  'importBatch',
  'attachment',
  'bankConnection',
  'notification',
  'userSettings',
] as const;

export type ChatEntityKind = (typeof CHAT_ENTITY_KINDS)[number];

/** A reference to one entity, as card results and table cells carry it. */
export interface ChatEntityRef {
  kind: ChatEntityKind;
  id: string;
}

/**
 * Tool argument name to the i18n key of its label on a card. The chat capability drift suite requires
 * a key for every top-level field of every write tool, and a frontend unit test requires each key in
 * the `en` and `uk` locales.
 */
export const CHAT_FIELD_LABEL_KEYS: Readonly<Record<string, string>> = {};
