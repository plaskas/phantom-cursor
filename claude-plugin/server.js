#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// PHANTOM CURSOR — Claude Code MCP Server
//
// Architecture: phantom-cursor is an MCP server (for Claude) that
// is also an MCP client of chrome-devtools-mcp. All CDP access
// goes through chrome-devtools-mcp — one connection, no duplicates.
//
// Tools exposed to Claude:
//   Phantom:  phantom_snapshot, phantom_focus, phantom_click,
//             phantom_navigate, phantom_element, phantom_move
//   Proxied:  all chrome-devtools-mcp tools (click, fill, navigate, etc.)
// ─────────────────────────────────────────────────────────────

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// ── Chrome DevTools MCP Client ─────────────────────────────────
// Owns the single CDP connection. All JS eval goes through here.

const cdtTransport = new StdioClientTransport({
  command: 'npx',
  args: ['chrome-devtools-mcp@latest'],
});

const cdtClient = new Client({ name: 'phantom-cursor-cdt', version: '0.1.0' });
await cdtClient.connect(cdtTransport);

let cdtTools = [];
try {
  const { tools } = await cdtClient.listTools();
  cdtTools = tools;
  console.error(`[PhantomCursor] Proxying ${cdtTools.length} chrome-devtools tools`);
} catch (e) {
  console.error('[PhantomCursor] Could not list chrome-devtools tools:', e.message);
}

// ── Delegation Helpers ─────────────────────────────────────────

async function callCDT(toolName, args = {}) {
  const result = await cdtClient.callTool({ name: toolName, arguments: args });
  return result.content?.[0]?.text ?? '';
}

// Execute JS in the page via chrome-devtools evaluate_script.
// Returns the parsed JSON result, or raw text if not JSON-wrapped.
async function pageEval(func, funcArgs = []) {
  const fnBody = `() => { return (${func.toString()})(${funcArgs.map(a => JSON.stringify(a)).join(',')}); }`;
  const text = await callCDT('evaluate_script', { function: fnBody });
  const match = text.match(/```(?:json)?\n([\s\S]*?)\n```/);
  if (match) {
    try { return JSON.parse(match[1]); } catch { return match[1]; }
  }
  return text;
}

// ── Page State ────────────────────────────────────────────────
// Tracks per-page context so Claude can reference the overview
// and stream DOM without re-snapshotting on every interaction.

const pageState = {
  url: null,
  overviewTaken: false,   // has the first full-page overview been sent?
  domCached: false,       // has the DOM snapshot been taken this page?
};

function resetPageState(url) {
  pageState.url = url;
  pageState.overviewTaken = false;
  pageState.domCached = false;
}

// ── Smooth Motion Injector ─────────────────────────────────────
// Auto-injects rAF-based smooth cursor animation on every page.
// Safe to call multiple times — guards with __phantomSmoothInstalled.

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
      function wire(id, readFn, writeFn, keys, duration, debounceMs) {
        const el = document.getElementById(id); if (!el) return null;
        el.style.transition = 'none';
        const anim = makeAnimator(readFn, writeFn, keys, duration);
        let timer = null;
        const obs = new MutationObserver(() => {
          if (anim.isIgnoring()) return;
          clearTimeout(timer);
          timer = setTimeout(() => {
            const target = readFn(); writeFn(anim.getCurrent()); anim.animate(target);
          }, debounceMs);
        });
        obs.observe(el, { attributes: true, attributeFilter: ['style'] });
        return obs;
      }
      const parseXY  = id => { const m = (document.getElementById(id)||{style:{}}).style.transform?.match(/translate\(([0-9.-]+)px,\s*([0-9.-]+)px\)/); return m ? {x:+m[1],y:+m[2]} : {x:0,y:0}; };
      const writeXY  = id => s => { const el = document.getElementById(id); if(el) el.style.transform=`translate(${s.x}px,${s.y}px)`; };
      const parseBox = id => { const el = document.getElementById(id); return el ? {left:parseFloat(el.style.left)||0,top:parseFloat(el.style.top)||0,width:parseFloat(el.style.width)||0,height:parseFloat(el.style.height)||0} : {left:0,top:0,width:0,height:0}; };
      const writeBox = id => s => { const el = document.getElementById(id); if(el){el.style.left=s.left+'px';el.style.top=s.top+'px';el.style.width=s.width+'px';el.style.height=s.height+'px';} };
      const obs1 = wire('__phantom_cur_default', ()=>parseXY('__phantom_cur_default'), writeXY('__phantom_cur_default'), ['x','y'], 550, 16);
      const obs2 = wire('__phantom_ring_default', ()=>parseBox('__phantom_ring_default'), writeBox('__phantom_ring_default'), ['left','top','width','height'], 550, 20);
      const obs3 = wire('__phantom_act_default', ()=>parseXY('__phantom_act_default'), writeXY('__phantom_act_default'), ['x','y'], 400, 16);
      if (obs1 && obs2 && obs3)
        window.__phantomSmoothInstalled = { disconnect() { obs1.disconnect(); obs2.disconnect(); obs3.disconnect(); } };
    });
  } catch (_) { /* page may still be loading — will retry on next interaction */ }
}

