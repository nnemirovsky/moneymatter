import { CHAT_VISUAL_LIMITS, type ChatEntityRef, type ChatVisualSpec } from '@bt/shared/types';
import { randomUUID } from 'crypto';
import { z } from 'zod';

import {
  chatChartSpecSchema,
  chatKpisSpecSchema,
  chatTableSpecSchema,
  chatVisualSpecSchema,
} from '../visuals/visual-spec';
import { findForeignEntities } from './entity-ownership';
import { defineNativeTool } from './native-tool';
import { toolFailure, toolSuccess } from './result-text';
import type { ChatToolContext } from './types';

const entityRefsOf = ({ spec }: { spec: ChatVisualSpec }): ChatEntityRef[] => {
  if (spec.type !== 'table') return [];

  return spec.rows.flatMap((row) =>
    Object.values(row).flatMap((cell) =>
      cell !== null && typeof cell === 'object' ? [{ kind: cell.kind, id: cell.id }] : [],
    ),
  );
};

function createRenderTool({
  ctx,
  name,
  type,
  description,
  specSchema,
}: {
  ctx: ChatToolContext;
  name: string;
  type: ChatVisualSpec['type'];
  description: string;
  specSchema: z.ZodType;
}) {
  return defineNativeTool({
    name,
    description,
    shape: { spec: specSchema },
    run: async ({ args }) => {
      const parsed = chatVisualSpecSchema.safeParse(args.spec);
      if (!parsed.success) return toolFailure({ text: parsed.error.issues.map((issue) => issue.message).join('; ') });

      const spec = parsed.data as ChatVisualSpec;
      if (spec.type !== type) return toolFailure({ text: `${name} takes a spec of type "${type}"` });

      if (ctx.state.visuals >= CHAT_VISUAL_LIMITS.maxPerMessage) {
        await ctx.notice({ key: 'chat.notices.visualLimit', params: { limit: CHAT_VISUAL_LIMITS.maxPerMessage } });
        return toolFailure({
          text: `This message already shows ${CHAT_VISUAL_LIMITS.maxPerMessage} visuals. Describe the rest in words.`,
        });
      }

      const refs = entityRefsOf({ spec });
      if (refs.length > 0) {
        const foreign = await findForeignEntities({ userId: ctx.run.user.id, refs });
        if (foreign.length > 0) {
          return toolFailure({
            text: `These table links name rows that are not the user's or cannot be linked: ${foreign
              .map(({ kind, id }) => `${kind} ${id}`)
              .join(', ')}. Use ids returned by the read tools, or plain text cells.`,
          });
        }
      }

      ctx.state.visuals++;
      await ctx.run.emit({ type: 'part.started', part: { type: 'visual', id: randomUUID(), spec } });
      return toolSuccess({ text: `The ${type} is shown to the user.` });
    },
  });
}

export function createRenderTools({ ctx }: { ctx: ChatToolContext }) {
  return [
    createRenderTool({
      ctx,
      name: 'render_chart',
      type: 'chart',
      description:
        'Show a chart in your answer. Numbers must come from tool results. Do not repeat the chart in words.',
      specSchema: chatChartSpecSchema,
    }),
    createRenderTool({
      ctx,
      name: 'render_table',
      type: 'table',
      description:
        'Show a table. Money columns need a currencyCode; an entity cell {kind, id} links only for ids from read tools.',
      specSchema: chatTableSpecSchema,
    }),
    createRenderTool({
      ctx,
      name: 'render_kpis',
      type: 'kpis',
      description: 'Show up to six key figures as tiles.',
      specSchema: chatKpisSpecSchema,
    }),
  ];
}
