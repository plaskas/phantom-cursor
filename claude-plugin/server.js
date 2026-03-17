#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// PHANTOM CURSOR v0.4 — Claude Code MCP Server (Playwright)
//
// No Chrome extension required. No remote-debugging flags.
// Playwright manages its own browser instance with clean lifecycle.
// ─────────────────────────────────────────────────────────────

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { chromium } from 'playwright';
import {
  createSession,
  detectNavigationAndReset,
  populateDomCache,
  formatAttentionState,
} from './session.js';

// ── Browser Lifecycle ──────────────────────────────────────────

const browser = await chromium.launch({
  headless: false,
  channel: 'chrome',       // Use system Chrome — no download required
  args: ['--no-sandbox'],
}).catch(() =>
  chromium.launch({ headless: false })   // Fallback to bundled Chromium
);

const context = await browser.newContext();
let activePageIdx = 0;

// Ensure at least one page exists
if (context.pages().length === 0) await context.newPage();

function getActivePage() {
  const pages = context.pages();
  if (!pages.length) return null;
  if (activePageIdx >= pages.length) activePageIdx = pages.length - 1;
  return pages[activePageIdx];
}

// Network + console tracking per page
function attachPageListeners(page) {
  page._networkLog = [];
  page._consoleLog = [];
  page.on('request', req => page._networkLog.push({
    id: page._networkLog.length,
    url: req.url(), method: req.method(), type: req.resourceType(), timestamp: Date.now(),
  }));
  page.on('response', res => {
    const e = page._networkLog.findLast?.(e => e.url === res.url() && !e.status);
    if (e) e.status = res.status();
  });
  page.on('console', msg => page._consoleLog.push({
    id: page._consoleLog.length,
    type: msg.type(), text: msg.text(), timestamp: Date.now(),
  }));
}

for (const p of context.pages()) attachPageListeners(p);
context.on('page', p => attachPageListeners(p));

// Cleanup on exit
async function shutdown() {
  try { await context.close(); } catch (_) {}
  try { await browser.close(); } catch (_) {}
}
process.on('SIGTERM', () => shutdown().finally(() => process.exit(0)));
process.on('SIGINT',  () => shutdown().finally(() => process.exit(0)));
process.on('exit',    () => { try { browser.close(); } catch (_) {} });

// ── Session State ──────────────────────────────────────────────

const session = createSession();

// ── Page Eval ─────────────────────────────────────────────────
// Serialises a JS function + args and evaluates them in the active page.

async function pageEval(func, funcArgs = []) {
  const page = getActivePage();
  if (!page) throw new Error('No active page');
  const expr = `(${func.toString()})(${funcArgs.map(a => JSON.stringify(a)).join(',')})`;
  return page.evaluate(expr);
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
        el.textContent?.trim().slice(0, 80) || el.getAttribute('name') || el.tagName.toLowerCase();
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
          type: node.getAttribute('type') || null, value: node.value || null,
          disabled: node.disabled || node.getAttribute('aria-disabled') === 'true',
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        });
      }
      for (const c of node.children) walk(c);
    }
    walk(document.querySelector(root) || document.body);
    return { url: location.href, title: document.title, timestamp: Date.now(),
      viewport: { w: window.innerWidth, h: window.innerHeight }, elements };
  }, [rootSelector]);
}

// ── Agent Color Palette ────────────────────────────────────────

const AGENT_PALETTE = ['#7C6FFF', '#00C9A7', '#FF6B6B', '#FFB830', '#4ECDC4', '#C77DFF'];
function agentColor(agentId) {
  let h = 5381;
  for (let i = 0; i < agentId.length; i++) h = ((h * 33) ^ agentId.charCodeAt(i)) >>> 0;
  return AGENT_PALETTE[h % AGENT_PALETTE.length];
}

// ── Spotlight (eyes-only) ──────────────────────────────────────

