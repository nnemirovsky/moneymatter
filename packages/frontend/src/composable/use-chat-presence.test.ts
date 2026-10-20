import { clearChatPresence, sendChatPresence } from '@/api/chat';
import { CHAT_PRESENCE_HEARTBEAT_MS } from '@bt/shared/types';
import { type VueWrapper, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, nextTick, ref } from 'vue';

import { useChatPresence } from './use-chat-presence';

vi.mock('@/api/chat', () => ({
  sendChatPresence: vi.fn(),
  clearChatPresence: vi.fn(),
}));

const threadId = ref<string | null>(null);

let visibilityState: DocumentVisibilityState = 'visible';
let hasFocus = true;

const mounted: VueWrapper[] = [];

const mountPresence = () => {
  const wrapper = mount(
    defineComponent({
      setup() {
        useChatPresence({ threadId });
        return () => null;
      },
    }),
  );
  mounted.push(wrapper);
  return wrapper;
};

const setVisibility = async ({ state }: { state: DocumentVisibilityState }) => {
  visibilityState = state;
  document.dispatchEvent(new Event('visibilitychange'));
  await nextTick();
};

const blur = async () => {
  hasFocus = false;
  window.dispatchEvent(new Event('blur'));
  await nextTick();
};

const focus = async () => {
  hasFocus = true;
  window.dispatchEvent(new Event('focus'));
  await nextTick();
};

