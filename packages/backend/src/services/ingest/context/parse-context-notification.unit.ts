import { describe, expect, it } from '@jest/globals';

import { normalizeStore } from './normalize-store';
import { parseContextNotification } from './parse-context-notification';

const read = ({ title = '', subtitle = '', body = '' }: { title?: string; subtitle?: string; body?: string }) =>
  parseContextNotification({ title, subtitle, body });

describe('parseContextNotification', () => {
  it("reads the owner's Wolt sample whichever field holds the sentence", () => {
    const text = 'Urban Roastery&Coffee has accepted your order! It will be delivered at 11:52 AM.';

    expect(read({ title: 'Order confirmed!', body: text })).toEqual({
      store: 'Urban Roastery&Coffee',
      status: 'accepted',
    });
    expect(read({ body: `Order confirmed! — ${text}` })).toEqual({ store: 'Urban Roastery&Coffee', status: 'accepted' });
    expect(read({ title: 'Order confirmed! — Urban Roastery&Coffee has accepted your order!' })).toEqual({
      store: 'Urban Roastery&Coffee',
      status: 'accepted',
    });
  });

  it('keeps a dot inside a store name', () => {
    expect(read({ body: 'Mr. Coffee has accepted your order!' })).toEqual({ store: 'Mr. Coffee', status: 'accepted' });
  });

  it('reads the other stages with their store', () => {
    expect(read({ body: 'Your order from Pizza Planet is on its way' })).toEqual({
      store: 'Pizza Planet',
      status: 'onTheWay',
    });
    expect(read({ body: 'Your order from Pizza Planet has been delivered. Enjoy!' })).toEqual({
      store: 'Pizza Planet',
      status: 'delivered',
    });
    expect(read({ body: 'Pizza Planet has cancelled your order' })).toEqual({ store: 'Pizza Planet', status: 'cancelled' });
  });

  it('reads a status line that names no store as having none', () => {
    expect(read({ body: 'Your courier is on the way' })).toEqual({ store: null, status: 'onTheWay' });
    expect(read({ body: 'Your order has been delivered' })).toEqual({ store: null, status: 'delivered' });
  });

  it('returns null for a text no rule reads', () => {
    expect(read({ title: '20% off your next order', body: 'Use code PIZZA' })).toBeNull();
    expect(read({})).toBeNull();
  });
});

describe('normalizeStore', () => {
  it('treats two spellings of one store as equal', () => {
    expect(normalizeStore({ value: 'Urban Roastery&Coffee' })).toBe(normalizeStore({ value: 'urban roastery & coffee' }));
  });

  it('keeps different stores apart', () => {
    expect(normalizeStore({ value: 'Urban Roastery' })).not.toBe(normalizeStore({ value: 'Urban Bakery' }));
  });
});
