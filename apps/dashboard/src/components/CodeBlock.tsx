import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cx } from '../lib/format';

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export function CopyButton({ text, label = 'Copy', className }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        if (await copyText(text)) {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }
      }}
      className={cx('inline-flex items-center gap-1 rounded border border-gray-300 bg-white px-2 py-0.5 text-xs font-medium text-gray-700 hover:bg-gray-50', className)}
    >
      {done ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
      {done ? 'Copied' : label}
    </button>
  );
}

export function CodeBlock({ code, title, maxHeight = '360px', className, copy = true }: { code: string; title?: string; maxHeight?: string; className?: string; copy?: boolean }) {
  return (
    <div className={cx('overflow-hidden rounded-md border border-gray-200 bg-gray-50', className)}>
      {(title || copy) && (
        <div className="flex items-center justify-between border-b border-gray-200 bg-white px-3 py-1.5">
          <span className="text-xs font-medium text-gray-500">{title}</span>
          {copy && <CopyButton text={code} />}
        </div>
      )}
      <pre className="overflow-auto p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] text-gray-800" style={{ maxHeight }}>
        {code}
      </pre>
    </div>
  );
}