describe('useChatPresence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(sendChatPresence).mockResolvedValue(undefined);
    vi.mocked(clearChatPresence).mockResolvedValue(undefined);
    visibilityState = 'visible';
    hasFocus = true;
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibilityState);
    vi.spyOn(document, 'hasFocus').mockImplementation(() => hasFocus);
    threadId.value = null;
  });

  afterEach(() => {
    for (const wrapper of mounted.splice(0)) wrapper.unmount();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('sends nothing while there is no thread', () => {
    mountPresence();

    vi.advanceTimersByTime(CHAT_PRESENCE_HEARTBEAT_MS * 3);

    expect(sendChatPresence).not.toHaveBeenCalled();
    expect(clearChatPresence).not.toHaveBeenCalled();
  });

  it('announces a visible, focused thread at once and then every heartbeat', () => {
    threadId.value = 't-1';
    mountPresence();

    expect(sendChatPresence).toHaveBeenCalledTimes(1);
    expect(sendChatPresence).toHaveBeenCalledWith({ threadId: 't-1' });

    vi.advanceTimersByTime(CHAT_PRESENCE_HEARTBEAT_MS - 1);
    expect(sendChatPresence).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    expect(sendChatPresence).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(CHAT_PRESENCE_HEARTBEAT_MS);
    expect(sendChatPresence).toHaveBeenCalledTimes(3);
  });

  it('beats every 20 seconds', () => {
    expect(CHAT_PRESENCE_HEARTBEAT_MS).toBe(20_000);
  });

  it('does not announce while the window is not focused', () => {
    hasFocus = false;
    threadId.value = 't-1';
    mountPresence();

    vi.advanceTimersByTime(CHAT_PRESENCE_HEARTBEAT_MS * 2);

    expect(sendChatPresence).not.toHaveBeenCalled();
  });

  it('does not announce while the page is hidden', () => {
    visibilityState = 'hidden';
    threadId.value = 't-1';
    mountPresence();

    vi.advanceTimersByTime(CHAT_PRESENCE_HEARTBEAT_MS * 2);

    expect(sendChatPresence).not.toHaveBeenCalled();
  });

  it('stops on blur, clears the mark and resumes on focus', async () => {
    threadId.value = 't-1';
    mountPresence();
    expect(sendChatPresence).toHaveBeenCalledTimes(1);

    await blur();

    expect(clearChatPresence).toHaveBeenCalledWith({ threadId: 't-1' });
    vi.advanceTimersByTime(CHAT_PRESENCE_HEARTBEAT_MS * 3);
    expect(sendChatPresence).toHaveBeenCalledTimes(1);

    await focus();

    expect(sendChatPresence).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(CHAT_PRESENCE_HEARTBEAT_MS);
    expect(sendChatPresence).toHaveBeenCalledTimes(3);
  });

  it('stops when the page is hidden and resumes when it is shown again', async () => {
    threadId.value = 't-1';
    mountPresence();

    await setVisibility({ state: 'hidden' });

    expect(clearChatPresence).toHaveBeenCalledWith({ threadId: 't-1' });
    vi.advanceTimersByTime(CHAT_PRESENCE_HEARTBEAT_MS * 3);
    expect(sendChatPresence).toHaveBeenCalledTimes(1);

    await setVisibility({ state: 'visible' });

    expect(sendChatPresence).toHaveBeenCalledTimes(2);
  });

  it('treats a page that is being put away as hidden', async () => {
    threadId.value = 't-1';
    mountPresence();

    window.dispatchEvent(new Event('pagehide'));
    await nextTick();

    expect(clearChatPresence).toHaveBeenCalledWith({ threadId: 't-1' });
    vi.advanceTimersByTime(CHAT_PRESENCE_HEARTBEAT_MS * 2);
    expect(sendChatPresence).toHaveBeenCalledTimes(1);
  });

  it('clears the mark and stops the heartbeat when the thread is left', () => {
    threadId.value = 't-1';
    const wrapper = mountPresence();

    wrapper.unmount();
    mounted.splice(0);

    expect(clearChatPresence).toHaveBeenCalledTimes(1);
    expect(clearChatPresence).toHaveBeenCalledWith({ threadId: 't-1' });
    vi.advanceTimersByTime(CHAT_PRESENCE_HEARTBEAT_MS * 3);
    expect(sendChatPresence).toHaveBeenCalledTimes(1);
  });

  it('moves the mark when the conversation switches to another thread', async () => {
    threadId.value = 't-1';
    mountPresence();

    threadId.value = 't-2';
    await nextTick();

    expect(clearChatPresence).toHaveBeenCalledWith({ threadId: 't-1' });
    expect(sendChatPresence).toHaveBeenLastCalledWith({ threadId: 't-2' });

    vi.advanceTimersByTime(CHAT_PRESENCE_HEARTBEAT_MS);
    expect(sendChatPresence).toHaveBeenLastCalledWith({ threadId: 't-2' });
    expect(vi.mocked(sendChatPresence).mock.calls.map(([call]) => call.threadId)).toEqual(['t-1', 't-2', 't-2']);
  });

  it('announces the thread a new conversation gets on its first message', async () => {
    mountPresence();
    expect(sendChatPresence).not.toHaveBeenCalled();

    threadId.value = 't-new';
    await nextTick();

    expect(sendChatPresence).toHaveBeenCalledWith({ threadId: 't-new' });
    expect(clearChatPresence).not.toHaveBeenCalled();
  });

  it('keeps going when a request is refused', async () => {
    vi.mocked(sendChatPresence).mockRejectedValue(new Error('404'));
    vi.mocked(clearChatPresence).mockRejectedValue(new Error('404'));
    threadId.value = 't-1';
    mountPresence();

    vi.advanceTimersByTime(CHAT_PRESENCE_HEARTBEAT_MS);
    await blur();
    await Promise.resolve();

    expect(sendChatPresence).toHaveBeenCalledTimes(2);
    expect(clearChatPresence).toHaveBeenCalledTimes(1);
  });

  it('stops listening to the page once it is unmounted', () => {
    threadId.value = 't-1';
    const wrapper = mountPresence();
    wrapper.unmount();
    mounted.splice(0);
    vi.mocked(sendChatPresence).mockClear();

    window.dispatchEvent(new Event('focus'));

    expect(sendChatPresence).not.toHaveBeenCalled();
  });
});
