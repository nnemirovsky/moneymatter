import { afterEach, describe, expect, it, vi } from 'vitest';

import { keepOpenForToast } from './toast-interaction';

const dispatchOutside = ({ target }: { target: Element }) => {
  const event = {
    detail: { originalEvent: { target } as unknown as Event },
    preventDefault: vi.fn(),
  };
  keepOpenForToast(event);

  return event;
};

describe('keepOpenForToast', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('keeps the modal open for a tap on a toast control', () => {
    document.body.innerHTML = '<ol data-sonner-toaster><li data-sonner-toast><button id="x"></button></li></ol>';

    const event = dispatchOutside({ target: document.getElementById('x')! });

    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it('lets any other outside interaction dismiss the modal', () => {
    document.body.innerHTML = '<main><button id="other"></button></main>';

    const event = dispatchOutside({
      target: document.getElementById('other')!,
    });

    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('ignores an event that has no element target', () => {
    const event = {
      detail: { originalEvent: { target: null } as unknown as Event },
      preventDefault: vi.fn(),
    };

    keepOpenForToast(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
