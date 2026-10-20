import type { ChatRunEvent } from '@bt/shared/types';

/**
 * Watches the events of a run for `toolCall` parts that opened and never closed. A CLI that is
 * stopped mid-call (cancel, timeout, a guard) leaves its call open, and the stored message must
 * not show it as running: `closeOpen` closes each with an error, and a late close of the call
 * itself, which finishes in the background, is dropped.
 */
export function createToolCallTracker({ emit }: { emit: (event: ChatRunEvent) => void | Promise<void> }) {
  const open = new Set<string>();
  const closed = new Set<string>();

  return {
    emit: async (event: ChatRunEvent): Promise<void> => {
      if (event.type === 'part.started' && event.part.type === 'toolCall') {
        open.add(event.part.id);
      } else if (event.type === 'part.updated') {
        if (closed.has(event.partId)) return;
        open.delete(event.partId);
      }

      await emit(event);
    },

    closeOpen: async (): Promise<void> => {
      const partIds = [...open];

      open.clear();
      for (const partId of partIds) closed.add(partId);

      await Promise.allSettled(
        partIds.map((partId) =>
          Promise.resolve(emit({ type: 'part.updated', partId, patch: { status: 'error', error: 'not finished' } })),
        ),
      );
    },
  };
}