// ── Phantom Operations ─────────────────────────────────────────

async function cdpSnapshot(rootSelector = 'body') {
  return pageEval((root) => {
    const elements = []; let idx = 1;
    const iTags = new Set(['A','BUTTON','INPUT','SELECT','TEXTAREA','LABEL']);
    const iRoles = new Set(['button','link','textbox','combobox','checkbox','radio','menuitem','tab']);
    const getLabel = el => el.getAttribute('aria-label') || el.getAttribute('placeholder') ||
      el.getAttribute('title') || el.textContent?.trim().slice(0,80) || el.tagName.toLowerCase();
    const getSel = el => {
      if (el.id) return '#' + CSS.escape(el.id);
      const p = []; let c = el;
      while (c && c !== document.body && p.length < 4) {
        let s = c.tagName.toLowerCase();
        const cls = c.className?.toString?.().trim().split(/\s+/).slice(0,2).join('.');
        if (cls) s += '.' + cls;
        p.unshift(s); c = c.parentElement;
      }
      return p.join(' > ');
    };
    function walk(node) {
      if (node.nodeType !== 1) return;
      const role = node.getAttribute('role');
      if (iTags.has(node.tagName) || iRoles.has(role) || node.hasAttribute('onclick')) {
        const r = node.getBoundingClientRect();
        if (r.width > 0 && r.height > 0)
          elements.push({ ref: '@e'+idx++, tag: node.tagName.toLowerCase(), role: role||null,
            label: getLabel(node), selector: getSel(node),
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } });
      }
      for (const c of node.children) walk(c);
    }
    walk(document.querySelector(root) || document.body);
    return { url: location.href, title: document.title, elements };
  }, [rootSelector]);
}

