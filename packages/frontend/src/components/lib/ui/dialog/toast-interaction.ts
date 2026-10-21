/** The list sonner renders its toasts into, a sibling of the app's modal layers rather than a child. */
const TOASTER_SELECTOR = '[data-sonner-toaster]';

interface OutsideInteractionEvent {
  detail: { originalEvent: Event };
  preventDefault: () => void;
}

/**
 * Handler for a modal content's `interact-outside`: a tap on a toast, or the focus it takes, lands
 * outside the modal, which would dismiss it. The toast is a notification raised from inside the
 * modal, so interacting with it leaves the modal open.
 */
export const keepOpenForToast = (event: OutsideInteractionEvent) => {
  const target = event.detail.originalEvent.target;
  if (target instanceof Element && target.closest(TOASTER_SELECTOR)) event.preventDefault();
};
