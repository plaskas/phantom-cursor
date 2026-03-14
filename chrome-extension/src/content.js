// ─────────────────────────────────────────────────────────────
// PHANTOM CURSOR — Content Script
// Runs in every page. Manages:
//   1. Phantom cursor overlays (one per agent)
//   2. Attention ring (focus highlight, not click)
//   3. DOM attention serialiser (element → structured data)
//   4. Message bridge between background ↔ page
// ─────────────────────────────────────────────────────────────

const AGENTS = new Map(); // agentId → { cursor, attentionRing, color, label }

const AGENT_COLORS = [
  { cursor: '#7C6FFF', ring: '#7C6FFF33', label: 'Agent 1' },
  { cursor: '#FF6F91', ring: '#FF6F9133', label: 'Agent 2' },
  { cursor: '#6FFFB0', ring: '#6FFFB033', label: 'Agent 3' },
  { cursor: '#FFD16F', ring: '#FFD16F33', label: 'Agent 4' },
];

// ── Cursor Factory ────────────────────────────────────────────

function createAgentCursors(agentId, colorConfig) {
  const attentionEl = document.createElement('div');
  attentionEl.className = 'phantom-attention-cursor';
  attentionEl.dataset.agentId = agentId;
  attentionEl.innerHTML = `
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <ellipse cx="12" cy="12" rx="10" ry="6" stroke="${colorConfig.cursor}" stroke-width="1.8"/>
      <circle cx="12" cy="12" r="3" fill="${colorConfig.cursor}"/>
      <circle cx="12" cy="12" r="1.2" fill="white" opacity="0.9"/>
    </svg>
    <span class="phantom-agent-label" style="background:${colorConfig.cursor}">${colorConfig.label}</span>
  `;

  const actionEl = document.createElement('div');
  actionEl.className = 'phantom-action-cursor';
  actionEl.dataset.agentId = agentId;
  actionEl.innerHTML = `
    <svg width="20" height="24" viewBox="0 0 20 24" fill="none">
      <path d="M2 2L2 18L6.5 13.5L9.5 20L12 19L9 12.5L15 12.5L2 2Z"
            fill="${colorConfig.cursor}" stroke="white" stroke-width="1.2" stroke-linejoin="round"/>
    </svg>
  `;
  actionEl.style.opacity = '0';

  const ringEl = document.createElement('div');
  ringEl.className = 'phantom-attention-ring';
  ringEl.dataset.agentId = agentId;
  ringEl.style.setProperty('--ring-color', colorConfig.cursor);
  ringEl.style.setProperty('--ring-bg', colorConfig.ring);

  document.body.appendChild(attentionEl);
  document.body.appendChild(actionEl);
  document.body.appendChild(ringEl);

  return { attention: attentionEl, action: actionEl, ring: ringEl, color: colorConfig, currentTarget: null };
}

function getOrCreateAgent(agentId) {
  if (!AGENTS.has(agentId)) {
    const colorIdx = AGENTS.size % AGENT_COLORS.length;
    const agent = createAgentCursors(agentId, AGENT_COLORS[colorIdx]);
    AGENTS.set(agentId, agent);
  }
  return AGENTS.get(agentId);
}

// ── Cursor Movement ───────────────────────────────────────────

function moveAttentionCursor(agent, x, y, animated = true) {
  const el = agent.attention;
  el.style.transition = animated
    ? 'transform 0.18s cubic-bezier(0.25, 0.46, 0.45, 0.94)'
    : 'none';
  el.style.transform = `translate(${x - 12}px, ${y - 12}px)`;
  el.style.opacity = '1';
}

function moveActionCursor(agent, x, y) {
  const el = agent.action;
  el.style.transition = 'transform 0.08s ease-out, opacity 0.12s ease';
  el.style.transform = `translate(${x - 4}px, ${y - 2}px)`;
  el.style.opacity = '1';
}

function flashActionCursor(agent, x, y) {
  moveActionCursor(agent, x, y);
  agent.action.classList.add('phantom-click-flash');
  setTimeout(() => {
    agent.action.classList.remove('phantom-click-flash');
    setTimeout(() => { agent.action.style.opacity = '0'; }, 300);
  }, 400);
}

// ── Attention Ring ────────────────────────────────────────────

function focusElement(agent, selector) {
  let target = null;
  try {
    if (selector.startsWith('/') || selector.startsWith('(')) {
      const result = document.evaluate(selector, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      target = result.singleNodeValue;
    } else {
      target = document.querySelector(selector);
    }
  } catch (e) {
    console.warn('[PhantomCursor] Bad selector:', selector, e);
  }

  if (!target) return null;

  const rect = target.getBoundingClientRect();
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;

  const ring = agent.ring;
  ring.style.left = `${rect.left + scrollX - 6}px`;
  ring.style.top = `${rect.top + scrollY - 6}px`;
  ring.style.width = `${rect.width + 12}px`;
  ring.style.height = `${rect.height + 12}px`;
  ring.style.opacity = '1';
  ring.classList.add('phantom-ring-pulse');
  setTimeout(() => ring.classList.remove('phantom-ring-pulse'), 600);

  const cx = rect.left + rect.width / 2 + scrollX;
  const cy = rect.top + rect.height / 2 + scrollY;
  moveAttentionCursor(agent, cx - scrollX, cy - scrollY);

  agent.currentTarget = target;
  return { x: cx, y: cy, rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height } };
}

