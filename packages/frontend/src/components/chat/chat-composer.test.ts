import { uploadChatAttachment } from '@/api/chat';
import { ApiErrorResponseError } from '@/js/errors';
import { fitImageForUpload } from '@/pages/import-export/statement-parser/utils/fit-image-for-upload';
import { CHAT_ATTACHMENTS_PER_MESSAGE, type ChatAttachment } from '@bt/shared/types';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createChatI18n } from './cards/card-test-fixtures';
import ChatComposer from './chat-composer.vue';

vi.mock('@/api/chat', () => ({ uploadChatAttachment: vi.fn() }));
vi.mock('@/pages/import-export/statement-parser/utils/fit-image-for-upload', () => ({ fitImageForUpload: vi.fn() }));

const attachment = ({ id, fileName }: { id: string; fileName: string }): ChatAttachment => ({
  id,
  threadId: 'thread-1',
  messageId: null,
  fileName,
  mimeType: 'application/pdf',
  kind: 'pdf',
  sizeBytes: 100,
  pageCount: 1,
  excerpt: null,
  textTruncated: false,
  createdAt: '2026-03-05T10:00:00.000Z',
});

const mountComposer = (props: Partial<InstanceType<typeof ChatComposer>['$props']> = {}) =>
  mount(ChatComposer, {
    props: { isStreaming: false, ensureThread: vi.fn().mockResolvedValue('thread-1'), ...props },
    global: { plugins: [createChatI18n()], stubs: { DesktopOnlyTooltip: { template: '<div><slot /></div>' } } },
  });

const type = async ({ wrapper, text }: { wrapper: ReturnType<typeof mountComposer>; text: string }) =>
  wrapper.find('textarea').setValue(text);

const pick = async ({ wrapper, files }: { wrapper: ReturnType<typeof mountComposer>; files: File[] }) => {
  const input = wrapper.find('[data-testid="file-input"]');
  Object.defineProperty(input.element, 'files', { value: files, configurable: true });
  await input.trigger('change');
  await flushPromises();
};

const pdf = ({ name = 'statement.pdf', size = 1024 } = {}) => {
  const file = new File(['x'], name, { type: 'application/pdf' });
  Object.defineProperty(file, 'size', { value: size });
  return file;
};

const stubMatchMedia = ({ matches }: { matches: boolean }) => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  );
};

