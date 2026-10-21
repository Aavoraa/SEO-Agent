/**
 * hm.js – the first-party heatmap + session-recording tracker, served by the API at /hm.js.
 *
 *   <script src="https://<api>/hm.js" data-key="hm_…" defer></script>
 *
 * Heatmaps: clicks (element CSS path + offset inside the element, rage/dead flags) and the deepest scroll
 * point of each page view.
 * Recordings (when enabled for the project): loads /rr.js (rrweb, MIT) and records the page with every
 * input masked (all text too in "strict" mode); elements marked data-hm-block are not recorded, data-hm-mask
 * text is masked. The session id lives in the tab's sessionStorage (30 min idle timeout) – no cookies.
 * No IP use, no form values or typed text. Honours Do Not Track and Global Privacy Control.
 * The element-path algorithm must stay identical to `cssPath` in demo/heatmaps.ts.
 */
export const TRACKER_JS = String.raw`(function () {
  'use strict';
  var s = document.currentScript;
  if (!s || window.__seoHeatmap) return;
  window.__seoHeatmap = 1;
  var key = s.getAttribute('data-key');
  if (!key || navigator.doNotTrack === '1' || window.doNotTrack === '1' || navigator.globalPrivacyControl === true) return;
  var origin = new URL(s.src).origin;
  var endpoint = origin + '/api/collect';
  var vid = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  var queue = [], clicks = 0, depth = 0, sentDepth = -1, recent = [];
  var INTERACTIVE = 'a,button,input,select,textarea,label,summary,[role=button],[role=link],[onclick]';
  var rec = null, recBuf = [], recSize = 0, recSeq = 0, sess = null;

  function device() { var w = window.innerWidth; return w < 768 ? 'mobile' : w < 1024 ? 'tablet' : 'desktop'; }
  function docH() { var d = document.documentElement, b = document.body; return Math.max(d.scrollHeight, b ? b.scrollHeight : 0, d.clientHeight) || 1; }
  function docW() { return Math.max(document.documentElement.scrollWidth, window.innerWidth) || 1; }
  function cssPath(el) {
    var parts = [];
    while (el && el.nodeType === 1) {
      if (el === document.body) return 'body>' + parts.join('>');
      if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) { parts.unshift('#' + el.id); return parts.join('>'); }
      if (parts.length >= 14) return null;
      var i = 1, sib = el;
      while ((sib = sib.previousElementSibling)) if (sib.tagName === el.tagName) i++;
      parts.unshift(el.tagName.toLowerCase() + ':nth-of-type(' + i + ')');
      el = el.parentElement;
    }
    return null;
  }
  function labelOf(t) {
    if (!t || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName) || (t.closest && t.closest('[data-hm-mask],[data-hm-block]'))) return null;
    var txt = t.getAttribute('aria-label') || t.innerText || t.getAttribute('title') || '';
    txt = txt.replace(/\s+/g, ' ').trim();
    return txt ? txt.slice(0, 80) : null;
  }
  function trackDepth() {
    var d = Math.min(1, (window.scrollY + window.innerHeight) / docH());
    if (d > depth) depth = d;
  }
  function mark(tag, payload) { try { if (rec) rec.addCustomEvent(tag, payload); } catch (x) { /* ignore */ } }
  function post(url, body, final) {
    if (final && body.length < 60000 && navigator.sendBeacon && navigator.sendBeacon(url, body)) return;
    try { fetch(url, { method: 'POST', body: body, keepalive: body.length < 60000, headers: { 'content-type': 'text/plain' } }); } catch (x) { /* ignore */ }
  }

  document.addEventListener('click', function (e) {
    if (clicks >= 300 || !e.target || !e.target.closest) return;
    clicks++;
    var hit = e.target.closest(INTERACTIVE);
    var el = hit || e.target;
    var r = el.getBoundingClientRect();
    var now = Date.now();
    recent = recent.filter(function (c) { return now - c.t < 1000 && Math.abs(c.x - e.clientX) < 30 && Math.abs(c.y - e.clientY) < 30; });
    recent.push({ t: now, x: e.clientX, y: e.clientY });
    var label = labelOf(hit);
    var ev = {
      sel: cssPath(el),
      l: label,
      rx: r.width ? Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) : 0.5,
      ry: r.height ? Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) : 0.5,
      x: Math.max(0, Math.min(1, e.pageX / docW())),
      y: Math.round(e.pageY),
      h: docH(),
      r: recent.length >= 3,
      dd: false,
      pending: !hit
    };
    queue.push(ev);
    if (recent.length === 3) mark('rage-click', { label: label });
    // A link that leaves the page: send what we have now (keepalive), the unload beacon alone is not reliable.
    if (hit && hit.tagName === 'A' && hit.href && !/^(#|javascript:)/i.test(hit.getAttribute('href') || '#')) setTimeout(function () { flush(false); }, 0);
    if (!hit) {
      // Dead click: nothing on the page reacted (no DOM change, scroll or navigation) within a second.
      // Only changes around the clicked element count (its ancestors, e.g. body for a modal, or its
      // descendants), and inline-style changes are ignored: carousels and animated cursors mutate constantly.
      var changed = false;
      var target = e.target;
      var mo = new MutationObserver(function (list) {
        for (var m = 0; m < list.length; m++) {
          var mr = list[m], n = mr.target;
          if (mr.type === 'attributes' && mr.attributeName === 'style') continue;
          if (n === target || (n.contains && n.contains(target)) || (target.contains && target.contains(n))) { changed = true; return; }
        }
      });
      mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      var y0 = window.scrollY, href = location.href;
      setTimeout(function () {
        mo.disconnect();
        ev.dd = !changed && window.scrollY === y0 && location.href === href;
        ev.pending = false;
        if (ev.dd) mark('dead-click', { label: null });
      }, 1000);
    }
  }, true);
  window.addEventListener('scroll', trackDepth, { passive: true });
  window.addEventListener('error', function (e) { mark('error', { message: String((e && e.message) || 'Error').slice(0, 200) }); });
  window.addEventListener('unhandledrejection', function (e) { mark('error', { message: ('Unhandled promise rejection: ' + String(e && e.reason && (e.reason.message || e.reason))).slice(0, 200) }); });

  function flush(final) {
    trackDepth();
    var ready = queue.filter(function (c) { return final || !c.pending; });
    queue = queue.filter(function (c) { return !final && c.pending; });
    var d = Math.round(depth * 1000) / 1000;
    if (ready.length || d !== sentDepth) {
      sentDepth = d;
      post(endpoint, JSON.stringify({
        k: key, v: vid, p: location.pathname, t: (document.title || '').slice(0, 200), d: device(),
        vw: window.innerWidth, vh: window.innerHeight, h: docH(), s: d,
        e: ready.map(function (c) { return { sel: c.sel, l: c.l, rx: c.rx, ry: c.ry, x: c.x, y: c.y, h: c.h, r: c.r, dd: c.dd }; })
      }), final);
    }
    flushRec(final);
  }

  /* ── session recordings ── */
  function session(sampleRate) {
    var now = Date.now(), st = null;
    try { st = JSON.parse(sessionStorage.getItem('__hm_session') || 'null'); } catch (x) { st = null; }
    if (!st || now - st.t > 30 * 60 * 1000) st = { id: now.toString(36) + Math.random().toString(36).slice(2, 12), rec: Math.random() < sampleRate };
    st.t = now;
    try { sessionStorage.setItem('__hm_session', JSON.stringify(st)); } catch (x) { /* storage blocked: session = this page */ }
    return st;
  }
  function flushRec(final) {
    if (!recBuf.length || !sess) return;
    var events = recBuf;
    recBuf = [];
    recSize = 0;
    session(1);
    post(endpoint + '/rec', JSON.stringify({ k: key, s: sess.id, v: vid, p: location.pathname, t: (document.title || '').slice(0, 200), d: device(), vw: window.innerWidth, vh: window.innerHeight, q: recSeq++, e: events }), final);
  }
  function startRecording(cfg) {
    sess = session(typeof cfg.sampleRate === 'number' ? cfg.sampleRate : 1);
    if (!sess.rec) { sess = null; return; }
    var js = document.createElement('script');
    js.src = origin + '/rr.js';
    js.async = true;
    js.onload = function () {
      var lib = window.rrwebRecord;
      if (!lib || !lib.record) return;
      rec = lib.record;
      rec({
        emit: function (ev) {
          recBuf.push(ev);
          recSize += ev.type === 2 ? 300000 : 200;
          if (recSize > 400000) flushRec(false);
        },
        maskAllInputs: true,
        maskTextSelector: cfg.masking === 'strict' ? '*' : '[data-hm-mask]',
        blockSelector: '[data-hm-block]',
        ignoreSelector: '[data-hm-ignore]',
        slimDOMOptions: 'all',
        inlineStylesheet: true,
        recordCanvas: false,
        collectFonts: false,
        sampling: { mousemove: 50, scroll: 150, media: 800, input: 'last' }
      });
    };
    (document.head || document.documentElement).appendChild(js);
  }

  function start() {
    trackDepth();
    flush(false);
    setInterval(function () { flush(false); }, 5000);
    fetch(endpoint + '/config?k=' + encodeURIComponent(key))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (cfg) { if (cfg && cfg.recordings && cfg.recordings.enabled) startRecording(cfg.recordings); })
      .catch(function () { /* recordings off */ });
  }
  if (document.readyState === 'complete') start(); else window.addEventListener('load', start);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flush(true); });
  window.addEventListener('pagehide', function () { flush(true); });
})();
`;
