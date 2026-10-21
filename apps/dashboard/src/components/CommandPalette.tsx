import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CornerDownLeft, Search } from 'lucide-react';
import { api } from '../api/client';
import type { SearchResults } from '../api/types';
import { useAuth } from '../context/auth';
import { useProject } from '../context/project';
import { useToast } from './Toast';
import { cx } from '../lib/format';

interface Command {
  id: string;
  label: string;
  hint: string;
  group: 'Actions' | 'Go to';
  run: () => void | Promise<void>;
  editor?: boolean;
}

/**
 * Ctrl/Cmd+K: commands + global search. "/" opens it straight into search.
 * Actions reuse the same API as the buttons (job runs), so permissions are enforced server-side.
 */
export function CommandPalette() {
  const nav = useNavigate();
  const { canEdit } = useAuth();
  const { base } = useProject();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResults | null>(null);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /input|textarea|select/i.test((e.target as HTMLElement)?.tagName ?? '') || (e.target as HTMLElement)?.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === '/' && !typing && !open) {
        e.preventDefault();
        setOpen(true);
      } else if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (open) {
      setQ('');
      setResults(null);
      setActive(0);
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => {
    if (!open || !base || q.trim().length < 2) {
      setResults(null);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      api<SearchResults>(`${base}/search`, { query: { q }, signal: ctrl.signal }).then(setResults).catch(() => undefined);
    }, 180);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q, open, base]);

  const job = (type: string, label: string, body: Record<string, unknown> = {}) => async () => {
    try {
      await api(`${base}/jobs/${type}`, { body });
      toast.success(`${label} started – results appear when it finishes`);
    } catch (e) {
      toast.error(e);
    }
  };
  const go = (to: string) => () => nav(to);
  const commands: Command[] = useMemo(
    () => [
      { id: 'audit', label: 'Run audit', hint: 'Crawl the site and re-score it', group: 'Actions', run: job('seo-audit', 'Audit', { device: 'desktop' }), editor: true },
      { id: 'opps', label: 'Refresh opportunities', hint: 'Re-rank every opportunity', group: 'Actions', run: job('opportunities', 'Opportunity refresh'), editor: true },
      { id: 'report', label: 'Generate report', hint: 'Build the SEO health report', group: 'Actions', run: job('initial-report', 'Report'), editor: true },
      { id: 'competitor', label: 'Add competitor', hint: 'Competitors', group: 'Actions', run: go('/competitors'), editor: true },
      { id: 'keyword', label: 'Find keyword', hint: 'Keywords', group: 'Actions', run: go('/keywords') },
      { id: 'optimize', label: 'Optimize page', hint: 'SEO Audit → quick wins → Fix with AI', group: 'Actions', run: go('/audit') },
      { id: 'approvals', label: 'Open approvals', hint: 'Approvals', group: 'Actions', run: go('/approvals') },
      { id: 'deploy', label: 'Deploy change', hint: 'Deployments & Changes', group: 'Actions', run: go('/changes?filter=approved') },
      { id: 'rollback', label: 'Roll back a change', hint: 'Deployments & Changes', group: 'Actions', run: go('/changes?filter=live') },
      { id: 'experiment', label: 'Create experiment', hint: 'Experiments', group: 'Actions', run: go('/experiments') },
      { id: 'website', label: 'Add website', hint: 'Onboarding', group: 'Actions', run: go('/onboarding') },
      { id: 'cc', label: 'Command Center', hint: 'Next best action', group: 'Go to', run: go('/') },
      { id: 'o', label: 'Opportunities', hint: '', group: 'Go to', run: go('/opportunities') },
      { id: 'a', label: 'SEO Audit', hint: '', group: 'Go to', run: go('/audit') },
      { id: 'c', label: 'Deployments & Changes', hint: '', group: 'Go to', run: go('/changes') },
      { id: 'b', label: 'Backlinks', hint: '', group: 'Go to', run: go('/backlinks') },
      { id: 'hm', label: 'Heatmaps', hint: 'Clicks and scroll depth', group: 'Go to', run: go('/heatmaps') },
      { id: 'rec', label: 'Recordings', hint: 'Session replays', group: 'Go to', run: go('/recordings') },
      { id: 'ai', label: 'AI Search', hint: '', group: 'Go to', run: go('/ai-readiness') },
      { id: 'org', label: 'Organization', hint: 'Members, plan, webhooks', group: 'Go to', run: go('/organization') },
      { id: 's', label: 'Settings', hint: '', group: 'Go to', run: go('/settings') },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base],
  );
  const term = q.trim().toLowerCase();
  const shown = commands.filter((c) => (!c.editor || canEdit) && (!term || `${c.label} ${c.hint}`.toLowerCase().includes(term)));
  const searchItems = (results?.groups ?? []).flatMap((g) => g.items.map((i) => ({ ...i, group: g.label })));
  const all = [...shown.map((c) => ({ key: c.id, label: c.label, hint: c.hint, group: c.group, run: c.run })), ...searchItems.map((i) => ({ key: `${i.group}-${i.id}`, label: i.title, hint: i.subtitle, group: i.group, run: go(i.href) }))];
  const choose = async (idx: number) => {
    const item = all[idx];
    if (!item) return;
    setOpen(false);
    await item.run();
  };
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-gray-900/30 px-4 pt-[12vh]" onClick={() => setOpen(false)}>
      <div className="w-full max-w-xl overflow-hidden rounded-lg border border-gray-200 bg-white shadow-xl" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Command palette">
        <div className="flex items-center gap-2 border-b border-gray-100 px-3">
          <Search className="h-4 w-4 text-gray-400" />
          <input
            ref={input}
            className="h-11 flex-1 text-sm outline-none"
            placeholder="Search pages, keywords, issues… or type a command"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(all.length - 1, a + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                choose(active);
              }
            }}
          />
          <kbd className="rounded border border-gray-200 px-1.5 text-[10px] text-gray-500">Esc</kbd>
        </div>
        <ul className="max-h-[60vh] overflow-auto py-1">
          {all.map((item, i) => (
            <li key={item.key}>
              {(i === 0 || all[i - 1]!.group !== item.group) && <div className="px-3 pt-2 pb-1 text-[10px] font-semibold tracking-wider text-gray-400 uppercase">{item.group}</div>}
              <button className={cx('flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm', i === active ? 'bg-brand-50 text-brand-900' : 'text-gray-800 hover:bg-gray-50')} onMouseEnter={() => setActive(i)} onClick={() => choose(i)}>
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.hint && <span className="max-w-[45%] truncate text-xs text-gray-400">{item.hint}</span>}
                {i === active && <CornerDownLeft className="h-3.5 w-3.5 text-gray-400" />}
              </button>
            </li>
          ))}
          {!all.length && <li className="px-3 py-6 text-center text-sm text-gray-500">Nothing found.</li>}
        </ul>
        <div className="border-t border-gray-100 px-3 py-1.5 text-[11px] text-gray-400">↑↓ to move · Enter to open · Ctrl/⌘K to toggle · / to search</div>
      </div>
    </div>
  );
}
