/** robots.txt parser implementing the common subset of RFC 9309 (groups, Allow/Disallow, * and $ wildcards, longest-match wins). */
export interface RobotsGroup {
  userAgents: string[];
  allow: string[];
  disallow: string[];
}

export interface ParsedRobots {
  groups: RobotsGroup[];
  sitemaps: string[];
}

export function parseRobots(text: string): ParsedRobots {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { userAgents: [], allow: [], disallow: [] };
        groups.push(current);
      }
      current.userAgents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === 'sitemap') {
      sitemaps.push(value);
    } else if (current && key === 'allow') {
      if (value) current.allow.push(value);
    } else if (current && key === 'disallow') {
      if (value) current.disallow.push(value);
    }
  }
  return { groups, sitemaps };
}

function patternToRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp('^' + body + (anchored ? '$' : ''));
}

export function groupFor(robots: ParsedRobots, userAgent: string): RobotsGroup | null {
  const ua = userAgent.toLowerCase();
  const specific = robots.groups.find((g) => g.userAgents.some((a) => a !== '*' && ua.includes(a)));
  return specific ?? robots.groups.find((g) => g.userAgents.includes('*')) ?? null;
}

export function isAllowed(robots: ParsedRobots, userAgent: string, pathWithQuery: string): boolean {
  const group = groupFor(robots, userAgent);
  if (!group) return true;
  let best: { len: number; allow: boolean } | null = null;
  for (const [list, allow] of [
    [group.allow, true],
    [group.disallow, false],
  ] as const) {
    for (const p of list) {
      if (patternToRegex(p).test(pathWithQuery)) {
        const len = p.length;
        if (!best || len > best.len || (len === best.len && allow)) best = { len, allow };
      }
    }
  }
  return best ? best.allow : true;
}

export function disallowsAll(robots: ParsedRobots, userAgent = 'googlebot'): boolean {
  return !isAllowed(robots, userAgent, '/');
}
