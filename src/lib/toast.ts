export function showToast(message: string) {
  window.dispatchEvent(new CustomEvent('kinetix:toast', {
    detail: { message },
  }));
}
