import { Fragment, type ReactNode } from 'react';

/**
 * Tiny, safe Markdown renderer: headings, paragraphs, lists, blockquotes, fenced code, and inline
 * bold / italic / code / links. Output is built as React elements – raw HTML is never injected.
 * `[NEEDS INPUT …]` placeholders are highlighted so reviewers can't miss them.
 */
export function Markdown({ source, className }: { source: string; className?: string }) {
  return <div className={className ?? 'space-y-3 text-sm leading-relaxed text-gray-800'}>{parseBlocks(source)}</div>;
}

function safeHref(href: string): string | null {
  const h = href.trim();
  if (/^https?:\/\//i.test(h) || h.startsWith('/') || h.startsWith('#') || /^mailto:/i.test(h) || /^tel:/i.test(h)) return h;
  return null;
}

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\[NEEDS INPUT[^\]]*\])|(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${keyBase}-${i++}`;
    if (m[1]) out.push(<mark key={k} className="rounded bg-amber-100 px-1 text-amber-900">{tok}</mark>);
    else if (m[2]) out.push(<code key={k} className="rounded bg-gray-100 px-1 font-mono text-[0.85em]">{tok.slice(1, -1)}</code>);
    else if (m[3]) out.push(<strong key={k}>{inline(tok.slice(2, -2), k)}</strong>);
    else if (m[4]) out.push(<em key={k}>{inline(tok.slice(1, -1), k)}</em>);
    else if (m[5]) {
      const mm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)!;
      const href = safeHref(mm[2]!);
      out.push(
        href ? (
          <a key={k} href={href} target="_blank" rel="noopener noreferrer nofollow" className="link">
            {mm[1]}
          </a>
        ) : (
          <span key={k}>{mm[1]}</span>
        ),
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const hClass: Record<number, string> = {
  1: 'text-xl font-semibold text-gray-900 mt-2',
  2: 'text-lg font-semibold text-gray-900 mt-4',
  3: 'text-base font-semibold text-gray-900 mt-3',
  4: 'text-sm font-semibold text-gray-900',
  5: 'text-sm font-semibold text-gray-700',
  6: 'text-xs font-semibold text-gray-700 uppercase',
};

function parseBlocks(src: string): ReactNode[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const key = `b${k++}`;
    if (!line.trim()) {
      i++;
      continue;
    }
    if (line.trim().startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith('```')) buf.push(lines[i++]!);
      i++;
      out.push(
        <pre key={key} className="overflow-auto rounded-md bg-gray-50 p-3 font-mono text-xs">
          {buf.join('\n')}
        </pre>,
      );
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1]!.length;
      const Tag = `h${level}` as 'h1';
      out.push(
        <Tag key={key} className={hClass[level]}>
          {inline(h[2]!, key)}
        </Tag>,
      );
      i++;
      continue;
    }
    if (/^\s*([-*+])\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && (ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/).test(lines[i]!)) {
        items.push(lines[i]!.replace(ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/, ''));
        i++;
      }
      const L = ordered ? 'ol' : 'ul';
      out.push(
        <L key={key} className={ordered ? 'list-decimal space-y-1 pl-5' : 'list-disc space-y-1 pl-5'}>
          {items.map((it, j) => (
            <li key={j}>{inline(it, `${key}-${j}`)}</li>
          ))}
        </L>,
      );
      continue;
    }
    if (line.startsWith('>')) {
      const buf: string[] = [];
      while (i < lines.length && lines[i]!.startsWith('>')) buf.push(lines[i++]!.replace(/^>\s?/, ''));
      out.push(
        <blockquote key={key} className="border-l-2 border-gray-300 pl-3 text-gray-600">
          {inline(buf.join(' '), key)}
        </blockquote>,
      );
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      out.push(<hr key={key} className="border-gray-200" />);
      i++;
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,6}\s|```|>|\s*[-*+]\s+|\s*\d+[.)]\s+)/.test(lines[i]!)) buf.push(lines[i++]!);
    out.push(
      <p key={key}>
        {buf.map((b, j) => (
          <Fragment key={j}>
            {j > 0 && ' '}
            {inline(b, `${key}-${j}`)}
          </Fragment>
        ))}
      </p>,
    );
  }
  return out;
}
