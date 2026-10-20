import { clearChatPresence, sendChatPresence } from '@/api/chat';
import { CHAT_PRESENCE_HEARTBEAT_MS } from '@bt/shared/types';
import { type Ref, computed, onScopeDispose, ref, watch } from 'vue';

const isDocumentVisible = () => document.visibilityState !== 'hidden';
const isWindowFocused = () => document.hasFocus();

/**
 * Tells the server which chat thread the user is looking at, so a finished reply or a new inbox item in a
 * thread that is already on screen does not also arrive as a push.
 *
 * The mark is sent when the thread appears and then every `CHAT_PRESENCE_HEARTBEAT_MS`, only while the
 * document is visible and the window has focus. A blur, a hidden tab, a switch to another thread and leaving
 * all end it, each with a `DELETE`, so a locked phone or another window gets its push straight away. A hung
 * page that cannot send the `DELETE` is covered by the server expiring the mark.
 */
export const useChatPresence = ({ threadId }: { threadId: Ref<string | null> }) => {
  const isVisible = ref(isDocumentVisible());
  const isFocused = ref(isWindowFocused());

  const watchedThreadId = computed(() => (isVisible.value && isFocused.value ? threadId.value : null));

  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let announcedThreadId: string | null = null;

  // Presence is a courtesy: a failed request must never reach the user or the console as an unhandled rejection.
  const beat = ({ id }: { id: string }) => {
    void sendChatPresence({ threadId: id }).catch(() => undefined);
  };

  const stop = () => {
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    if (announcedThreadId !== null) {
      void clearChatPresence({ threadId: announcedThreadId }).catch(() => undefined);
      announcedThreadId = null;
    }
  };

  watch(
    watchedThreadId,
    (id) => {
      stop();
      if (id === null) return;

      announcedThreadId = id;
      beat({ id });
      heartbeat = setInterval(() => beat({ id }), CHAT_PRESENCE_HEARTBEAT_MS);
    },
    { immediate: true },
  );

  const syncVisibility = () => {
    isVisible.value = isDocumentVisible();
    isFocused.value = isWindowFocused();
  };
  const onBlur = () => {
    isFocused.value = false;
  };
  const onFocus = () => {
    isFocused.value = true;
    isVisible.value = isDocumentVisible();
  };
  // A home-screen web app that is swiped away or backgrounded may fire only `pagehide`.
  const onPageHide = () => {
    isVisible.value = false;
  };

  document.addEventListener('visibilitychange', syncVisibility);
  window.addEventListener('focus', onFocus);
  window.addEventListener('blur', onBlur);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', syncVisibility);

  onScopeDispose(() => {
    document.removeEventListener('visibilitychange', syncVisibility);
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('pageshow', syncVisibility);
    stop();
  });
};
