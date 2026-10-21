import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import rrwebPlayer from 'rrweb-player';
import 'rrweb-player/dist/style.css';

/** rrweb event types used by the dashboard (see @rrweb/types). */
export interface RrEvent {
  type: number;
  timestamp: number;
  data?: { source?: number; type?: number; tag?: string; href?: string; width?: number; height?: number; payload?: { label?: string | null; message?: string } };
}

export const MARKER_COLORS: Record<string, string> = {
  'rage-click': '#dc2626',
  'dead-click': '#d97706',
  error: '#7c3aed',
};

export interface PlayerHandle {
  goto: (offsetMs: number) => void;
}

/**
 * Replays an rrweb session (Clarity-style: skip inactivity, speed, timeline with rage/dead/error markers).
 * The recorded page is rebuilt inside rrweb's sandboxed iframe; scripts from the recorded site never run.
 */
export const RecordingPlayer = forwardRef<PlayerHandle, { events: RrEvent[]; onTime?: (offsetMs: number) => void }>(function RecordingPlayer({ events, onTime }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const player = useRef<InstanceType<typeof rrwebPlayer> | null>(null);
  const onTimeRef = useRef(onTime);
  onTimeRef.current = onTime;

  useImperativeHandle(ref, () => ({ goto: (ms) => player.current?.goto(Math.max(0, ms), true) }), []);

  useEffect(() => {
    const el = host.current;
    if (!el || events.length < 2) return;
    const meta = events.find((e) => e.type === 4)?.data;
    const size = () => {
      const w = el.clientWidth;
      const ratio = meta?.width && meta?.height ? meta.height / meta.width : 0.625;
      return { width: w, height: Math.min(Math.round(w * ratio), Math.round(window.innerHeight * 0.66)) };
    };
    el.innerHTML = '';
    const p = new rrwebPlayer({
      target: el,
      props: {
        events: events as never,
        ...size(),
        autoPlay: true,
        skipInactive: true,
        speedOption: [1, 2, 4, 8],
        showController: true,
        tags: MARKER_COLORS,
        mouseTail: { strokeStyle: '#f97316', lineWidth: 2, duration: 600 },
        UNSAFE_replayCanvas: false,
      },
    });
    player.current = p;
    p.addEventListener('ui-update-current-time', (e) => onTimeRef.current?.((e as { payload: number }).payload));
    let lastWidth = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === lastWidth) return; // the player's own height changes also land here
      lastWidth = el.clientWidth;
      const s = size();
      (p as unknown as { $set: (v: object) => void }).$set(s);
      p.triggerResize();
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      try {
        p.pause();
        (p as unknown as { $destroy: () => void }).$destroy();
      } catch {
        /* already gone */
      }
      player.current = null;
    };
  }, [events]);

  // rrweb-player floats its root; flow-root keeps it inside this box
  return <div ref={host} className="recording-player flow-root w-full" />;
});
