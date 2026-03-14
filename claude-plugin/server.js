#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// PHANTOM CURSOR v0.3 — Claude Code MCP Server
//
// Token-efficient browser automation:
//   - phantom_browse: ONE low-res overview per page (cached)
//   - phantom_focus / phantom_click: text-only + attention state
//   - Spotlight overlay: darkened page + animated bright circle
//   - All tools append --- attention --- block
// ─────────────────────────────────────────────────────────────

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  createSession,
  detectNavigationAndReset,
  populateDomCache,
  formatAttentionState,
} from './session.js';

// ── Chrome DevTools MCP Client ─────────────────────────────────

const cdtTransport = new StdioClientTransport({
  command: 'npx',
  args: ['chrome-devtools-mcp@latest'],
});

const cdtClient = new Client({ name: 'phantom-cursor-cdt', version: '0.3.0' });
await cdtClient.connect(cdtTransport);

let cdtTools = [];
try {
  const { tools } = await cdtClient.listTools();
  cdtTools = tools;
  console.error(`[PhantomCursor] Proxying ${cdtTools.length} chrome-devtools tools`);
} catch (e) {
  console.error('[PhantomCursor] Could not list chrome-devtools tools:', e.message);
}

// ── Session State ──────────────────────────────────────────────

const session = createSession();

// ── Delegation Helpers ─────────────────────────────────────────

async function callCDT(toolName, args = {}) {
  const result = await cdtClient.callTool({ name: toolName, arguments: args });
  return result.content?.[0]?.text ?? '';
}

async function pageEval(func, funcArgs = []) {
  const fnBody = `() => { return (${func.toString()})(${funcArgs.map(a => JSON.stringify(a)).join(',')}); }`;
  const text = await callCDT('evaluate_script', { function: fnBody });
  const match = text.match(/```(?:json)?\n([\s\S]*?)\n```/);
  if (match) {
    try { return JSON.parse(match[1]); } catch { return match[1]; }
  }
  return text;
}

// ── Smooth Motion Injector ─────────────────────────────────────

async function ensureSmoothMotion() {
  try {
    await pageEval(() => {
      if (window.__phantomSmoothInstalled) return;
      const ease = t => t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2,3)/2;
      function makeAnimator(readFn, writeFn, keys, duration) {
        let anim = null, current = readFn(), ignoring = false;
        function animate(target) {
          if (anim) cancelAnimationFrame(anim);
          const from = {...current}, start = performance.now();
          (function frame(now) {
            const t = Math.min((now-start)/duration,1), e = ease(t), next = {};
            for (const k of keys) next[k] = from[k] + (target[k]-from[k])*e;
            current = next; ignoring = true; writeFn(next); ignoring = false;
            if (t < 1) anim = requestAnimationFrame(frame); else anim = null;
          })(performance.now());
        }
        return { animate, isIgnoring: () => ignoring, getCurrent: () => current };
      }
      window.__phantomSmoothInstalled = true;
    });
  } catch (_) { /* page may still be loading */ }
}

// ── DOM Walker ─────────────────────────────────────────────────

async function cdpSnapshot(rootSelector = 'body') {
  return pageEval((root) => {
    const iTags  = new Set(['A','BUTTON','INPUT','SELECT','TEXTAREA','LABEL','FORM']);
    const iRoles = new Set(['button','link','textbox','combobox','checkbox','radio',
                            'menuitem','tab','listitem','option']);

    function isVisible(el) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const s = window.getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    }

    function getLabel(el) {
      return el.getAttribute('aria-label') || el.getAttribute('placeholder') ||
        el.getAttribute('title') || el.getAttribute('alt') ||
        el.textContent?.trim().slice(0, 80) || el.getAttribute('name') ||
        el.tagName.toLowerCase();
    }

    function getSel(el) {
      if (el.id) return '#' + CSS.escape(el.id);
      if (el.getAttribute('data-testid')) return `[data-testid="${el.getAttribute('data-testid')}"]`;
      const parts = []; let cur = el;
      while (cur && cur !== document.body && parts.length < 4) {
        let seg = cur.tagName.toLowerCase();
        const cls = cur.className?.toString?.().trim().split(/\s+/).slice(0, 2).join('.');
        if (cls) seg += '.' + cls;
        parts.unshift(seg); cur = cur.parentElement;
      }
      return parts.join(' > ');
    }

    const elements = []; let idx = 1;
    function walk(node) {
      if (node.nodeType !== 1) return;
      const role = node.getAttribute('role');
      if ((iTags.has(node.tagName) || iRoles.has(role) ||
           node.hasAttribute('onclick') || node.hasAttribute('tabindex')) && isVisible(node)) {
        const r = node.getBoundingClientRect();
        elements.push({
          ref: '@e' + idx++, tag: node.tagName.toLowerCase(), role: role || null,
          label: getLabel(node), selector: getSel(node),
          type: node.getAttribute('type') || null,
          value: node.value || null,
          disabled: node.disabled || node.getAttribute('aria-disabled') === 'true',
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        });
      }
      for (const c of node.children) walk(c);
    }
    walk(document.querySelector(root) || document.body);
    return {
      url: location.href, title: document.title, timestamp: Date.now(),
      viewport: { w: window.innerWidth, h: window.innerHeight }, elements,
    };
  }, [rootSelector]);
}