// ── DOM Serialiser ────────────────────────────────────────────

function getInteractiveSnapshot(rootSelector = 'body') {
  const root = document.querySelector(rootSelector) || document.body;
  const elements = [];
  let idx = 1;
  const interactiveTags = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'FORM']);
  const interactiveRoles = new Set(['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'menuitem', 'tab', 'listitem', 'option']);

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  function getLabel(el) {
    return el.getAttribute('aria-label') || el.getAttribute('placeholder') ||
      el.getAttribute('title') || el.getAttribute('alt') ||
      el.textContent?.trim().slice(0, 80) || el.getAttribute('name') || el.tagName.toLowerCase();
  }

  function getSelector(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    if (el.getAttribute('data-testid')) return `[data-testid="${el.getAttribute('data-testid')}"]`;
    const parts = [];
    let current = el;
    while (current && current !== document.body && parts.length < 4) {
      let seg = current.tagName.toLowerCase();
      if (current.className) {
        const cls = current.className.toString().trim().split(/\s+/).slice(0, 2).join('.');
        if (cls) seg += '.' + cls;
      }
      parts.unshift(seg);
      current = current.parentElement;
    }
    return parts.join(' > ');
  }

  function walk(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName;
    const role = node.getAttribute('role');
    const isInteractive = interactiveTags.has(tag) || interactiveRoles.has(role) ||
      node.hasAttribute('onclick') || node.hasAttribute('tabindex');
    if (isInteractive && isVisible(node)) {
      const rect = node.getBoundingClientRect();
      elements.push({
        ref: `@e${idx++}`, tag: tag.toLowerCase(), role: role || null,
        label: getLabel(node), selector: getSelector(node),
        type: node.getAttribute('type') || null, value: node.value || null,
        disabled: node.disabled || node.getAttribute('aria-disabled') === 'true',
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      });
    }
    for (const child of node.children) walk(child);
  }

  walk(root);
  return { url: location.href, title: document.title, timestamp: Date.now(),
    viewport: { w: window.innerWidth, h: window.innerHeight }, elements };
}

function getElementDetail(selector) {
  let el = null;
  try { el = document.querySelector(selector); } catch (e) { return null; }
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  return {
    selector, tag: el.tagName.toLowerCase(),
    label: el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 200),
    value: el.value || el.innerText?.slice(0, 500),
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
    attributes: Object.fromEntries(Array.from(el.attributes).map(a => [a.name, a.value])),
    visible: rect.width > 0 && rect.height > 0,
  };
}

// ── Message Handler ───────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.source !== 'phantom-cursor') return;
  const agentId = msg.agentId || 'default';
  const agent = getOrCreateAgent(agentId);

  switch (msg.action) {
    case 'move_attention': {
      moveAttentionCursor(agent, msg.x, msg.y);
      sendResponse({ ok: true });
      break;
    }
    case 'focus_element': {
      const result = focusElement(agent, msg.selector);
      sendResponse({ ok: !!result, position: result });
      break;
    }
    case 'click_element': {
      const pos = focusElement(agent, msg.selector);
      if (pos) {
        setTimeout(() => flashActionCursor(agent, pos.x - window.scrollX, pos.y - window.scrollY), 180);
      }
      sendResponse({ ok: !!pos, position: pos });
      break;
    }
    case 'snapshot': {
      const snapshot = getInteractiveSnapshot(msg.rootSelector);
      sendResponse({ ok: true, snapshot });
      break;
    }
    case 'element_detail': {
      const detail = getElementDetail(msg.selector);
      sendResponse({ ok: !!detail, detail });
      break;
    }
    case 'hide_agent': {
      if (agent) {
        agent.attention.style.opacity = '0';
        agent.action.style.opacity = '0';
        agent.ring.style.opacity = '0';
      }
      sendResponse({ ok: true });
      break;
    }
    case 'remove_agent': {
      if (agent) {
        agent.attention.remove();
        agent.action.remove();
        agent.ring.remove();
        AGENTS.delete(agentId);
      }
      sendResponse({ ok: true });
      break;
    }
    case 'list_agents': {
      sendResponse({ agents: Array.from(AGENTS.keys()) });
      break;
    }
  }
  return true;
});

console.log('[PhantomCursor] Content script loaded.');
