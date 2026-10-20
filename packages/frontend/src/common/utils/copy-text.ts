/**
 * Copies text to the clipboard and says whether it worked.
 *
 * `navigator.clipboard.writeText` is called before anything is awaited: iOS ties clipboard access to
 * the tap that started it and drops the permission after the first `await`. When it rejects (a
 * browser that refuses, a standalone web app without the permission), a hidden, read-only
 * `<textarea>` is selected and copied with `document.execCommand('copy')`. When that fails too, the
 * caller shows the text in a field the user can tap and hold.
 */
export const copyText = async ({ text }: { text: string }): Promise<boolean> => {
  let pending: Promise<void>;
  try {
    pending = navigator.clipboard.writeText(text);
  } catch (error) {
    pending = Promise.reject(error);
  }

  try {
    await pending;
    return true;
  } catch {
    return copyThroughSelection({ text });
  }
};

const copyThroughSelection = ({ text }: { text: string }): boolean => {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.readOnly = true;
  textarea.setAttribute('aria-hidden', 'true');
  // Off screen, but still rendered: iOS does not select the text of a `display: none` element.
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);

  try {
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, text.length);

    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
};