describe('ChatComposer', () => {
  describe('keyboard hint', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('shows the Enter / Shift+Enter hint with a fine pointer', () => {
      stubMatchMedia({ matches: false });

      expect(mountComposer().find('p').exists()).toBe(true);
    });

    it('hides the hint on touch devices without hover', () => {
      stubMatchMedia({ matches: true });

      expect(mountComposer().find('p').exists()).toBe(false);
    });
  });

  describe('Enter key', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('queries a coarse pointer, not the user agent', () => {
      stubMatchMedia({ matches: false });
      mountComposer();

      expect(vi.mocked(window.matchMedia)).toHaveBeenCalledWith('(pointer: coarse)');
    });

    it('inserts a new line instead of sending on a coarse pointer', async () => {
      stubMatchMedia({ matches: true });
      const wrapper = mountComposer();

      await type({ wrapper, text: 'Hello' });
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      wrapper.find('textarea').element.dispatchEvent(event);

      expect(wrapper.emitted('send')).toBeUndefined();
      expect(event.defaultPrevented).toBe(false);
      expect(wrapper.find('textarea').attributes('enterkeyhint')).toBe('enter');
    });

    it('still sends with the button on a coarse pointer', async () => {
      stubMatchMedia({ matches: true });
      const wrapper = mountComposer();

      await type({ wrapper, text: 'Hello' });
      await wrapper.find('[data-testid="send"]').trigger('click');

      expect(wrapper.emitted('send')).toHaveLength(1);
    });

    it('sends on Enter with a fine pointer and sets no enterkeyhint', async () => {
      stubMatchMedia({ matches: false });
      const wrapper = mountComposer();

      await type({ wrapper, text: 'Hello' });
      await wrapper.find('textarea').trigger('keydown', { key: 'Enter' });

      expect(wrapper.emitted('send')).toHaveLength(1);
      expect(wrapper.find('textarea').attributes('enterkeyhint')).toBeUndefined();
    });

    it('does not send on the Enter that confirms an IME composition', async () => {
      stubMatchMedia({ matches: false });
      const wrapper = mountComposer();

      await type({ wrapper, text: 'こんにちは' });
      await wrapper.find('textarea').trigger('keydown', { key: 'Enter', isComposing: true });

      expect(wrapper.emitted('send')).toBeUndefined();
    });
  });

  beforeEach(() => {
    vi.mocked(uploadChatAttachment).mockReset();
    vi.mocked(fitImageForUpload).mockReset();
  });

  describe('sending', () => {
    it('sends the trimmed text on Enter and clears the box', async () => {
      const wrapper = mountComposer();

      await type({ wrapper, text: '  How much did I spend?  ' });
      await wrapper.find('textarea').trigger('keydown', { key: 'Enter' });

      expect(wrapper.emitted('send')).toEqual([
        [{ text: 'How much did I spend?', attachmentIds: [], attachments: [] }],
      ]);
      expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('');
    });

    it('keeps a new line on Shift+Enter', async () => {
      const wrapper = mountComposer();

      await type({ wrapper, text: 'one' });
      await wrapper.find('textarea').trigger('keydown', { key: 'Enter', shiftKey: true });

      expect(wrapper.emitted('send')).toBeUndefined();
    });

    it('does not send an empty message', async () => {
      const wrapper = mountComposer();

      await type({ wrapper, text: '   ' });
      await wrapper.find('textarea').trigger('keydown', { key: 'Enter' });

      expect(wrapper.emitted('send')).toBeUndefined();
      expect(wrapper.find('[data-testid="send"]').attributes('disabled')).toBeDefined();
    });

    it('sends with the button', async () => {
      const wrapper = mountComposer();

      await type({ wrapper, text: 'Hello' });
      await wrapper.find('[data-testid="send"]').trigger('click');

      expect(wrapper.emitted('send')).toHaveLength(1);
    });

    it('shows a stop button instead of send while an answer streams', async () => {
      const wrapper = mountComposer({ isStreaming: true });

      expect(wrapper.find('[data-testid="send"]').exists()).toBe(false);

      await wrapper.find('[data-testid="stop"]').trigger('click');

      expect(wrapper.emitted('cancel')).toHaveLength(1);
    });

    it('offers send, not stop, once something is typed while an answer streams', async () => {
      const wrapper = mountComposer({ isStreaming: true });

      await type({ wrapper, text: 'Next question' });

      expect(wrapper.find('[data-testid="stop"]').exists()).toBe(false);
      expect(wrapper.find('[data-testid="send"]').attributes('disabled')).toBeUndefined();
    });

    it('goes back to stop when the box is emptied during a run', async () => {
      const wrapper = mountComposer({ isStreaming: true });

      await type({ wrapper, text: 'Next question' });
      await type({ wrapper, text: '' });

      expect(wrapper.find('[data-testid="stop"]').exists()).toBe(true);
    });

    it('emits a message written while an answer streams, for the parent to queue', async () => {
      const wrapper = mountComposer({ isStreaming: true });

      await type({ wrapper, text: 'Hello' });
      await wrapper.find('[data-testid="send"]').trigger('click');

      expect(wrapper.emitted('send')).toEqual([[{ text: 'Hello', attachmentIds: [], attachments: [] }]]);
    });

    it('swaps stop for send while an attachment is still uploading, but cannot send it yet', async () => {
      vi.mocked(uploadChatAttachment).mockReturnValue(new Promise(() => {}));
      const wrapper = mountComposer({ isStreaming: true });

      await pick({ wrapper, files: [pdf()] });

      expect(wrapper.find('[data-testid="stop"]').exists()).toBe(false);
      expect(wrapper.find('[data-testid="send"]').attributes('disabled')).toBeDefined();
    });

    it('sends the attachments with their names so a queued message can show them', async () => {
      vi.mocked(uploadChatAttachment).mockResolvedValue(attachment({ id: 'att-1', fileName: 'statement.pdf' }));
      const wrapper = mountComposer({ isStreaming: true });

      await pick({ wrapper, files: [pdf()] });
      await wrapper.find('[data-testid="send"]').trigger('click');

      expect(wrapper.emitted('send')).toEqual([
        [
          {
            text: '',
            attachmentIds: ['att-1'],
            attachments: [{ id: 'att-1', fileName: 'statement.pdf', sizeBytes: 100 }],
          },
        ],
      ]);
    });

    it('takes a queued message back into the box, in front of what is typed', async () => {
      const wrapper = mountComposer();

      await type({ wrapper, text: 'draft' });
      wrapper.vm.restore({ text: 'queued', attachments: [{ id: 'att-9', fileName: 'a.pdf', sizeBytes: 5 }] });
      await flushPromises();

      expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('queued\ndraft');
      expect(wrapper.findAll('[data-testid="attachment"]')).toHaveLength(1);

      await wrapper.find('[data-testid="send"]').trigger('click');

      expect(wrapper.emitted('send')).toEqual([
        [
          {
            text: 'queued\ndraft',
            attachmentIds: ['att-9'],
            attachments: [{ id: 'att-9', fileName: 'a.pdf', sizeBytes: 5 }],
          },
        ],
      ]);
    });

    it('locks the box when chat cannot answer', () => {
      const wrapper = mountComposer({ disabled: true });

      expect(wrapper.find('textarea').attributes('disabled')).toBeDefined();
    });
  });

  describe('layout', () => {
    it('is one 44px line when empty: the attach button, the textarea and the send button share a height', () => {
      const wrapper = mountComposer();

      expect(wrapper.find('[data-testid="attach"]').classes()).toContain('size-11');
      expect(wrapper.find('[data-testid="send"]').classes()).toContain('size-11');
      expect(wrapper.find('textarea').classes()).toContain('min-h-11');
      expect(wrapper.find('textarea').attributes('rows')).toBe('1');
    });

    it('keeps the buttons at the bottom as the textarea grows', () => {
      const row = mountComposer().find('[data-testid="send"]').element.parentElement!;

      expect(row.className).toContain('items-end');
    });

    it('has no page context chip: a conversation keeps its own in the header', () => {
      expect(mountComposer().find('[data-testid="context-chip"]').exists()).toBe(false);
    });
  });

  describe('attachments', () => {
    it('uploads a picked file to the thread and shows it', async () => {
      vi.mocked(uploadChatAttachment).mockResolvedValue(attachment({ id: 'att-1', fileName: 'statement.pdf' }));
      const ensureThread = vi.fn().mockResolvedValue('thread-9');
      const wrapper = mountComposer({ ensureThread });
      const file = pdf();

      await pick({ wrapper, files: [file] });

      expect(ensureThread).toHaveBeenCalledTimes(1);
      expect(uploadChatAttachment).toHaveBeenCalledWith({ threadId: 'thread-9', file, password: undefined });
      expect(wrapper.find('[data-testid="attachment"]').text()).toContain('statement.pdf');
    });

    it('sends the attachment ids, and lets a message carry only an attachment', async () => {
      vi.mocked(uploadChatAttachment).mockResolvedValue(attachment({ id: 'att-1', fileName: 'statement.pdf' }));
      const wrapper = mountComposer();
      await pick({ wrapper, files: [pdf()] });

      await wrapper.find('[data-testid="send"]').trigger('click');

      expect(wrapper.emitted('send')).toEqual([
        [
          {
            text: '',
            attachmentIds: ['att-1'],
            attachments: [{ id: 'att-1', fileName: 'statement.pdf', sizeBytes: 100 }],
          },
        ],
      ]);
      expect(wrapper.find('[data-testid="attachment"]').exists()).toBe(false);
    });

    it('removes an attachment before sending', async () => {
      vi.mocked(uploadChatAttachment).mockResolvedValue(attachment({ id: 'att-1', fileName: 'statement.pdf' }));
      const wrapper = mountComposer();
      await pick({ wrapper, files: [pdf()] });

      await wrapper.find('[data-testid="attachment-remove"]').trigger('click');

      expect(wrapper.find('[data-testid="attachment"]').exists()).toBe(false);
    });

    it('waits for an upload before it allows sending', async () => {
      let finish!: (value: ChatAttachment) => void;
      vi.mocked(uploadChatAttachment).mockReturnValue(new Promise((resolve) => (finish = resolve)));
      const wrapper = mountComposer();
      await type({ wrapper, text: 'Look at this' });

      await pick({ wrapper, files: [pdf()] });

      expect(wrapper.find('[data-testid="send"]').attributes('disabled')).toBeDefined();

      finish(attachment({ id: 'att-1', fileName: 'statement.pdf' }));
      await flushPromises();

      expect(wrapper.find('[data-testid="send"]').attributes('disabled')).toBeUndefined();
    });

    it('refuses files past the limit of one message and says so', async () => {
      vi.mocked(uploadChatAttachment).mockImplementation(async ({ file }) =>
        attachment({ id: file.name, fileName: file.name }),
      );
      const wrapper = mountComposer();
      const files = Array.from({ length: CHAT_ATTACHMENTS_PER_MESSAGE + 1 }, (_, index) =>
        pdf({ name: `f${index}.pdf` }),
      );

      await pick({ wrapper, files });

      expect(uploadChatAttachment).toHaveBeenCalledTimes(CHAT_ATTACHMENTS_PER_MESSAGE);
      expect(wrapper.findAll('[data-testid="attachment"]')).toHaveLength(CHAT_ATTACHMENTS_PER_MESSAGE);
      expect(wrapper.find('[data-testid="attachment-problem"]').text()).toBe(
        `You can attach up to ${CHAT_ATTACHMENTS_PER_MESSAGE} files to one message.`,
      );
    });

    it('refuses a file that is too large without uploading it', async () => {
      const wrapper = mountComposer();

      await pick({ wrapper, files: [pdf({ name: 'huge.pdf', size: 11 * 1024 * 1024 })] });

      expect(uploadChatAttachment).not.toHaveBeenCalled();
      expect(wrapper.find('[data-testid="attachment-problem"]').text()).toBe('huge.pdf is larger than 10 MB.');
    });

    it('uploads the converted JPEG for an iPhone HEIC photo', async () => {
      const converted = new File(['jpeg'], 'IMG_0001.jpg', { type: 'image/jpeg' });
      vi.mocked(fitImageForUpload).mockResolvedValue(converted);
      vi.mocked(uploadChatAttachment).mockResolvedValue(attachment({ id: 'att-1', fileName: 'IMG_0001.jpg' }));
      const wrapper = mountComposer();

      await pick({ wrapper, files: [new File(['heic'], 'IMG_0001.HEIC', { type: 'image/heic' })] });

      expect(uploadChatAttachment).toHaveBeenCalledWith({ threadId: 'thread-1', file: converted, password: undefined });
      expect(wrapper.find('[data-testid="attachment-problem"]').exists()).toBe(false);
    });

    it('says so when the browser cannot decode an image, without uploading it', async () => {
      vi.mocked(fitImageForUpload).mockRejectedValue(new Error('decode'));
      const wrapper = mountComposer();

      await pick({ wrapper, files: [new File(['heic'], 'IMG_0002.HEIC', { type: 'image/heic' })] });

      expect(uploadChatAttachment).not.toHaveBeenCalled();
      expect(wrapper.find('[data-testid="attachment-problem"]').text()).toContain(
        'IMG_0002.HEIC could not be read as an image',
      );
    });

    it('shows the reason the server refused a file', async () => {
      vi.mocked(uploadChatAttachment).mockRejectedValue(
        new ApiErrorResponseError('Unsupported file type.', {
          code: 'ValidationError',
          message: 'Unsupported file type.',
        } as never),
      );
      const wrapper = mountComposer();

      await pick({ wrapper, files: [pdf()] });

      expect(wrapper.find('[data-testid="attachment-problem"]').text()).toBe(
        'statement.pdf could not be attached: Unsupported file type.',
      );
    });

    it('says when a file could not be attached', async () => {
      vi.mocked(uploadChatAttachment).mockRejectedValue(new Error('network'));
      const wrapper = mountComposer();

      await pick({ wrapper, files: [pdf()] });

      expect(wrapper.find('[data-testid="attachment-problem"]').text()).toBe('statement.pdf could not be attached.');
      expect(wrapper.find('[data-testid="attachment"]').exists()).toBe(false);
    });

    it('asks for the password of a protected PDF and retries with it', async () => {
      vi.mocked(uploadChatAttachment)
        .mockRejectedValueOnce(
          new ApiErrorResponseError('This PDF is password-protected.', {
            code: 'ValidationError',
            message: 'This PDF is password-protected. Enter its password.',
          } as never),
        )
        .mockResolvedValueOnce(attachment({ id: 'att-1', fileName: 'statement.pdf' }));
      const wrapper = mountComposer();
      const file = pdf();

      await pick({ wrapper, files: [file] });
      await wrapper.find('[data-testid="attachment-password"] input').setValue('secret');
      await wrapper.find('[data-testid="attachment-unlock"]').trigger('click');
      await flushPromises();

      expect(uploadChatAttachment).toHaveBeenLastCalledWith({ threadId: 'thread-1', file, password: 'secret' });
      expect(wrapper.find('[data-testid="attachment"]').text()).toContain('statement.pdf');
      expect(wrapper.find('[data-testid="attachment-password"]').exists()).toBe(false);
    });
  });
});