async function cdpFocusElement(agentId, selector, action = 'focus') {
  const color = agentColor(agentId);
  return pageEval((sel, aid, col, act) => {
    const candidates = Array.from(document.querySelectorAll(sel));
    const el = candidates.find(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
            || candidates[0];
    if (!el) return { ok: false, error: 'Element not found' };
    const r  = el.getBoundingClientRect();
    const cx = r.left + r.width  / 2;
    const cy = r.top  + r.height / 2;
    const radius = Math.max(Math.max(r.width, r.height) / 2 + 60, 80);

    // Spotlight overlay (eyes-exclusive — phantom_move never writes here)
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

    // Agent label badge
    const glyph = act === 'click' ? '↑' : act === 'browse' ? '⊡' : '◉';
    let badge = document.getElementById('__phantom_label_' + aid);
    if (!badge) {
      badge = document.createElement('div');
      badge.id = '__phantom_label_' + aid;
      badge.style.cssText =
        `position:fixed;top:0;left:0;pointer-events:none;z-index:2147483645;` +
        `color:#fff;font:600 11px/1 -apple-system,ui-sans-serif,sans-serif;` +
        `padding:5px 10px 5px 8px;border-radius:20px;white-space:nowrap;` +
        `box-shadow:0 2px 8px rgba(0,0,0,0.35);` +
        `transition:left 0.42s cubic-bezier(0.25,0.46,0.45,0.94),` +
                   `top 0.42s cubic-bezier(0.25,0.46,0.45,0.94),opacity 0.15s;opacity:0;`;
      document.body.appendChild(badge);
    }
    badge.textContent = `${glyph} ${aid}`;
    badge.style.background = col;
    const bw = badge.offsetWidth || 90;
    badge.style.left    = Math.min(Math.round(cx) + 14, window.innerWidth - bw - 8) + 'px';
    badge.style.top     = Math.max(Math.round(cy) - radius - 38, 8) + 'px';
    badge.style.opacity = '1';

    return { ok: true, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } };
  }, [selector, agentId, color, action]);
}

