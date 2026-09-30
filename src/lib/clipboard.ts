/**
 * Copy text to the system clipboard.
 *
 * `navigator.clipboard` is only defined in a secure context, so it is missing
 * when the app is served over plain http from something other than localhost —
 * a LAN dev host, a preview box reached by IP. The `execCommand('copy')`
 * fallback keeps the copy working there instead of failing on the one path a
 * developer is most likely to be on.
 *
 * Rejects when neither path succeeded, so callers can say so rather than
 * leaving the user to discover it at paste time.
 */
export async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Permission denied or a non-focused document — fall through and try
      // the synchronous path, which is not gated on the Permissions API.
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  // Keep it out of view and out of the tab order, but still selectable —
  // `display: none` and `hidden` make the selection (and so the copy) fail.
  textarea.setAttribute('readonly', '');
  textarea.setAttribute('aria-hidden', 'true');
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  try {
    textarea.select();
    if (!document.execCommand?.('copy')) {
      throw new Error('Copy to clipboard was refused');
    }
  } finally {
    textarea.remove();
  }
}

/**
 * Copy text that is not ready yet, from inside a click handler.
 *
 * A clipboard write is only permitted during the transient activation the
 * user's gesture grants, and awaiting anything that reaches the network spends
 * it: by the time the text arrives, Safari (and WebKit generally) refuses both
 * `writeText` and the `execCommand` fallback, and the gesture is gone. Handing
 * the *promise* to `ClipboardItem` is the mechanism designed for exactly this
 * — the write is authorized now and resolves when the text does.
 *
 * Callers should still prefer `copyTextToClipboard` with text already in hand;
 * this covers the press that races whatever is fetching it. Browsers that
 * reject a promise-valued `ClipboardItem` fall through to awaiting the text,
 * which is no worse than not trying.
 */
export async function copyPendingTextToClipboard(pending: Promise<string>): Promise<void> {
  if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': pending.then((text) => new Blob([text], { type: 'text/plain' })),
        }),
      ]);
      return;
    } catch {
      // No promise-valued ClipboardItem here (or the write was refused) —
      // fall through and try once the text has actually arrived.
    }
  }
  await copyTextToClipboard(await pending);
}