// ── Agent Color Palette (Figma-style multiplayer) ─────────────

const AGENT_PALETTE = ['#7C6FFF', '#00C9A7', '#FF6B6B', '#FFB830', '#4ECDC4', '#C77DFF'];
function agentColor(agentId) {
  let h = 5381;
  for (let i = 0; i < agentId.length; i++) h = ((h * 33) ^ agentId.charCodeAt(i)) >>> 0;
  return AGENT_PALETTE[h % AGENT_PALETTE.length];
}

// ── Spotlight Focus System ─────────────────────────────────────
// One spotlight overlay that moves to the active agent's element.
// Each agent keeps a persistent colored name badge at their last position.

async function cdpFocusElement(agentId, selector, action = 'focus') {
  const color = agentColor(agentId);
  return pageEval((sel, aid, col, act) => {
    const el = document.querySelector(sel);
    if (!el) return { ok: false, error: 'Element not found' };
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width  / 2;
    const cy = r.top  + r.height / 2;
    const radius = Math.max(Math.max(r.width, r.height) / 2 + 60, 80);

    // ── Spotlight overlay (colored tint from agent palette) ──
    let ov = document.getElementById('__phantom_spotlight');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = '__phantom_spotlight';
      ov.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483644;';
      document.body.appendChild(ov);
    }
    const hex = col.replace('#', '');
    const rr = parseInt(hex.slice(0,2),16), gg = parseInt(hex.slice(2,4),16), bb = parseInt(hex.slice(4,6),16);
    const dark = `rgba(${Math.round(rr*0.12)},${Math.round(gg*0.12)},${Math.round(bb*0.12)},0.82)`;

    const fromX = ov._spotX ?? cx, fromY = ov._spotY ?? cy, fromR = ov._spotR ?? radius;
    const start = performance.now(), dur = 420;
    const ease = t => t < 0.5 ? 4*t*t*t : 1-Math.pow(-2*t+2,3)/2;
    if (ov._raf) cancelAnimationFrame(ov._raf);
    (function frame(now) {
      const t  = Math.min((now - start) / dur, 1), e = ease(t);
      const x  = fromX + (cx - fromX) * e;
      const y  = fromY + (cy - fromY) * e;
      const rd = fromR + (radius - fromR) * e;
      const inner = Math.round(rd * 0.55), outer = Math.round(rd * 1.35);
      ov.style.background =
        `radial-gradient(circle ${Math.round(rd)}px at ${Math.round(x)}px ${Math.round(y)}px,` +
        `transparent 0px,transparent ${inner}px,${dark} ${outer}px,${dark} 100%)`;
      if (t < 1) ov._raf = requestAnimationFrame(frame);
      else { ov._spotX = cx; ov._spotY = cy; ov._spotR = radius; ov._raf = null; }
    })(performance.now());

    // ── Agent label badge (persistent, floats above spotlight) ──
    const glyph = act === 'click' ? '↑' : act === 'browse' ? '⊡' : '◉';
    let badge = document.getElementById('__phantom_label_' + aid);
    if (!badge) {
      badge = document.createElement('div');
      badge.id = '__phantom_label_' + aid;
      badge.style.cssText =
        `position:fixed;pointer-events:none;z-index:2147483645;` +
        `color:#fff;font:600 11px/1 -apple-system,ui-sans-serif,sans-serif;` +
        `padding:5px 10px 5px 8px;border-radius:20px;white-space:nowrap;` +
        `box-shadow:0 2px 8px rgba(0,0,0,0.35);` +
        `transition:left 0.42s cubic-bezier(0.25,0.46,0.45,0.94),` +
                   `top 0.42s cubic-bezier(0.25,0.46,0.45,0.94),opacity 0.15s;` +
        `opacity:0;`;
      document.body.appendChild(badge);
    }
    badge.textContent = `${glyph} ${aid}`;
    badge.style.background = col;
    // Position: above and right of spotlight center, clamped to viewport
    const bw = badge.offsetWidth || 90;
    const bx = Math.min(Math.round(cx) + 14, window.innerWidth - bw - 8);
    const by = Math.max(Math.round(cy) - radius - 38, 8);
    badge.style.left    = bx + 'px';
    badge.style.top     = by + 'px';
    badge.style.opacity = '1';

    return {
      ok: true,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    };
  }, [selector, agentId, color, action]);
}