async function cdpClickElement(agentId, selector) {
  const focus = await cdpFocusElement(agentId, selector, 'click');
  if (!focus?.ok) return focus;
  const color = agentColor(agentId);
  const cx = focus.rect.x + focus.rect.w / 2;
  const cy = focus.rect.y + focus.rect.h / 2;
  await pageEval((cx, cy, aid, col) => {
    let act = document.getElementById('__phantom_act_' + aid);
    if (!act) {
      act = document.createElement('div'); act.id = '__phantom_act_' + aid;
      act.style.cssText =
        'position:fixed;top:0;left:0;pointer-events:none;z-index:2147483647;' +
        'transition:transform 0.08s ease,opacity 0.12s ease;opacity:0;';
      document.body.appendChild(act);
    }
    act.innerHTML =
      `<svg width="20" height="24" viewBox="0 0 20 24" fill="none">` +
      `<path d="M2 2L2 18L6.5 13.5L9.5 20L12 19L9 12.5L15 12.5L2 2Z"` +
      ` fill="#fff" stroke="${col}" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
    act.style.transform = `translate(${cx - 4}px,${cy - 2}px)`;
    act.style.opacity   = '1';
    const ripple = document.createElement('div');
    ripple.style.cssText =
      `position:fixed;top:0;left:0;pointer-events:none;z-index:2147483646;border-radius:50%;` +
      `border:2px solid ${col};width:0;height:0;` +
      `transform:translate(${cx}px,${cy}px) translate(-50%,-50%);opacity:0.9;`;
    document.body.appendChild(ripple);
    const rs = performance.now(), rd = 1500;
    (function rf(now) {
      const t = Math.min((now - rs) / rd, 1), sz = t * 72;
      ripple.style.width = ripple.style.height = sz + 'px';
      ripple.style.opacity = (1 - t) * 0.75;
      if (t < 1) requestAnimationFrame(rf); else ripple.remove();
    })(performance.now());
    setTimeout(() => { act.style.opacity = '0'; }, 500);
    setTimeout(() => {
      const badge = document.getElementById('__phantom_label_' + aid);
      if (badge) badge.textContent = `◉ ${aid}`;
    }, 620);
  }, [cx, cy, agentId, color]);
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
    const candidates = Array.from(document.querySelectorAll(sel));
    const el = candidates.find(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
            || candidates[0];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      label: el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 80) || sel,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    };
  }, [refOrSelector]);
  if (!detail) return { error: `Selector "${refOrSelector}" not found in DOM.` };
  return { selector: refOrSelector, ref: null, label: detail.label, rect: detail.rect, source: 'live' };
}

// ── Tool Definitions ───────────────────────────────────────────

const TOOLS = [
  // Phantom tools
  {
    name: 'phantom_browse',
    description: 'START HERE on any new page. Returns full-page overview JPEG + complete DOM listing. Caches overview — pass forceRefresh:true to retake.',
    inputSchema: { type: 'object', properties: {
      rootSelector: { type: 'string', default: 'body' },
      agentId:      { type: 'string', default: 'default' },
      forceRefresh: { type: 'boolean', default: false },
    }},
  },
  {
    name: 'phantom_snapshot',
    description: 'Refresh the DOM element list without a screenshot. Returns DOM listing + attention state (text only).',
    inputSchema: { type: 'object', properties: {
      rootSelector: { type: 'string', default: 'body' },
      agentId:      { type: 'string', default: 'default' },
    }},
  },
  {
    name: 'phantom_focus',
    description: 'Move spotlight to element — shows what Claude is looking at by darkening the page except a bright circle around the element. Spotlight is persistent and owned exclusively by the eyes agent. Accepts DOM ref (@e12) or CSS selector. Returns TEXT ONLY.',
    inputSchema: { type: 'object', required: ['selector'], properties: {
      selector: { type: 'string', description: 'DOM ref (@e12) or CSS selector.' },
      agentId:  { type: 'string', default: 'default' },
    }},
  },
  {
    name: 'phantom_click',
    description: 'Animate spotlight + click burst on element, then perform the click. Accepts DOM ref (@e12) or CSS selector. Returns text confirmation.',
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
    description: 'Move cursor to specific x,y coordinates (no spotlight — badge + arrow only). Returns attention state.',
    inputSchema: { type: 'object', required: ['x', 'y'], properties: {
      x: { type: 'number' }, y: { type: 'number' },
      agentId: { type: 'string', default: 'default' },
    }},
  },
  {
    name: 'phantom_scan',
    description: 'Sweep eyes + cursor through a sequence of elements in one call — no round trips between steps. Eyes scan ahead, cursor trails. Pass DOM refs (@e12) or CSS selectors. Returns when scan completes.',
    inputSchema: { type: 'object', required: ['selectors'], properties: {
      selectors:       { type: 'array', items: { type: 'string' }, description: 'Ordered list of DOM refs or CSS selectors for eyes to scan through.' },
      cursorSelectors: { type: 'array', items: { type: 'string' }, description: 'Optional separate waypoints for cursor. Defaults to eyes waypoints with a 1-step lag.' },
      stepMs:          { type: 'number', default: 200, description: 'Milliseconds between each step (default 200).' },
      eyesAgentId:     { type: 'string', default: 'focus' },
      cursorAgentId:   { type: 'string', default: 'cursor' },
    }},
  },
  // Browser tools
  {
    name: 'take_screenshot',
    description: 'Take a screenshot of the page or element.',
    inputSchema: { type: 'object', properties: {
      fullPage: { type: 'boolean' },
      format:   { type: 'string', enum: ['png','jpeg','webp'], default: 'png' },
      quality:  { type: 'number', minimum: 0, maximum: 100 },
      uid:      { type: 'string', description: 'Element uid from snapshot — screenshots just that element.' },
    }},
  },
  {
    name: 'navigate_page',
    description: 'Navigate the current browser tab to a URL.',
    inputSchema: { type: 'object', properties: {
      url:  { type: 'string' },
      type: { type: 'string' },
    }},
  },
  {
    name: 'new_page',
    description: 'Open a new tab and load a URL.',
    inputSchema: { type: 'object', required: ['url'], properties: {
      url:        { type: 'string' },
      background: { type: 'boolean', default: false },
    }},
  },
  {
    name: 'list_pages',
    description: 'Get a list of pages open in the browser.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'select_page',
    description: 'Switch to a different open browser tab by 1-based index.',
    inputSchema: { type: 'object', required: ['index'], properties: {
      index: { type: 'number' },
    }},
  },
  {
    name: 'close_page',
    description: 'Close the current browser tab.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'fill',
    description: 'Fill a form input with a value.',
    inputSchema: { type: 'object', required: ['uid', 'value'], properties: {
      uid:   { type: 'string' },
      value: { type: 'string' },
    }},
  },
  {
    name: 'fill_form',
    description: 'Fill multiple form fields at once.',
    inputSchema: { type: 'object', required: ['fields'], properties: {
      fields: { type: 'object', description: 'Map of CSS selector → value' },
    }},
  },
  {
    name: 'click',
    description: 'Click an element by uid.',
    inputSchema: { type: 'object', required: ['uid'], properties: {
      uid: { type: 'string' },
    }},
  },
  {
    name: 'hover',
    description: 'Hover over an element.',
    inputSchema: { type: 'object', required: ['uid'], properties: {
      uid: { type: 'string' },
    }},
  },
  {
    name: 'press_key',
    description: 'Press a keyboard key (e.g. Enter, Tab, Escape, ArrowDown).',
    inputSchema: { type: 'object', required: ['key'], properties: {
      key: { type: 'string' },
    }},
  },
  {
    name: 'type_text',
    description: 'Type text at the current cursor position.',
    inputSchema: { type: 'object', required: ['text'], properties: {
      text: { type: 'string' },
    }},
  },
  {
    name: 'wait_for',
    description: 'Wait for a selector to appear, or for the page to reach network idle.',
    inputSchema: { type: 'object', properties: {
      selector: { type: 'string' },
      timeout:  { type: 'number' },
    }},
  },
  {
    name: 'evaluate_script',
    description: 'Evaluate a JavaScript function inside the current page. Returns JSON-serialisable result.',
    inputSchema: { type: 'object', required: ['function'], properties: {
      function: { type: 'string' },
      args:     { type: 'array', items: { type: 'string' } },
    }},
  },
  {
    name: 'take_snapshot',
    description: 'Return a full DOM snapshot of the page as JSON.',
    inputSchema: { type: 'object', properties: {
      rootSelector: { type: 'string', default: 'body' },
    }},
  },
  {
    name: 'resize_page',
    description: 'Resize the browser viewport.',
    inputSchema: { type: 'object', required: ['width','height'], properties: {
      width:  { type: 'number' },
      height: { type: 'number' },
    }},
  },
  {
    name: 'list_network_requests',
    description: 'List network requests made by the current page.',
    inputSchema: { type: 'object', properties: {
      limit: { type: 'number', default: 50 },
    }},
  },
  {
    name: 'get_network_request',
    description: 'Get a specific network request by index.',
    inputSchema: { type: 'object', required: ['id'], properties: {
      id: { type: 'number' },
    }},
  },
  {
    name: 'list_console_messages',
    description: 'List console messages from the current page.',
    inputSchema: { type: 'object', properties: {
      limit: { type: 'number', default: 50 },
    }},
  },
  {
    name: 'get_console_message',
    description: 'Get a specific console message by index.',
    inputSchema: { type: 'object', required: ['id'], properties: {
      id: { type: 'number' },
    }},
  },
  {
    name: 'handle_dialog',
    description: 'Accept or dismiss the next browser dialog (alert, confirm, prompt).',
    inputSchema: { type: 'object', properties: {
      action:      { type: 'string', enum: ['accept','dismiss'], default: 'accept' },
      promptText:  { type: 'string' },
    }},
  },
  {
    name: 'upload_file',
    description: 'Upload a file to a file input element.',
    inputSchema: { type: 'object', required: ['uid','path'], properties: {
      uid:  { type: 'string' },
      path: { type: 'string' },
    }},
  },
  {
    name: 'emulate',
    description: 'Emulate a device (mobile viewport + user agent).',
    inputSchema: { type: 'object', required: ['device'], properties: {
      device: { type: 'string', description: 'Device name, e.g. "iPhone 15"' },
    }},
  },
];

// ── MCP Server ─────────────────────────────────────────────────

const server = new Server(
  { name: 'phantom-cursor', version: '0.5.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const page = getActivePage();

  try {

    // ── phantom_browse ─────────────────────────────────────────
    if (name === 'phantom_browse') {
      const snap = await cdpSnapshot(args.rootSelector || 'body');
      detectNavigationAndReset(session, snap.url, snap.title);
      populateDomCache(session, snap);

      let imageContent = null, imageNote;
      if (!session.overview.imageContent || args.forceRefresh) {
        try {
          const buffer = await page.screenshot({ type: 'jpeg', quality: 15, fullPage: true });
          imageContent = { type: 'image', data: buffer.toString('base64'), mimeType: 'image/jpeg' };
          session.overview.imageContent = imageContent;
          session.overview.capturedAt = Date.now();
          imageNote = 'Overview: fresh';
        } catch (e) {
          imageNote = 'Overview: unavailable (screenshot failed)';
        }
      } else {
        imageContent = session.overview.imageContent;
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

      return { content: [{ type: 'text', text }, ...(imageContent ? [imageContent] : [])] };
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

      // Perform actual click at exact coordinates — avoids non-unique CSS selector issues
      await page.mouse.click(cx, cy);

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
        document.querySelectorAll('[id^="__phantom_cursor_"]').forEach(el => el.remove());
      }).catch(() => {});
      await page.goto(args.url, { waitUntil: 'domcontentloaded' });
      Object.assign(session, createSession());
      session.url = args.url;
      return { content: [{ type: 'text', text: `Navigated to ${args.url}\nCall phantom_browse to cache the new page.` }] };
    }

    // ── phantom_move ───────────────────────────────────────────
    if (name === 'phantom_move') {
      const agentId = args.agentId || 'default';
      const color   = agentColor(agentId);
      await pageEval((x, y, aid, col) => {
        // Label badge (no spotlight — cursor is arrow-only)
        let badge = document.getElementById('__phantom_label_' + aid);
        if (!badge) {
          badge = document.createElement('div');
          badge.id = '__phantom_label_' + aid;
          document.body.appendChild(badge);
        }
        badge.style.cssText =
          `position:fixed;top:0;left:0;pointer-events:none;z-index:2147483645;` +
          `color:#fff;font:600 11px/1 -apple-system,ui-sans-serif,sans-serif;` +
          `padding:5px 10px 5px 8px;border-radius:20px;white-space:nowrap;` +
          `box-shadow:0 2px 8px rgba(0,0,0,0.35);` +
          `transition:left 0.35s cubic-bezier(0.25,0.46,0.45,0.94),` +
                     `top 0.35s cubic-bezier(0.25,0.46,0.45,0.94),opacity 0.15s;`;
        badge.textContent = `⊡ ${aid}`;
        badge.style.background = col;
        const bw = badge.offsetWidth || 90;
        badge.style.left    = Math.min(x + 14, window.innerWidth - bw - 8) + 'px';
        badge.style.top     = Math.max(y - 50, 8) + 'px';
        badge.style.opacity = '1';

        // Persistent cursor arrow — no spotlight, badge + arrow only
        let cursor = document.getElementById('__phantom_cursor_' + aid);
        if (!cursor) {
          cursor = document.createElement('div');
          cursor.id = '__phantom_cursor_' + aid;
          document.body.appendChild(cursor);
        }
        cursor.style.cssText =
          'position:fixed;top:0;left:0;pointer-events:none;z-index:2147483647;' +
          'transition:transform 0.25s cubic-bezier(0.25,0.46,0.45,0.94),opacity 0.15s;' +
          'filter:drop-shadow(0 1px 3px rgba(0,0,0,0.9)) drop-shadow(0 0 6px rgba(255,255,255,0.5));';
        cursor.innerHTML =
          `<svg width="28" height="34" viewBox="0 0 20 24" fill="none">` +
          `<path d="M2 2L2 18L6.5 13.5L9.5 20L12 19L9 12.5L15 12.5L2 2Z"` +
          ` fill="${col}" stroke="white" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
        cursor.style.transform = `translate(${x - 4}px,${y - 2}px)`;
        cursor.style.opacity   = '1';
      }, [args.x, args.y, agentId, color]);

      session.agents.set(agentId, {
        agentId, ref: null, label: null,
        x: args.x, y: args.y, action: 'move', updatedAt: Date.now(),
      });
      return { content: [{ type: 'text', text: `Cursor moved to (${args.x}, ${args.y})${formatAttentionState(session)}` }] };
    }

    // ── phantom_scan ───────────────────────────────────────────
    if (name === 'phantom_scan') {
      const eyesAgentId = args.eyesAgentId  || 'focus';
      const curAgentId  = args.cursorAgentId || 'cursor';
      const eyesColor   = agentColor(eyesAgentId);
      const curColor    = agentColor(curAgentId);
      const stepMs      = args.stepMs ?? 200;

      // Resolve eyes waypoints server-side (DOM cache + live fallback)
      const eyeWaypoints = [];
      for (const sel of (args.selectors || [])) {
        const target = await resolveTarget(sel);
        if (!target.error) {
          const cx     = target.rect.x + Math.round(target.rect.w / 2);
          const cy     = target.rect.y + Math.round(target.rect.h / 2);
          const radius = Math.max(Math.max(target.rect.w, target.rect.h) / 2 + 60, 80);
          eyeWaypoints.push({ cx, cy, radius, label: target.label });
        }
      }
      if (!eyeWaypoints.length)
        return { content: [{ type: 'text', text: 'No valid selectors resolved.' }] };

      // Cursor waypoints: explicit list or default to 1-step lag behind eyes
      let curWaypoints = [];
      if (args.cursorSelectors?.length) {
        for (const sel of args.cursorSelectors) {
          const target = await resolveTarget(sel);
          if (!target.error) {
            const cx = target.rect.x + Math.round(target.rect.w / 2);
            const cy = target.rect.y + Math.round(target.rect.h / 2);
            curWaypoints.push({ cx, cy });
          }
        }
      } else {
        // No cursorSelectors — cursor stays fixed, only focus agent moves
        curWaypoints = [];
      }

      // Single page.evaluate() call — entire animation runs browser-side via setTimeout chain
      const result = await pageEval(
        (eyeSteps, curSteps, ms, eAid, cAid, eCol, cCol) => {
          return new Promise(resolve => {
            const total = Math.max(eyeSteps.length, curSteps.length);
            if (!total) { resolve({ done: true, steps: 0 }); return; }

            // Derive spotlight dark colour from eyes agent colour
            const hex = eCol.replace('#', '');
            const [er, eg, eb] = [parseInt(hex.slice(0,2),16), parseInt(hex.slice(2,4),16), parseInt(hex.slice(4,6),16)];
            const dark = `rgba(${Math.round(er*0.12)},${Math.round(eg*0.12)},${Math.round(eb*0.12)},0.82)`;
            const ease = t => t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3) / 2;

            // ── Eyes spotlight ──────────────────────────────────
            let ov = document.getElementById('__phantom_spotlight');
            if (!ov) {
              ov = document.createElement('div');
              ov.id = '__phantom_spotlight';
              ov.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483644;';
              document.body.appendChild(ov);
            }
            function animateSpotlight(cx, cy, radius) {
              const fromX = ov._spotX ?? cx, fromY = ov._spotY ?? cy, fromR = ov._spotR ?? radius;
              const start = performance.now(), dur = Math.min(ms * 0.82, 340);
              if (ov._raf) cancelAnimationFrame(ov._raf);
              (function frame(now) {
                const t = Math.min((now - start) / dur, 1), e = ease(t);
                const x = fromX + (cx - fromX) * e, y = fromY + (cy - fromY) * e;
                const rd = fromR + (radius - fromR) * e;
                const inner = Math.round(rd * 0.55), outer = Math.round(rd * 1.35);
                ov.style.background =
                  `radial-gradient(circle ${Math.round(rd)}px at ${Math.round(x)}px ${Math.round(y)}px,` +
                  `transparent 0px,transparent ${inner}px,${dark} ${outer}px,${dark} 100%)`;
                if (t < 1) ov._raf = requestAnimationFrame(frame);
                else { ov._spotX = cx; ov._spotY = cy; ov._spotR = radius; ov._raf = null; }
              })(performance.now());
            }

            // ── Eyes badge ──────────────────────────────────────
            let eyeBadge = document.getElementById('__phantom_label_' + eAid);
            if (!eyeBadge) {
              eyeBadge = document.createElement('div');
              eyeBadge.id = '__phantom_label_' + eAid;
              eyeBadge.style.cssText =
                `position:fixed;top:0;left:0;pointer-events:none;z-index:2147483645;` +
                `color:#fff;font:600 11px/1 -apple-system,ui-sans-serif,sans-serif;` +
                `padding:5px 10px 5px 8px;border-radius:20px;white-space:nowrap;` +
                `box-shadow:0 2px 8px rgba(0,0,0,0.35);` +
                `transition:left 0.3s cubic-bezier(0.25,0.46,0.45,0.94),` +
                           `top 0.3s cubic-bezier(0.25,0.46,0.45,0.94),opacity 0.15s;opacity:0;`;
              document.body.appendChild(eyeBadge);
            }
            eyeBadge.textContent = `◉ ${eAid}`;
            eyeBadge.style.background = eCol;
            eyeBadge.style.opacity = '1';

            // ── Cursor arrow ────────────────────────────────────
            let cursor = document.getElementById('__phantom_cursor_' + cAid);
            if (!cursor) {
              cursor = document.createElement('div');
              cursor.id = '__phantom_cursor_' + cAid;
              document.body.appendChild(cursor);
            }
            cursor.style.cssText =
              'position:fixed;top:0;left:0;pointer-events:none;z-index:2147483647;' +
              `transition:transform ${Math.round(ms * 0.9)}ms cubic-bezier(0.25,0.46,0.45,0.94),opacity 0.15s;` +
              'filter:drop-shadow(0 1px 3px rgba(0,0,0,0.9)) drop-shadow(0 0 6px rgba(255,255,255,0.5));';
            cursor.innerHTML =
              `<svg width="28" height="34" viewBox="0 0 20 24" fill="none">` +
              `<path d="M2 2L2 18L6.5 13.5L9.5 20L12 19L9 12.5L15 12.5L2 2Z"` +
              ` fill="${cCol}" stroke="white" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
            cursor.style.opacity = '1';

            // ── Cursor badge ────────────────────────────────────
            let curBadge = document.getElementById('__phantom_label_' + cAid);
            if (!curBadge) {
              curBadge = document.createElement('div');
              curBadge.id = '__phantom_label_' + cAid;
              curBadge.style.cssText =
                `position:fixed;top:0;left:0;pointer-events:none;z-index:2147483645;` +
                `color:#fff;font:600 11px/1 -apple-system,ui-sans-serif,sans-serif;` +
                `padding:5px 10px 5px 8px;border-radius:20px;white-space:nowrap;` +
                `box-shadow:0 2px 8px rgba(0,0,0,0.35);` +
                `transition:left ${Math.round(ms * 0.9)}ms cubic-bezier(0.25,0.46,0.45,0.94),` +
                           `top ${Math.round(ms * 0.9)}ms cubic-bezier(0.25,0.46,0.45,0.94),opacity 0.15s;opacity:0;`;
              document.body.appendChild(curBadge);
            }
            curBadge.textContent = `⊡ ${cAid}`;
            curBadge.style.background = cCol;
            curBadge.style.opacity = '1';

            // ── Step loop ───────────────────────────────────────
            let step = 0;
            function tick() {
              if (step < eyeSteps.length) {
                const { cx, cy, radius } = eyeSteps[step];
                animateSpotlight(cx, cy, radius);
                const bw = eyeBadge.offsetWidth || 90;
                eyeBadge.style.left = Math.min(cx + 14, window.innerWidth - bw - 8) + 'px';
                eyeBadge.style.top  = Math.max(cy - radius - 38, 8) + 'px';
              }
              if (step < curSteps.length) {
                const { cx, cy } = curSteps[step];
                cursor.style.transform = `translate(${cx - 4}px,${cy - 2}px)`;
                const bw = curBadge.offsetWidth || 90;
                curBadge.style.left = Math.min(cx + 14, window.innerWidth - bw - 8) + 'px';
                curBadge.style.top  = Math.max(cy - 50, 8) + 'px';
              }
              step++;
              if (step < total) setTimeout(tick, ms);
              else resolve({ done: true, steps: total });
            }
            tick();
          });
        },
        [eyeWaypoints, curWaypoints, stepMs, eyesAgentId, curAgentId, eyesColor, curColor]
      );

      // Update session state to final positions
      const lastEye = eyeWaypoints[eyeWaypoints.length - 1];
      const lastCur = curWaypoints[curWaypoints.length - 1];
      if (lastEye) session.agents.set(eyesAgentId, {
        agentId: eyesAgentId, ref: null, label: lastEye.label,
        x: lastEye.cx, y: lastEye.cy, action: 'focus', updatedAt: Date.now(),
      });
      if (lastCur) session.agents.set(curAgentId, {
        agentId: curAgentId, ref: null, label: null,
        x: lastCur.cx, y: lastCur.cy, action: 'move', updatedAt: Date.now(),
      });

      return { content: [{ type: 'text', text:
        `Scan complete: ${result.steps} steps @ ${stepMs}ms/step\n${formatAttentionState(session)}`
      }] };
    }

    // ── take_screenshot ────────────────────────────────────────
    if (name === 'take_screenshot') {
      const fmt = args.format || 'png';
      const opts = { type: fmt, fullPage: args.fullPage || false };
      if (args.quality && fmt !== 'png') opts.quality = args.quality;
      if (args.uid) {
        const el = session.dom.elementMap.get(args.uid);
        if (el) {
          const elHandle = await page.$(el.selector);
          if (elHandle) {
            const buf = await elHandle.screenshot(opts);
            return { content: [{ type: 'image', data: buf.toString('base64'), mimeType: `image/${fmt}` }] };
          }
        }
      }
      const buf = await page.screenshot(opts);
      return { content: [{ type: 'image', data: buf.toString('base64'), mimeType: `image/${fmt}` }] };
    }

    // ── navigate_page ──────────────────────────────────────────
    if (name === 'navigate_page') {
      const url = args.url;
      if (!url) return { content: [{ type: 'text', text: 'No URL provided' }] };
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      Object.assign(session, createSession());
      return { content: [{ type: 'text', text: `Navigated to ${url}` }] };
    }

    // ── new_page ───────────────────────────────────────────────
    if (name === 'new_page') {
      const newPage = await context.newPage();
      await newPage.goto(args.url, { waitUntil: 'domcontentloaded' });
      if (!args.background) activePageIdx = context.pages().indexOf(newPage);
      const pages = context.pages();
      const list = pages.map((p, i) => `${i + 1}: ${p.url()}${i === activePageIdx ? ' [selected]' : ''}`).join('\n');
      return { content: [{ type: 'text', text: `## Pages\n${list}` }] };
    }

    // ── list_pages ─────────────────────────────────────────────
    if (name === 'list_pages') {
      const pages = context.pages();
      const list = pages.map((p, i) => `${i + 1}: ${p.url()}${i === activePageIdx ? ' [selected]' : ''}`).join('\n');
      return { content: [{ type: 'text', text: `## Pages\n${list}` }] };
    }

    // ── select_page ────────────────────────────────────────────
    if (name === 'select_page') {
      const pages = context.pages();
      const idx   = (args.index || 1) - 1;
      if (idx < 0 || idx >= pages.length)
        return { content: [{ type: 'text', text: `Invalid page index ${args.index}` }] };
      activePageIdx = idx;
      await pages[idx].bringToFront();
      return { content: [{ type: 'text', text: `Selected page ${args.index}: ${pages[idx].url()}` }] };
    }

    // ── close_page ─────────────────────────────────────────────
    if (name === 'close_page') {
      await page.close();
      activePageIdx = Math.max(0, Math.min(activePageIdx, context.pages().length - 1));
      return { content: [{ type: 'text', text: 'Page closed.' }] };
    }

    // ── fill ───────────────────────────────────────────────────
    if (name === 'fill') {
      const el  = session.dom.elementMap.get(args.uid);
      const sel = el?.selector || args.uid;
      await page.fill(sel, args.value || '');
      return { content: [{ type: 'text', text: `Filled "${sel}" with value.` }] };
    }

    // ── fill_form ──────────────────────────────────────────────
    if (name === 'fill_form') {
      const results = [];
      for (const [sel, val] of Object.entries(args.fields || {})) {
        try { await page.fill(sel, val); results.push(`✓ ${sel}`); }
        catch (e) { results.push(`✗ ${sel}: ${e.message}`); }
      }
      return { content: [{ type: 'text', text: results.join('\n') }] };
    }

    // ── click ──────────────────────────────────────────────────
    if (name === 'click') {
      const el  = session.dom.elementMap.get(args.uid);
      const sel = el?.selector || args.uid;
      await page.click(sel);
      return { content: [{ type: 'text', text: `Clicked "${sel}"` }] };
    }

    // ── hover ──────────────────────────────────────────────────
    if (name === 'hover') {
      const el  = session.dom.elementMap.get(args.uid);
      const sel = el?.selector || args.uid;
      await page.hover(sel);
      return { content: [{ type: 'text', text: `Hovered over "${sel}"` }] };
    }

    // ── press_key ──────────────────────────────────────────────
    if (name === 'press_key') {
      await page.keyboard.press(args.key);
      return { content: [{ type: 'text', text: `Pressed key: ${args.key}` }] };
    }

    // ── type_text ──────────────────────────────────────────────
    if (name === 'type_text') {
      await page.keyboard.type(args.text || '');
      return { content: [{ type: 'text', text: `Typed text.` }] };
    }

    // ── wait_for ───────────────────────────────────────────────
    if (name === 'wait_for') {
      const timeout = args.timeout || 5000;
      if (args.selector) {
        await page.waitForSelector(args.selector, { timeout });
        return { content: [{ type: 'text', text: `Element "${args.selector}" appeared.` }] };
      }
      await page.waitForLoadState('networkidle', { timeout });
      return { content: [{ type: 'text', text: 'Page reached network idle.' }] };
    }

    // ── evaluate_script ────────────────────────────────────────
    if (name === 'evaluate_script') {
      const result = await page.evaluate(args.function);
      return { content: [{ type: 'text', text: `Script ran on page and returned:\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`` }] };
    }

    // ── take_snapshot ──────────────────────────────────────────
    if (name === 'take_snapshot') {
      const snap = await cdpSnapshot(args.rootSelector || 'body');
      return { content: [{ type: 'text', text: JSON.stringify(snap, null, 2) }] };
    }

    // ── resize_page ────────────────────────────────────────────
    if (name === 'resize_page') {
      await page.setViewportSize({ width: args.width, height: args.height });
      return { content: [{ type: 'text', text: `Viewport resized to ${args.width}x${args.height}` }] };
    }

    // ── list_network_requests ──────────────────────────────────
    if (name === 'list_network_requests') {
      const log  = (page._networkLog || []).slice(-(args.limit || 50));
      const text = log.map(r => `[${r.id}] ${r.method} ${r.status ?? '...'} ${r.type} ${r.url}`).join('\n');
      return { content: [{ type: 'text', text: text || 'No network requests recorded.' }] };
    }

    // ── get_network_request ────────────────────────────────────
    if (name === 'get_network_request') {
      const entry = (page._networkLog || []).find(r => r.id === args.id);
      return { content: [{ type: 'text', text: entry ? JSON.stringify(entry, null, 2) : `Request ${args.id} not found.` }] };
    }

    // ── list_console_messages ──────────────────────────────────
    if (name === 'list_console_messages') {
      const log  = (page._consoleLog || []).slice(-(args.limit || 50));
      const text = log.map(m => `[${m.id}] [${m.type}] ${m.text}`).join('\n');
      return { content: [{ type: 'text', text: text || 'No console messages.' }] };
    }

    // ── get_console_message ────────────────────────────────────
    if (name === 'get_console_message') {
      const entry = (page._consoleLog || []).find(m => m.id === args.id);
      return { content: [{ type: 'text', text: entry ? JSON.stringify(entry, null, 2) : `Message ${args.id} not found.` }] };
    }

    // ── handle_dialog ──────────────────────────────────────────
    if (name === 'handle_dialog') {
      page.once('dialog', async dialog => {
        if (args.action === 'dismiss') await dialog.dismiss();
        else await dialog.accept(args.promptText);
      });
      return { content: [{ type: 'text', text: `Will ${args.action || 'accept'} next dialog.` }] };
    }

    // ── upload_file ────────────────────────────────────────────
    if (name === 'upload_file') {
      const el  = session.dom.elementMap.get(args.uid);
      const sel = el?.selector || args.uid;
      await page.setInputFiles(sel, args.path);
      return { content: [{ type: 'text', text: `Uploaded "${args.path}" to "${sel}".` }] };
    }

    // ── emulate ────────────────────────────────────────────────
    if (name === 'emulate') {
      const { devices } = await import('playwright');
      const device = devices[args.device];
      if (!device) return { content: [{ type: 'text', text: `Unknown device: ${args.device}` }] };
      await page.setViewportSize(device.viewport);
      await page.setExtraHTTPHeaders({ 'User-Agent': device.userAgent });
      return { content: [{ type: 'text', text: `Emulating ${args.device} (${device.viewport.width}x${device.viewport.height})` }] };
    }

    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };

  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[PhantomCursor MCP] v0.4 ready — Playwright-based, no extension required');
