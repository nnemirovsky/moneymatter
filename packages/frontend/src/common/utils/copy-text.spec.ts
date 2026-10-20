import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { copyText } from './copy-text';

const writeText = vi.fn();
const execCommand = vi.fn();

describe('copyText', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writeText.mockResolvedValue(undefined);
    execCommand.mockReturnValue(true);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('calls writeText synchronously, before anything is awaited', () => {
    const result = copyText({ text: 'code' });

    expect(writeText).toHaveBeenCalledWith('code');
    return result;
  });

  it('reports a copy through the clipboard API and never touches the fallback', async () => {
    expect(await copyText({ text: 'code' })).toBe(true);
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('falls back to execCommand when writeText rejects', async () => {
    writeText.mockRejectedValue(new Error('denied'));

    expect(await copyText({ text: 'code' })).toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  it('selects a read-only textarea holding the text for the fallback, and removes it after', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    let copied: HTMLTextAreaElement | null = null;
    execCommand.mockImplementation(() => {
      copied = document.querySelector('textarea');
      return true;
    });

    await copyText({ text: 'code' });

    expect(copied!.value).toBe('code');
    expect(copied!.readOnly).toBe(true);
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('falls back when the clipboard API is missing', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });

    expect(await copyText({ text: 'code' })).toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  it('reports a failure when the fallback is refused too', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    execCommand.mockReturnValue(false);

    expect(await copyText({ text: 'code' })).toBe(false);
  });

  it('reports a failure when the fallback throws', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    execCommand.mockImplementation(() => {
      throw new Error('unsupported');
    });

    expect(await copyText({ text: 'code' })).toBe(false);
    expect(document.querySelector('textarea')).toBeNull();
  });
});
