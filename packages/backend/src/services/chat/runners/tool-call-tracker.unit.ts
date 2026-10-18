import type { ChatRunEvent } from '@bt/shared/types';
import { describe, expect, it } from '@jest/globals';

import { createToolCallTracker } from './tool-call-tracker';

const opened = ({ id }: { id: string }): ChatRunEvent => ({
  type: 'part.started',
  part: { type: 'toolCall', id, callId: `call-${id}`, toolName: 'get_categories', args: {}, status: 'running' },
});
const closed = ({ id }: { id: string }): ChatRunEvent => ({
  type: 'part.updated',
  partId: id,
  patch: { status: 'ok' },
});

function setup() {
  const events: ChatRunEvent[] = [];
  const tracker = createToolCallTracker({ emit: (event) => void events.push(event) });

  return { events, tracker };
}

describe('createToolCallTracker', () => {
  it('passes every event through unchanged', async () => {
    const { events, tracker } = setup();

    await tracker.emit(opened({ id: 'a' }));
    await tracker.emit(closed({ id: 'a' }));

    expect(events).toEqual([opened({ id: 'a' }), closed({ id: 'a' })]);
  });

  it('closes a call that was left open with an error, and leaves the finished ones alone', async () => {
    const { events, tracker } = setup();

    await tracker.emit(opened({ id: 'done' }));
    await tracker.emit(closed({ id: 'done' }));
    await tracker.emit(opened({ id: 'left' }));
    await tracker.closeOpen();

    expect(events.slice(2)).toEqual([
      opened({ id: 'left' }),
      { type: 'part.updated', partId: 'left', patch: { status: 'error', error: 'not finished' } },
    ]);
  });

  it('drops the close that a call makes after it was closed for the run', async () => {
    const { events, tracker } = setup();

    await tracker.emit(opened({ id: 'left' }));
    await tracker.closeOpen();
    await tracker.emit(closed({ id: 'left' }));

    expect(events).toEqual([
      opened({ id: 'left' }),
      { type: 'part.updated', partId: 'left', patch: { status: 'error', error: 'not finished' } },
    ]);
  });

  it('does nothing when no call is open', async () => {
    const { events, tracker } = setup();

    await tracker.closeOpen();

    expect(events).toEqual([]);
  });
});