async function cdpFocusElement(agentId, selector, color = '#7C6FFF') {
  return pageEval((sel, aid, col) => {
    const el = document.querySelector(sel);
    if (!el) return { ok: false, error: 'Element not found' };
    const r = el.getBoundingClientRect();
    let ring = document.getElementById('__phantom_ring_' + aid);
    if (!ring) {
      ring = document.createElement('div');
      ring.id = '__phantom_ring_' + aid;
      ring.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483645;border-radius:6px;transition:all 0.15s ease;';
      document.body.appendChild(ring);
    }
    ring.style.left=r.left-6+'px'; ring.style.top=r.top-6+'px';
    ring.style.width=r.width+12+'px'; ring.style.height=r.height+12+'px';
    ring.style.border=`2px solid ${col}`; ring.style.background=col+'18';
    ring.style.boxShadow=`0 0 12px ${col}88`; ring.style.opacity='1';
    let cur = document.getElementById('__phantom_cur_' + aid);
    if (!cur) {
      cur = document.createElement('div');
      cur.id = '__phantom_cur_' + aid;
      cur.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;transition:transform 0.18s cubic-bezier(0.25,0.46,0.45,0.94);';
      cur.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><ellipse cx="12" cy="12" rx="10" ry="6" stroke="${col}" stroke-width="1.8"/><circle cx="12" cy="12" r="3" fill="${col}"/><circle cx="12" cy="12" r="1.2" fill="white" opacity="0.9"/></svg>`;
      document.body.appendChild(cur);
    }
    cur.style.transform = `translate(${r.left+r.width/2-12}px,${r.top+r.height/2-12}px)`;
    cur.style.opacity = '1';
    return { ok: true, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } };
  }, [selector, agentId, color]);
}

async function cdpClickElement(agentId, selector, color = '#7C6FFF') {
  const focus = await cdpFocusElement(agentId, selector, color);
  if (!focus?.ok) return focus;
  await pageEval((sel, aid, col) => {
    const el = document.querySelector(sel); if (!el) return;
    const r = el.getBoundingClientRect();
    let act = document.getElementById('__phantom_act_' + aid);
    if (!act) {
      act = document.createElement('div'); act.id = '__phantom_act_' + aid;
      act.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;transition:transform 0.08s ease;';
      act.innerHTML = `<svg width="20" height="24" viewBox="0 0 20 24" fill="none"><path d="M2 2L2 18L6.5 13.5L9.5 20L12 19L9 12.5L15 12.5L2 2Z" fill="${col}" stroke="white" stroke-width="1.2" stroke-linejoin="round"/></svg>`;
      document.body.appendChild(act);
    }
    act.style.transform = `translate(${r.left+r.width/2-4}px,${r.top+r.height/2-2}px)`;
    act.style.opacity = '1';
    setTimeout(() => { act.style.opacity = '0'; }, 600);
  }, [selector, agentId, color]);
  return focus;
}

// ── Phantom Tool Definitions ───────────────────────────────────

const PHANTOM_TOOLS = [
  {
    name: 'phantom_snapshot',
    description: 'Returns structured list of all interactive elements on the page. Use INSTEAD of screenshots. ~97% token reduction.',
    inputSchema: { type: 'object', properties: {
      rootSelector: { type: 'string', description: 'CSS selector to scope snapshot (default: body)', default: 'body' },
      agentId: { type: 'string', default: 'default' },
    }},
  },
  {
    name: 'phantom_focus',
    description: 'Move attention (eye) cursor to element. Shows user what Claude is looking at.',
    inputSchema: { type: 'object', required: ['selector'], properties: {
      selector: { type: 'string', description: 'CSS selector for target element' },
      agentId: { type: 'string', default: 'default' },
    }},
  },
  {
    name: 'phantom_click',
    description: 'Animate action (arrow) cursor clicking an element. Call alongside actual click for visual feedback.',
    inputSchema: { type: 'object', required: ['selector'], properties: {
      selector: { type: 'string' },
      agentId: { type: 'string', default: 'default' },
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
    description: 'Navigate the current browser tab to a URL.',
    inputSchema: { type: 'object', required: ['url'], properties: {
      url: { type: 'string' },
    }},
  },
  {
    name: 'phantom_move',
    description: 'Move attention cursor to specific x,y coordinates.',
    inputSchema: { type: 'object', required: ['x', 'y'], properties: {
      x: { type: 'number' }, y: { type: 'number' },
      agentId: { type: 'string', default: 'default' },
    }},
  },
  {
    name: 'phantom_browse',
    description: 'START HERE on any new page. Returns a low-res full-page overview screenshot + complete DOM snapshot in one call. Cache both — use the overview as your spatial map, then stream through DOM elements with phantom_focus without re-snapshotting.',
    inputSchema: { type: 'object', properties: {
      rootSelector: { type: 'string', default: 'body' },
      agentId: { type: 'string', default: 'default' },
    }},
  },
];

// ── MCP Server ─────────────────────────────────────────────────

const server = new Server(
  { name: 'phantom-cursor', version: '0.2.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...PHANTOM_TOOLS, ...cdtTools],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    // ── Phantom tools ──
    if (name === 'phantom_snapshot') {
      const snap = await cdpSnapshot(args.rootSelector || 'body');
      const summary = snap.elements.map(e =>
        `${e.ref} [${e.tag}${e.role ? ':'+e.role : ''}] "${e.label}" @ (${e.rect.x},${e.rect.y})`
      ).join('\n');
      return { content: [{ type: 'text', text:
        `Page: ${snap.title}\nURL: ${snap.url}\nElements (${snap.elements.length}):\n\n${summary}` }] };
    }

    if (name === 'phantom_focus') {
      await ensureSmoothMotion();
      const res = await cdpFocusElement(args.agentId || 'default', args.selector);
      if (!res?.ok) return { content: [{ type: 'text', text: `Could not focus: ${args.selector}` }] };

      // Scroll element into view so the vicinity screenshot is centred on it
      await pageEval((sel) => {
        const el = document.querySelector(sel);
        if (el) el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
      }, [args.selector]);

      // Small pause for smooth-motion animation to reach the element
      await new Promise(r => setTimeout(r, 300));

      // Vicinity screenshot — viewport is now centred on the element
      const shot = await cdtClient.callTool({
        name: 'take_screenshot',
        arguments: { format: 'jpeg', quality: 80 },
      });

      return { content: [
        { type: 'text', text: `Focused ${args.selector} at (${res.rect.x},${res.rect.y}) ${res.rect.w}×${res.rect.h}` },
        ...(shot.content || []),
      ]};
    }

    if (name === 'phantom_click') {
      const res = await cdpClickElement(args.agentId || 'default', args.selector);
      return { content: [{ type: 'text', text: res?.ok
        ? `Action cursor animated click on ${args.selector}`
        : `Could not click: ${args.selector}` }] };
    }

    if (name === 'phantom_element') {
      const detail = await pageEval((sel) => {
        const el = document.querySelector(sel); if (!el) return null;
        const r = el.getBoundingClientRect();
        return { tag: el.tagName.toLowerCase(),
          label: el.getAttribute('aria-label') || el.textContent?.trim().slice(0,200),
          value: el.value || el.innerText?.slice(0,500),
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          attributes: Object.fromEntries(Array.from(el.attributes).map(a => [a.name, a.value])) };
      }, [args.selector]);
      return { content: [{ type: 'text', text: detail
        ? JSON.stringify(detail, null, 2)
        : `Element not found: ${args.selector}` }] };
    }

    if (name === 'phantom_navigate') {
      await callCDT('navigate_page', { type: 'url', url: args.url });
      resetPageState(args.url);
      // Give the page a moment to settle then inject smooth motion
      await new Promise(r => setTimeout(r, 800));
      await ensureSmoothMotion();
      return { content: [{ type: 'text', text: `Navigated to ${args.url}` }] };
    }

    if (name === 'phantom_browse') {
      await ensureSmoothMotion();

      // 1. Full-page low-res overview
      const overviewShot = await cdtClient.callTool({
        name: 'take_screenshot',
        arguments: { fullPage: true, format: 'jpeg', quality: 20 },
      });
      pageState.overviewTaken = true;

      // 2. DOM snapshot
      const snap = await cdpSnapshot(args.rootSelector || 'body');
      pageState.domCached = true;
      const summary = snap.elements.map(e =>
        `${e.ref} [${e.tag}${e.role ? ':'+e.role : ''}] "${e.label}" @ (${e.rect.x},${e.rect.y}) ${e.rect.w}×${e.rect.h}`
      ).join('\n');

      return { content: [
        { type: 'text', text:
          `Page: ${snap.title}\nURL: ${snap.url}\n` +
          `Overview screenshot attached (low-res reference map).\n` +
          `DOM Elements (${snap.elements.length}) — use these refs for phantom_focus:\n\n${summary}` },
        ...(overviewShot.content || []),
      ]};
    }

    if (name === 'phantom_move') {
      await pageEval((x, y, aid) => {
        const col = '#7C6FFF';
        let cur = document.getElementById('__phantom_cur_' + aid);
        if (!cur) {
          cur = document.createElement('div');
          cur.id = '__phantom_cur_' + aid;
          cur.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;transition:transform 0.18s cubic-bezier(0.25,0.46,0.45,0.94);';
          cur.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><ellipse cx="12" cy="12" rx="10" ry="6" stroke="${col}" stroke-width="1.8"/><circle cx="12" cy="12" r="3" fill="${col}"/><circle cx="12" cy="12" r="1.2" fill="white" opacity="0.9"/></svg>`;
          document.body.appendChild(cur);
        }
        cur.style.transform = `translate(${x-12}px,${y-12}px)`; cur.style.opacity = '1';
      }, [args.x, args.y, args.agentId || 'default']);
      return { content: [{ type: 'text', text: `Attention cursor moved to (${args.x}, ${args.y})` }] };
    }

    // ── Proxy to chrome-devtools-mcp ──
    // Intercept take_screenshot: first call → full-page low-res overview
    if (name === 'take_screenshot' && !pageState.overviewTaken && !args.uid && !args.fullPage) {
      const result = await cdtClient.callTool({
        name: 'take_screenshot',
        arguments: { fullPage: true, format: 'jpeg', quality: 20 },
      });
      pageState.overviewTaken = true;
      return result;
    }

    const result = await cdtClient.callTool({ name, arguments: args });
    return result;

  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[PhantomCursor MCP] Server ready — CDP owned by chrome-devtools-mcp subprocess');
