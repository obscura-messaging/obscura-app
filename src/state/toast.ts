export type ToastType = 'success' | 'error';

export interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
}

let listener: ((t: ToastItem) => void) | null = null;
let counter = 0;

export function subscribeToast(fn: (t: ToastItem) => void): () => void {
  listener = fn;
  return () => {
    if (listener === fn) listener = null;
  };
}

function showToast(message: string, type: ToastType): void {
  if (!message) return;
  counter += 1;
  listener?.({ id: counter, message, type });
}

export const toast = {
  success: (message: string) => showToast(message, 'success'),
  error: (message: string) => showToast(message, 'error'),
};
