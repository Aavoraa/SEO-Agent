import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Spinner } from './ui';

export interface HeatPoint {
  selector: string | null;
  rx: number;
  ry: number;
  x: number;
  yr: number;
  n: number;
}
export interface ScrollReach {
  depth: number;
  reach: number;
}
export type ViewDevice = 'all' | 'desktop' | 'tablet' | 'mobile';

/** Screen the snapshot renders at, so `vh`-based sections look like they did for visitors. */
export const DEVICE_SCREEN: Record<ViewDevice, { w: number; h: number }> = {
  all: { w: 1280, h: 800 },
  desktop: { w: 1280, h: 800 },
  tablet: { w: 820, h: 1100 },
  mobile: { w: 390, h: 780 },
};
const OVERLAY_ID = '__heatmap_overlay';
const MAX_CANVAS_H = 16000;

let paletteCache: Uint8ClampedArray | null = null;
/** 256-step palette: blue → cyan → green → yellow → red. */
function palette(): Uint8ClampedArray {
  if (paletteCache) return paletteCache;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 1;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 256, 0);
  grad.addColorStop(0.0, 'rgb(0,0,255)');
  grad.addColorStop(0.25, 'rgb(0,200,255)');
  grad.addColorStop(0.5, 'rgb(0,230,60)');
  grad.addColorStop(0.75, 'rgb(255,230,0)');
  grad.addColorStop(1.0, 'rgb(255,20,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 1);
  paletteCache = g.getImageData(0, 0, 256, 1).data;
  return paletteCache;
}

export function reachAt(scroll: ScrollReach[], depth: number) {
  if (!scroll.length) return 0;
  const i = Math.min(scroll.length - 2, Math.max(0, Math.floor(depth * (scroll.length - 1))));
  const a = scroll[i]!;
  const b = scroll[i + 1] ?? a;
  const t = b.depth === a.depth ? 0 : (depth - a.depth) / (b.depth - a.depth);
  return a.reach + (b.reach - a.reach) * Math.max(0, Math.min(1, t));
}

/** Where a click lands: on the element it hit when that element exists in the snapshot, else the recorded page position. */
function place(doc: Document, p: HeatPoint, w: number, h: number) {
  const win = doc.defaultView;
  if (p.selector) {
    try {
      const el = doc.querySelector(p.selector);
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return { x: r.left + (win?.scrollX ?? 0) + p.rx * r.width, y: r.top + (win?.scrollY ?? 0) + p.ry * r.height, matched: true };
      }
    } catch {
      /* selector not valid in this document */
    }
  }
  return { x: p.x * w, y: p.yr * h, matched: false };
}

function drawClicks(g: CanvasRenderingContext2D, doc: Document, points: HeatPoint[], w: number, h: number) {
  if (!points.length) return 1;
  const max = Math.max(...points.map((p) => p.n));
  const radius = 20;
  let matched = 0;
  for (const p of points) {
    const at = place(doc, p, w, h);
    if (at.matched) matched++;
    const grad = g.createRadialGradient(at.x, at.y, 0, at.x, at.y, radius);
    grad.addColorStop(0, 'rgba(0,0,0,1)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.globalAlpha = Math.min(1, 0.15 + 0.85 * (p.n / max));
    g.fillStyle = grad;
    g.fillRect(at.x - radius, at.y - radius, radius * 2, radius * 2);
  }
  g.globalAlpha = 1;
  const img = g.getImageData(0, 0, w, h);
  const pal = palette();
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) {
    const a = d[i]!;
    if (!a) continue;
    const o = a * 4;
    d[i - 3] = pal[o]!;
    d[i - 2] = pal[o + 1]!;
    d[i - 1] = pal[o + 2]!;
    d[i] = Math.min(225, 70 + a);
  }
  g.putImageData(img, 0, 0);
  return matched / points.length;
}

function label(g: CanvasRenderingContext2D, text: string, x: number, y: number) {
  g.font = '600 13px system-ui, -apple-system, Segoe UI, sans-serif';
  g.fillStyle = 'rgba(17,24,39,0.88)';
  g.fillRect(x, y, g.measureText(text).width + 16, 22);
  g.fillStyle = '#fff';
  g.fillText(text, x + 8, y + 15);
}

