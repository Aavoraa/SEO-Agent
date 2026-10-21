import { lookup } from 'node:dns/promises';
import net from 'node:net';

/**
 * SSRF protection for every server-side request to a URL a user or file supplied (backlink sources,
 * webhook endpoints, onboarding detection): loopback, private, link-local and CGNAT ranges are refused.
 */
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateIp(v6.slice(7));
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

export async function assertPublicHost(url: string, allowPrivate: boolean) {
  if (allowPrivate) return;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) throw new Error('Private host not allowed');
  const addrs = net.isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (addrs.some(isPrivateIp)) throw new Error('Private address not allowed');
}