async function cdpClickElement(agentId, selector) {
  const focus = await cdpFocusElement(agentId, selector, 'click');
  if (!focus?.ok) return focus;

  const color = agentColor(agentId);
  await pageEval((sel, aid, col) => {
    const el = document.querySelector(sel); if (!el) return;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    // Click burst arrow
    let act = document.getElementById('__phantom_act_' + aid);
    if (!act) {
      act = document.createElement('div'); act.id = '__phantom_act_' + aid;
      act.style.cssText =
        'position:fixed;pointer-events:none;z-index:2147483647;' +
        'transition:transform 0.08s ease,opacity 0.12s ease;opacity:0;';
      document.body.appendChild(act);
    }
    act.innerHTML =
      `<svg width="20" height="24" viewBox="0 0 20 24" fill="none">` +
      `<path d="M2 2L2 18L6.5 13.5L9.5 20L12 19L9 12.5L15 12.5L2 2Z"` +
      ` fill="#fff" stroke="${col}" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
    act.style.transform = `translate(${cx - 4}px,${cy - 2}px)`;
    act.style.opacity   = '1';
    setTimeout(() => { act.style.opacity = '0'; }, 500);
    // Revert badge glyph from ↑ back to ◉ after click burst
    setTimeout(() => {
      const badge = document.getElementById('__phantom_label_' + aid);
      if (badge) badge.textContent = `◉ ${aid}`;
    }, 620);
  }, [selector, agentId, color]);

  return focus;
}

// ── Target Resolver ────────────────────────────────────────────

async function resolveTarget(refOrSelector) {
  if (refOrSelector.startsWith('@')) {
    const el = session.dom.elementMap.get(refOrSelector);
    if (el) return { selector: el.selector, ref: el.ref, label: el.label, rect: el.rect, source: 'cache' };
    return { error: `Ref ${refOrSelector} not in DOM cache. Call phantom_browse to refresh.` };
  }
  const detail = await pageEval((sel) => {
    const el = document.querySelector(sel); if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      label: el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 80) || sel,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    };
  }, [refOrSelector]);
  if (!detail) return { error: `Selector "${refOrSelector}" not found in DOM.` };
  return { selector: refOrSelector, ref: null, label: detail.label, rect: detail.rect, source: 'live' };
}

// ── Phantom Tool Definitions ───────────────────────────────────

const PHANTOM_TOOLS = [
  {
    name: 'phantom_browse',
    description:
      'START HERE on any new page. Returns a low-res full-page overview JPEG + complete DOM listing. ' +
      'Caches the overview — subsequent calls on the same page serve the cached image. ' +
      'Pass forceRefresh:true to retake the overview screenshot. ' +
      'This is the ONLY tool that returns a screenshot.',
    inputSchema: { type: 'object', properties: {
      rootSelector: { type: 'string', default: 'body' },
      agentId:      { type: 'string', default: 'default' },
      forceRefresh: { type: 'boolean', default: false },
    }},
  },
  {
    name: 'phantom_snapshot',
    description:
      'Refresh the DOM element list without taking a screenshot. ' +
      'Use after page content changes (modals, search results, etc.). ' +
      'Returns DOM listing + attention state (text only).',
    inputSchema: { type: 'object', properties: {
      rootSelector: { type: 'string', default: 'body' },
      agentId:      { type: 'string', default: 'default' },
    }},
  },
  {
    name: 'phantom_focus',
    description:
      'Move spotlight to element — shows what Claude is looking at by darkening the page except a bright circle around the element. ' +
      'Accepts a DOM ref (@e12) from phantom_browse for O(1) cache lookup, or a CSS selector. ' +
      'Returns TEXT ONLY — element details + attention state. No screenshot taken.',
    inputSchema: { type: 'object', required: ['selector'], properties: {
      selector: { type: 'string', description: 'DOM ref (@e12) or CSS selector.' },
      agentId:  { type: 'string', default: 'default' },
    }},
  },
  {
    name: 'phantom_click',
    description:
      'Animate spotlight + click burst on element. Accepts DOM ref (@e12) or CSS selector. ' +
      'Returns text confirmation + attention state. No screenshot.',
    inputSchema: { type: 'object', required: ['selector'], properties: {
      selector: { type: 'string' },
      agentId:  { type: 'string', default: 'default' },
    }},
  },
  {
    name: 'phantom_element',
    description: 'Get full detail for a single element: tag, label, value, attributes, rect.',
    inputSchema: { type: 'object', required: ['selector'], properties: {
      selector: { type: 'string' },
    }},
  },
  {
    name: 'phantom_navigate',
    description: 'Navigate the current browser tab to a URL. Resets all session caches.',
    inputSchema: { type: 'object', required: ['url'], properties: {
      url: { type: 'string' },
    }},
  },
  {
    name: 'phantom_move',
    description: 'Move spotlight to specific x,y coordinates. Returns attention state.',
    inputSchema: { type: 'object', required: ['x', 'y'], properties: {
      x: { type: 'number' }, y: { type: 'number' },
      agentId: { type: 'string', default: 'default' },
    }},
  },
];

// ── MCP Server ─────────────────────────────────────────────────

const server = new Server(
  { name: 'phantom-cursor', version: '0.3.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...PHANTOM_TOOLS, ...cdtTools],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {

    // ── phantom_browse ─────────────────────────────────────────
    if (name === 'phantom_browse') {
      await ensureSmoothMotion();

      const snap = await cdpSnapshot(args.rootSelector || 'body');
      detectNavigationAndReset(session, snap.url, snap.title);
      populateDomCache(session, snap);

      let imageNote;
      if (!session.overview.imageContent || args.forceRefresh) {
        const shot = await cdtClient.callTool({
          name: 'take_screenshot',
          arguments: { fullPage: true, format: 'jpeg', quality: 15 },
        });
        session.overview.imageContent = (shot.content || []).find(c => c.type === 'image') ?? null;
        session.overview.capturedAt = Date.now();
        imageNote = 'Overview: fresh';
      } else {
        const ageSec = Math.round((Date.now() - session.overview.capturedAt) / 1000);
        imageNote = `Overview: cached (${ageSec}s ago) — pass forceRefresh:true to recapture`;
      }

      const agentId = args.agentId || 'default';
      session.agents.set(agentId, {
        agentId, ref: null, label: 'page', x: 0, y: 0, action: 'browse', updatedAt: Date.now(),
      });

      const domLines = snap.elements.map(e => {
        const type     = e.type     ? ':' + e.type  : '';
        const role     = e.role     ? ':' + e.role  : '';
        const disabled = e.disabled ? ' [disabled]' : '';
        const val      = e.value    ? ` ="${e.value}"` : '';
        return `${e.ref} [${e.tag}${type}${role}]${disabled} "${e.label}"${val} @ (${e.rect.x},${e.rect.y}) ${e.rect.w}x${e.rect.h}`;
      }).join('\n');

      const text = [
        `Page: ${snap.title}`,
        `URL: ${snap.url}`,
        `Viewport: ${snap.viewport.w}x${snap.viewport.h}`,
        imageNote,
        `DOM: ${snap.elements.length} interactive elements`,
        '',
        domLines,
        formatAttentionState(session),
      ].join('\n');

      return {
        content: [
          { type: 'text', text },
          ...(session.overview.imageContent ? [session.overview.imageContent] : []),
        ],
      };
    }

    // ── phantom_snapshot ───────────────────────────────────────
    if (name === 'phantom_snapshot') {
      const snap = await cdpSnapshot(args.rootSelector || 'body');
      populateDomCache(session, snap);

      const domLines = snap.elements.map(e =>
        `${e.ref} [${e.tag}${e.role ? ':' + e.role : ''}] "${e.label}" @ (${e.rect.x},${e.rect.y}) ${e.rect.w}x${e.rect.h}`
      ).join('\n');

      const text = [
        `DOM refreshed: ${snap.elements.length} elements`,
        `Page: ${snap.title}  URL: ${snap.url}`,
        '',
        domLines,
        formatAttentionState(session),
      ].join('\n');

      return { content: [{ type: 'text', text }] };
    }

    // ── phantom_focus ──────────────────────────────────────────
    if (name === 'phantom_focus') {
      await ensureSmoothMotion();
      const agentId = args.agentId || 'default';

      const target = await resolveTarget(args.selector);
      if (target.error) return { content: [{ type: 'text', text: target.error }] };

      await pageEval((sel) => {
        const el = document.querySelector(sel);
        if (el) el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
      }, [target.selector]);

      const res = await cdpFocusElement(agentId, target.selector);
      if (!res?.ok) return { content: [{ type: 'text', text: `Could not focus: ${target.selector}` }] };

      const cx = target.rect.x + Math.round(target.rect.w / 2);
      const cy = target.rect.y + Math.round(target.rect.h / 2);
      session.agents.set(agentId, {
        agentId, ref: target.ref, label: target.label,
        x: cx, y: cy, action: 'focus', updatedAt: Date.now(),
      });

      const text = [
        `Focused: ${target.ref ?? target.selector}`,
        `  label:  "${target.label}"`,
        `  rect:   (${target.rect.x}, ${target.rect.y}) ${target.rect.w}x${target.rect.h}`,
        `  center: (${cx}, ${cy})`,
        `  source: ${target.source}`,
        formatAttentionState(session),
      ].join('\n');

      return { content: [{ type: 'text', text }] };
    }

    // ── phantom_click ──────────────────────────────────────────
    if (name === 'phantom_click') {
      const agentId = args.agentId || 'default';

      const target = await resolveTarget(args.selector);
      if (target.error) return { content: [{ type: 'text', text: target.error }] };

      const res = await cdpClickElement(agentId, target.selector);
      if (!res?.ok) return { content: [{ type: 'text', text: `Could not click: ${target.selector}` }] };

      const cx = target.rect.x + Math.round(target.rect.w / 2);
      const cy = target.rect.y + Math.round(target.rect.h / 2);
      session.agents.set(agentId, {
        agentId, ref: target.ref, label: target.label,
        x: cx, y: cy, action: 'click', updatedAt: Date.now(),
      });

      const text = [
        `Clicked: ${target.ref ?? target.selector} "${target.label}"`,
        `  at: (${cx}, ${cy})`,
        formatAttentionState(session),
      ].join('\n');

      return { content: [{ type: 'text', text }] };
    }

    // ── phantom_element ────────────────────────────────────────
    if (name === 'phantom_element') {
      const detail = await pageEval((sel) => {
        const el = document.querySelector(sel); if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          label: el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 200),
          value: el.value || el.innerText?.slice(0, 500),
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          attributes: Object.fromEntries(Array.from(el.attributes).map(a => [a.name, a.value])),
        };
      }, [args.selector]);
      return { content: [{ type: 'text', text: detail
        ? JSON.stringify(detail, null, 2)
        : `Element not found: ${args.selector}` }] };
    }

    // ── phantom_navigate ───────────────────────────────────────
    if (name === 'phantom_navigate') {
      await pageEval(() => {
        document.getElementById('__phantom_spotlight')?.remove();
        document.querySelectorAll('[id^="__phantom_label_"]').forEach(el => el.remove());
        document.querySelectorAll('[id^="__phantom_act_"]').forEach(el => el.remove());
      }).catch(() => {});

      await callCDT('navigate_page', { type: 'url', url: args.url });
      Object.assign(session, createSession());
      session.url = args.url;
      await new Promise(r => setTimeout(r, 800));
      await ensureSmoothMotion();
      return { content: [{ type: 'text', text: `Navigated to ${args.url}\nCall phantom_browse to cache the new page.` }] };
    }

    // ── phantom_move ───────────────────────────────────────────
    if (name === 'phantom_move') {
      const agentId = args.agentId || 'default';
      const color = agentColor(agentId);
      await pageEval((x, y, aid, col) => {
        // Spotlight
        let ov = document.getElementById('__phantom_spotlight');
        if (!ov) {
          ov = document.createElement('div');
          ov.id = '__phantom_spotlight';
          ov.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483644;';
          document.body.appendChild(ov);
        }
        const hex = col.replace('#','');
        const rr = parseInt(hex.slice(0,2),16), gg = parseInt(hex.slice(2,4),16), bb = parseInt(hex.slice(4,6),16);
        const dark = `rgba(${Math.round(rr*0.12)},${Math.round(gg*0.12)},${Math.round(bb*0.12)},0.82)`;
        const fromX = ov._spotX ?? x, fromY = ov._spotY ?? y, fromR = ov._spotR ?? 100;
        const radius = 100;
        const start = performance.now(), dur = 350;
        const ease = t => t < 0.5 ? 4*t*t*t : 1-Math.pow(-2*t+2,3)/2;
        if (ov._raf) cancelAnimationFrame(ov._raf);
        (function frame(now) {
          const t = Math.min((now - start) / dur, 1), e = ease(t);
          const cx = fromX + (x - fromX)*e, cy = fromY + (y - fromY)*e;
          const rd = fromR + (radius - fromR)*e;
          ov.style.background =
            `radial-gradient(circle ${Math.round(rd)}px at ${Math.round(cx)}px ${Math.round(cy)}px,` +
            `transparent 0px,transparent ${Math.round(rd*0.55)}px,` +
            `${dark} ${Math.round(rd*1.35)}px,${dark} 100%)`;
          if (t < 1) ov._raf = requestAnimationFrame(frame);
          else { ov._spotX = x; ov._spotY = y; ov._spotR = radius; ov._raf = null; }
        })(performance.now());
        // Label badge
        let badge = document.getElementById('__phantom_label_' + aid);
        if (!badge) {
          badge = document.createElement('div');
          badge.id = '__phantom_label_' + aid;
          badge.style.cssText =
            `position:fixed;pointer-events:none;z-index:2147483645;` +
            `color:#fff;font:600 11px/1 -apple-system,ui-sans-serif,sans-serif;` +
            `padding:5px 10px 5px 8px;border-radius:20px;white-space:nowrap;` +
            `box-shadow:0 2px 8px rgba(0,0,0,0.35);` +
            `transition:left 0.35s cubic-bezier(0.25,0.46,0.45,0.94),` +
                       `top 0.35s cubic-bezier(0.25,0.46,0.45,0.94),opacity 0.15s;opacity:0;`;
          document.body.appendChild(badge);
        }
        badge.textContent = `⊡ ${aid}`;
        badge.style.background = col;
        const bw = badge.offsetWidth || 90;
        badge.style.left    = Math.min(x + 14, window.innerWidth - bw - 8) + 'px';
        badge.style.top     = Math.max(y - 50, 8) + 'px';
        badge.style.opacity = '1';
      }, [args.x, args.y, agentId, color]);

      session.agents.set(agentId, {
        agentId, ref: null, label: null,
        x: args.x, y: args.y, action: 'move', updatedAt: Date.now(),
      });
      return { content: [{ type: 'text', text: `Spotlight moved to (${args.x}, ${args.y})${formatAttentionState(session)}` }] };
    }

    // ── Proxy to chrome-devtools-mcp ───────────────────────────
    const result = await cdtClient.callTool({ name, arguments: args });
    return result;

  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[PhantomCursor MCP] v0.3 ready — spotlight overlay, cached overview, text-only focus/click');
