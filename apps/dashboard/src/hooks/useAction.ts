import { useCallback, useState } from 'react';
import { useToast } from '../components/Toast';

/**
 * Wrap a mutation: tracks which key is busy, shows the API error in a toast, and optionally a
 * success message. Returns the result, or undefined when the call failed.
 */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    async <T,>(key: string, fn: () => Promise<T>, success?: string | ((r: T) => string | undefined)): Promise<T | undefined> => {
      setBusy(key);
      try {
        const r = await fn();
        const msg = typeof success === 'function' ? success(r) : success;
        if (msg) toast.success(msg);
        return r;
      } catch (e) {
        toast.error(e);
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [toast],
  );
  return { busy, run };
}
