import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('@models/ingest-requests.model', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('@models/notification-sources.model', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('@services/ingest/source-icons/source-icon-cache', () => ({ refreshDueSourceIcons: jest.fn() }));

import IngestRequests from '@models/ingest-requests.model';
import NotificationSources from '@models/notification-sources.model';
import { refreshDueSourceIcons } from '@services/ingest/source-icons/source-icon-cache';

import { withNotificationSources } from './card-sources';

const findSources = jest.mocked(NotificationSources.findAll);
const findRequests = jest.mocked(IngestRequests.findAll);

const row = (toolName: string, args: Record<string, unknown>) => ({ toolName, args }) as never;
const card = (id: number) => ({ id }) as never;

const source = {
  id: 'src-1',
  appName: 'Example Notes',
  bundleId: null,
  resolvedBundleId: 'com.example.notes',
  sender: 'ExampleSender',
  iconUrl: 'https://cdn.example.com/i.jpg',
};

describe('withNotificationSources', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    findSources.mockResolvedValue([source] as never);
    findRequests.mockResolvedValue([]);
  });

  it('attaches the source display to a source update card, and starts the icon lookup for it', async () => {
    const cards = await withNotificationSources({
      userId: 1,
      rows: [row('set_notification_source', { sourceId: 'src-1' })],
      cards: [card(1)],
    });

    expect(cards[0]).toMatchObject({
      id: 1,
      source: {
        appName: 'Example Notes',
        bundleId: 'com.example.notes',
        sender: 'ExampleSender',
        iconUrl: 'https://cdn.example.com/i.jpg',
      },
    });
    expect(refreshDueSourceIcons).toHaveBeenCalledWith({ sources: [source] });
  });

  it('attaches the source of the request to a parked payment card', async () => {
    findRequests.mockResolvedValue([{ id: 'req-1', sourceId: 'src-1' }] as never);

    const cards = await withNotificationSources({
      userId: 1,
      rows: [row('log_ingest_request', { requestId: 'req-1' })],
      cards: [card(1)],
    });

    expect(cards[0]).toMatchObject({ source: { appName: 'Example Notes' } });
  });

  it('leaves the card of any other tool as it is, without a query', async () => {
    const cards = await withNotificationSources({
      userId: 1,
      rows: [row('create_transaction', { sourceId: 'src-1' })],
      cards: [card(1)],
    });

    expect(cards[0]).toEqual({ id: 1 });
    expect(findSources).not.toHaveBeenCalled();
  });

  it('leaves a card whose source is gone as it is', async () => {
    findSources.mockResolvedValue([]);

    const cards = await withNotificationSources({
      userId: 1,
      rows: [row('set_notification_source', { sourceId: 'src-1' })],
      cards: [card(1)],
    });

    expect(cards[0]).toEqual({ id: 1 });
  });
});
