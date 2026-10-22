import {
  TRACKER_STATUSES,
  TRACKER_AI_DEFAULT_PRE_WINDOW_DAYS,
  TRACKER_AI_DESCRIPTION_MAX_LENGTH,
  TRACKER_AI_PRE_WINDOW_DAYS,
} from '@bt/shared/types';
import { normalizeRangeBounds, timeInputSchema } from '@common/lib/time-zones/resolve-time-input';
import { resolveUserRangeBounds } from '@common/lib/time-zones/resolve-user-time';
import { createTrackerBodySchema, createTrackerBodyShape } from '@controllers/trackers/shared-schemas';
import { smartTrackingFieldsShape } from '@controllers/trackers/smart-tracking-fields.schema';
import { trackMcpToolUsed } from '@js/utils/posthog';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { serializeTracker } from '@root/serializers/trackers.serializer';
import { createTracker } from '@services/trackers/create-tracker';
import { z } from 'zod';

import { assertBaseCurrencyUnlocked, getUserId, jsonContent, requireScope, type ToolArgs } from './helpers';

const inputSchema = {
  name: createTrackerBodyShape.name.describe('Tracker name, 1-200 characters'),
  status: z
    .enum([TRACKER_STATUSES.active, TRACKER_STATUSES.archived, TRACKER_STATUSES.closed])
    .optional()
    .describe('Tracker status (default: active)'),
  type: createTrackerBodyShape.type.describe(
    'Tracker type: manual (transactions linked explicitly) or category (auto-tracks by category). Default: manual',
  ),
  categoryIds: createTrackerBodyShape.categoryIds.describe(
    'Category IDs to link. Required (at least one) when type is "category"',
  ),
  startDate: timeInputSchema()
    .nullable()
    .optional()
    .describe("Tracker start: a date (2026-10-01, day start, user's zone), a wall time or ISO time"),
  endDate: timeInputSchema()
    .nullable()
    .optional()
    .describe("Tracker end: a date (2026-10-31, day end, user's zone), a wall time or ISO time; not before startDate"),
  autoInclude: createTrackerBodyShape.autoInclude.describe(
    'Auto-include transactions in the date range when creating (manual trackers only)',
  ),
  limitAmount: z
    .number()
    .positive()
    .nullable()
    .optional()
    .describe("Spending limit as a decimal amount in the user's base currency (e.g. 500.00)"),
  logoDomain: createTrackerBodyShape.logoDomain.describe(
    'Brand domain to take the logo from (e.g. "airbnb.com"), no protocol or slashes. Not together with logoInitials or logoIcon',
  ),
  logoInitials: createTrackerBodyShape.logoInitials.describe(
    'One or two characters shown as a monogram. Not together with logoDomain',
  ),
  logoColor: createTrackerBodyShape.logoColor.describe(
    'Monogram or icon background as #rrggbb; needs logoInitials or logoIcon',
  ),
  logoIcon: createTrackerBodyShape.logoIcon.describe(
    'Icon key shown as the logo (e.g. "airplane-24-regular"). Not together with logoDomain or logoInitials',
  ),
  aiEnabled: smartTrackingFieldsShape.aiEnabled.describe(
    'Turn on smart tracking: an AI scans the date range and links or suggests matching transactions. Manual trackers only; requires aiDescription and startDate',
  ),
  aiDescription: smartTrackingFieldsShape.aiDescription.describe(
    `Plain-language description of what belongs in the tracker (max ${TRACKER_AI_DESCRIPTION_MAX_LENGTH} chars), e.g. "Trip to Lisbon: flights, hotels, food"`,
  ),
  aiPreWindowDays: smartTrackingFieldsShape.aiPreWindowDays.describe(
    `Days before startDate the AI also scans, for things booked in advance. One of ${TRACKER_AI_PRE_WINDOW_DAYS.join(', ')}. Default: ${TRACKER_AI_DEFAULT_PRE_WINDOW_DAYS}`,
  ),
};

/** The category, date-order and logo either-or rules span fields, so they run on the REST body schema. */
export function validateCreateTrackerArgs({ args }: { args: ToolArgs<typeof inputSchema> }) {
  const { status, ...fields } = args;
  // The handler cuts the bounds in the user's zone first; on `UTC` that pass is a no-op.
  return {
    status,
    ...createTrackerBodySchema.parse(
      normalizeRangeBounds({ args: fields, startKey: 'startDate', endKey: 'endDate', zone: 'UTC' }),
    ),
  };
}

export function registerCreateTracker(server: McpServer) {
  server.registerTool(
    'create_tracker',
    {
      description:
        'Create a tracker with an optional spending limit, date range, linked categories and logo. It does not create or change the period-based Budget plan. Set aiEnabled with aiDescription and startDate to turn on smart tracking (manual trackers only); review its suggestions with list_tracker_suggestions. Returns the created tracker with its ID, status, type, and associated categories.',
      inputSchema,
    },
    async (args, extra) => {
      const userId = getUserId({ extra });
      requireScope({ extra, scope: 'finance:write' });
      await assertBaseCurrencyUnlocked({ userId });
      trackMcpToolUsed({ userId, tool: 'create_tracker', clientId: extra.authInfo?.clientId });

      const bounded = await resolveUserRangeBounds({ userId, args, startKey: 'startDate', endKey: 'endDate' });
      const { status, ...body } = validateCreateTrackerArgs({ args: bounded });

      const tracker = await createTracker({
        userId,
        name: body.name,
        status: status ?? TRACKER_STATUSES.active,
        type: body.type,
        categoryIds: body.categoryIds,
        startDate: body.startDate ? new Date(body.startDate) : undefined,
        endDate: body.endDate ? new Date(body.endDate) : undefined,
        autoInclude: body.autoInclude,
        limitAmount: body.limitAmount,
        logoDomain: body.logoDomain,
        logoInitials: body.logoInitials,
        logoColor: body.logoColor,
        logoIcon: body.logoIcon,
        aiEnabled: body.aiEnabled,
        aiDescription: body.aiDescription,
        aiPreWindowDays: body.aiPreWindowDays,
      });

      return jsonContent({ data: serializeTracker(tracker) });
    },
  );
}