function drawScroll(g: CanvasRenderingContext2D, scroll: ScrollReach[], w: number, h: number, fold: number | null) {
  const pal = palette();
  const step = Math.max(2, Math.round(h / 500));
  for (let y = 0; y < h; y += step) {
    const o = Math.round(reachAt(scroll, y / h) * 255) * 4;
    g.fillStyle = `rgba(${pal[o]},${pal[o + 1]},${pal[o + 2]},0.42)`;
    g.fillRect(0, y, w, step);
  }
  for (const pct of [0.75, 0.5, 0.25]) {
    let y = 0;
    for (let d = 0; d <= 1.0001; d += 0.0025) if (reachAt(scroll, d) >= pct) y = d * h;
    if (y <= 0 || y >= h - 4) continue;
    g.fillStyle = 'rgba(17,24,39,0.85)';
    g.fillRect(0, y - 1, w, 2);
    label(g, `${Math.round(pct * 100)}% of visitors scrolled this far`, 8, y - 24);
  }
  if (fold && fold < 1) {
    const y = fold * h;
    g.setLineDash([8, 6]);
    g.strokeStyle = 'rgba(255,255,255,0.95)';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(w, y);
    g.stroke();
    g.setLineDash([]);
    label(g, 'Average fold', Math.max(8, w - 120), y + 4);
  }
}

/**
 * Page snapshot (scripts removed server-side; iframe sandboxed without scripts) at the device's screen
 * size, scaled to fit. The heat layer is an image placed inside the snapshot document so it scrolls with
 * the page; it also swallows clicks so links in the snapshot can't navigate.
 */
export function HeatmapViewer({ html, mode, points, scroll, fold, device, onMatchRate }: { html: string; mode: 'click' | 'scroll'; points: HeatPoint[]; scroll: ScrollReach[]; fold: number | null; device: ViewDevice; onMatchRate?: (r: number) => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const overlayUrl = useRef<string | null>(null);
  const [box, setBox] = useState(900);
  const [loaded, setLoaded] = useState(false);
  const screen = DEVICE_SCREEN[device];

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox(el.clientWidth));
    ro.observe(el);
    setBox(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => setLoaded(false), [html, device]);

  const draw = useCallback(() => {
    const doc = frame.current?.contentDocument;
    if (!doc?.documentElement || !doc.body) return;
    const w = Math.max(doc.documentElement.scrollWidth, screen.w);
    const h = Math.min(MAX_CANVAS_H, Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight, screen.h));
    // Drawn on a canvas here and shown in the snapshot as an <img>: a script-less sandboxed frame
    // doesn't repaint canvases, but it does display images.
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    if (mode === 'click') onMatchRate?.(drawClicks(g, doc, points, w, h));
    else drawScroll(g, scroll, w, h, fold);
    let img = doc.getElementById(OVERLAY_ID) as HTMLImageElement | null;
    if (!img) {
      img = doc.createElement('img');
      img.id = OVERLAY_ID;
      img.alt = '';
      img.setAttribute('style', 'position:absolute;left:0;top:0;z-index:2147483647;pointer-events:auto;cursor:default;max-width:none;user-select:none');
      doc.documentElement.appendChild(img);
    }
    const target = img;
    target.style.width = `${w}px`;
    target.style.height = `${h}px`;
    c.toBlob((blob) => {
      if (!blob) return;
      if (overlayUrl.current) URL.revokeObjectURL(overlayUrl.current);
      overlayUrl.current = URL.createObjectURL(blob);
      target.src = overlayUrl.current;
    });
  }, [mode, points, scroll, fold, screen.w, screen.h, onMatchRate]);

  useEffect(() => () => {
    if (overlayUrl.current) URL.revokeObjectURL(overlayUrl.current);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    draw();
    // late fonts / images move things: redraw once they have settled
    const t = setTimeout(draw, 1200);
    return () => clearTimeout(t);
  }, [loaded, draw]);

  const scale = Math.min(1, box / screen.w);
  return (
    <div ref={wrap} className="relative w-full">
      {!loaded && (
        <div className="absolute inset-x-0 top-10 z-10 flex justify-center">
          <span className="flex items-center gap-2 rounded bg-white px-3 py-1.5 text-sm text-gray-600 shadow">
            <Spinner /> Rendering page…
          </span>
        </div>
      )}
      <div className="mx-auto overflow-hidden rounded-md border border-gray-300 bg-white shadow-sm" style={{ width: screen.w * scale, height: screen.h * scale }}>
        <iframe
          key={`${device}-${html.length}`}
          ref={frame}
          title="Page snapshot with heatmap"
          sandbox="allow-same-origin"
          srcDoc={html}
          onLoad={() => setLoaded(true)}
          className="origin-top-left border-0"
          style={{ width: screen.w, height: screen.h, transform: `scale(${scale})` }}
        />
      </div>
    </div>
  );
}
