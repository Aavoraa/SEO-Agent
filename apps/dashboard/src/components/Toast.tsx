import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react';
import { ApiError } from '../api/client';
import { cx } from '../lib/format';

type ToastKind = 'success' | 'error' | 'info';
interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  correlationId?: string;
}
interface ToastApi {
  success: (message: string) => void;
  info: (message: string) => void;
  error: (err: unknown) => void;
}

const Ctx = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const remove = useCallback((id: number) => setItems((l) => l.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (t: Omit<ToastItem, 'id'>) => {
      const id = ++seq.current;
      setItems((l) => [...l.slice(-4), { ...t, id }]);
      setTimeout(() => remove(id), t.kind === 'error' ? 9000 : 4500);
    },
    [remove],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (message) => push({ kind: 'success', message }),
      info: (message) => push({ kind: 'info', message }),
      error: (err) => {
        if (err instanceof ApiError) push({ kind: 'error', message: err.message, correlationId: err.status >= 500 ? err.correlationId : undefined });
        else push({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      },
    }),
    [push],
  );

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
        {items.map((t) => (
          <div
            key={t.id}
            role={t.kind === 'error' ? 'alert' : 'status'}
            className={cx(
              'pointer-events-auto flex items-start gap-2.5 rounded-lg border bg-white px-3.5 py-3 text-sm shadow-lg',
              t.kind === 'error' ? 'border-red-200' : t.kind === 'success' ? 'border-emerald-200' : 'border-gray-200',
            )}
          >
            {t.kind === 'success' ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
            ) : t.kind === 'error' ? (
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
            ) : (
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-gray-500" />
            )}
            <div className="min-w-0 flex-1">
              <p className="break-words text-gray-800">{t.message}</p>
              {t.correlationId && <p className="mt-1 font-mono text-[11px] text-gray-400">Correlation ID: {t.correlationId}</p>}
            </div>
            <button onClick={() => remove(t.id)} className="text-gray-400 hover:text-gray-600" aria-label="Dismiss">
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const c = useContext(Ctx);
  if (!c) throw new Error('useToast outside ToastProvider');
  return c;
}
