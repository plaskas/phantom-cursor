// ─────────────────────────────────────────────────────────────
// PHANTOM CURSOR — Session State
// Pure helpers for managing per-page cache and agent attention.
// No I/O, no side-effects: safe to unit-test.
// ─────────────────────────────────────────────────────────────

export function createSession() {
  return {
    url: null,
    title: null,
    pageId: null,

    overview: {
      imageContent: null,   // MCP content item { type:'image', data, mimeType }
      capturedAt: null,
    },

    dom: {
      elements: [],         // Element[]
      elementMap: new Map(),// ref → Element
      snapshotAt: null,
    },

    agents: new Map(),      // agentId → AttentionEntry
    viewport: { w: 0, h: 0 },
  };
}

export function detectNavigationAndReset(session, url, title) {
  const newPageId = `${url}::${title}`;
  if (newPageId === session.pageId) return false;

  session.url = url;
  session.title = title;
  session.pageId = newPageId;
  session.overview.imageContent = null;
  session.overview.capturedAt = null;
  session.dom.elements = [];
  session.dom.elementMap = new Map();
  session.dom.snapshotAt = null;
  session.agents = new Map();
  return true;
}

export function populateDomCache(session, snap) {
  session.dom.elements = snap.elements;
  session.dom.elementMap = new Map(snap.elements.map(e => [e.ref, e]));
  session.dom.snapshotAt = snap.timestamp ?? Date.now();
  if (snap.viewport) session.viewport = snap.viewport;
}

export function formatAttentionState(session) {
  if (session.agents.size === 0) return '';
  const lines = ['', '--- attention ---'];
  for (const [agentId, entry] of session.agents) {
    const glyph = entry.action === 'click' ? '[click]' : '[look]';
    const ref   = entry.ref   ? ` ${entry.ref}`           : '';
    const label = entry.label ? ` "${entry.label}"`       : '';
    lines.push(`  ${agentId} ${glyph}${ref}${label} @ (${entry.x}, ${entry.y})`);
  }
  return lines.join('\n');
}
