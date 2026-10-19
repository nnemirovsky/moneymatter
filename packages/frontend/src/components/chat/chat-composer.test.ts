import { uploadChatAttachment } from '@/api/chat';
import { ApiErrorResponseError } from '@/js/errors';
import { CHAT_ATTACHMENTS_PER_MESSAGE, type ChatAttachment, type ChatPageContext } from '@bt/shared/types';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createChatI18n } from './cards/card-test-fixtures';
import ChatComposer from './chat-composer.vue';

vi.mock('@/api/chat', () => ({ uploadChatAttachment: vi.fn() }));
vi.mock('./chat-context-label', () => ({
  useChatContextLabel: () => ({
    label: ({ context }: { context: ChatPageContext }) => (context.entity ? 'Account: Main card' : null),
  }),
}));

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

const ACCOUNT_CONTEXT: ChatPageContext = { route: 'dashboard.account', entity: { kind: 'account', id: 'a1' } };

const mountComposer = (props: Partial<InstanceType<typeof ChatComposer>['$props']> = {}, slots = {}) =>
  mount(ChatComposer, {
    slots,
    props: {
      isStreaming: false,
      context: null,
      ensureThread: vi.fn().mockResolvedValue('thread-1'),
      ...props,
    },
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

describe('ChatComposer', () => {
  beforeEach(() => {
    vi.mocked(uploadChatAttachment).mockReset();
  });

  describe('sending', () => {
    it('sends the trimmed text on Enter and clears the box', async () => {
      const wrapper = mountComposer();

      await type({ wrapper, text: '  How much did I spend?  ' });
      await wrapper.find('textarea').trigger('keydown', { key: 'Enter' });

      expect(wrapper.emitted('send')).toEqual([[{ text: 'How much did I spend?', attachmentIds: [] }]]);
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

    it('does not send while an answer streams', async () => {
      const wrapper = mountComposer({ isStreaming: true });

      await type({ wrapper, text: 'Hello' });
      await wrapper.find('textarea').trigger('keydown', { key: 'Enter' });

      expect(wrapper.emitted('send')).toBeUndefined();
    });

    it('locks the box when chat cannot answer', () => {
      const wrapper = mountComposer({ disabled: true });

      expect(wrapper.find('textarea').attributes('disabled')).toBeDefined();
    });
  });

  describe('page context', () => {
    it('shows what the chat sees as a chip', () => {
      const wrapper = mountComposer({ context: ACCOUNT_CONTEXT });

      expect(wrapper.find('[data-testid="context-chip"]').text()).toContain('Account: Main card');
    });

    it('has no chip for a page that tells nothing', () => {
      expect(
        mountComposer({ context: { route: 'dashboard.settings.general' } })
          .find('[data-testid="context-chip"]')
          .exists(),
      ).toBe(false);
    });

    it('sends the context with the message', async () => {
      const wrapper = mountComposer({ context: ACCOUNT_CONTEXT });

      await type({ wrapper, text: 'Hello' });
      await wrapper.find('[data-testid="send"]').trigger('click');

      expect(wrapper.emitted('send')).toEqual([[{ text: 'Hello', attachmentIds: [], pageContext: ACCOUNT_CONTEXT }]]);
    });

    it('drops the context when the chip is removed', async () => {
      const wrapper = mountComposer({ context: ACCOUNT_CONTEXT });

      await wrapper.find('[data-testid="context-remove"]').trigger('click');
      await type({ wrapper, text: 'Hello' });
      await wrapper.find('[data-testid="send"]').trigger('click');

      expect(wrapper.find('[data-testid="context-chip"]').exists()).toBe(false);
      expect(wrapper.emitted('send')).toEqual([[{ text: 'Hello', attachmentIds: [] }]]);
    });

    it('shows the chip again for the context of another page', async () => {
      const wrapper = mountComposer({ context: ACCOUNT_CONTEXT });
      await wrapper.find('[data-testid="context-remove"]').trigger('click');

      await wrapper.setProps({ context: { route: 'dashboard.account', entity: { kind: 'account', id: 'a2' } } });

      expect(wrapper.find('[data-testid="context-chip"]').exists()).toBe(true);
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

      expect(wrapper.emitted('send')).toEqual([[{ text: '', attachmentIds: ['att-1'] }]]);
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

  describe('connection slot', () => {
    it('puts the connection picker above the page context and the message box', () => {
      const wrapper = mountComposer({ context: ACCOUNT_CONTEXT }, { connection: '<div data-testid="picker-slot" />' });

      const html = wrapper.html();
      expect(html.indexOf('picker-slot')).toBeGreaterThan(-1);
      expect(html.indexOf('picker-slot')).toBeLessThan(html.indexOf('context-chip'));
      expect(html.indexOf('picker-slot')).toBeLessThan(html.indexOf('<textarea'));
    });

    it('adds no empty row without a picker', () => {
      expect(mountComposer().find('[data-testid="picker-slot"]').exists()).toBe(false);
    });
  });
});
