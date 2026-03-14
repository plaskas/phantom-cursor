import { describe, it, expect, beforeEach } from 'vitest';
import {
  createSession,
  detectNavigationAndReset,
  populateDomCache,
  formatAttentionState,
} from '../session.js';

let session;
beforeEach(() => { session = createSession(); });

describe('createSession', () => {
  it('initialises with null url and empty collections', () => {
    expect(session.url).toBeNull();
    expect(session.overview.imageContent).toBeNull();
    expect(session.dom.elements).toHaveLength(0);
    expect(session.dom.elementMap.size).toBe(0);
    expect(session.agents.size).toBe(0);
  });
});

describe('detectNavigationAndReset', () => {
  it('returns true and clears cache on first call', () => {
    session.overview.imageContent = { type: 'image', data: 'abc' };
    session.dom.elements = [{ ref: '@e1' }];
    const changed = detectNavigationAndReset(session, 'https://a.com', 'Page A');
    expect(changed).toBe(true);
    expect(session.overview.imageContent).toBeNull();
    expect(session.dom.elements).toHaveLength(0);
  });

  it('returns false on same url+title', () => {
    detectNavigationAndReset(session, 'https://a.com', 'Page A');
    const changed = detectNavigationAndReset(session, 'https://a.com', 'Page A');
    expect(changed).toBe(false);
  });

  it('returns true and resets when url changes', () => {
    detectNavigationAndReset(session, 'https://a.com', 'Page A');
    session.overview.imageContent = { type: 'image', data: 'x' };
    const changed = detectNavigationAndReset(session, 'https://b.com', 'Page B');
    expect(changed).toBe(true);
    expect(session.overview.imageContent).toBeNull();
  });
});

describe('populateDomCache', () => {
  it('fills elementMap from elements array', () => {
    const snap = {
      elements: [
        { ref: '@e1', tag: 'button', label: 'Submit', selector: '#submit', rect: { x:0,y:0,w:100,h:40 } },
        { ref: '@e2', tag: 'a', label: 'Home', selector: 'nav > a', rect: { x:10,y:0,w:60,h:30 } },
      ],
      timestamp: 12345,
      viewport: { w: 1280, h: 800 },
    };
    populateDomCache(session, snap);
    expect(session.dom.elements).toHaveLength(2);
    expect(session.dom.elementMap.get('@e1').label).toBe('Submit');
    expect(session.dom.elementMap.get('@e2').label).toBe('Home');
    expect(session.dom.snapshotAt).toBe(12345);
    expect(session.viewport).toEqual({ w: 1280, h: 800 });
  });
});

describe('formatAttentionState', () => {
  it('returns empty string when no agents', () => {
    expect(formatAttentionState(session)).toBe('');
  });

  it('formats a single agent with element ref', () => {
    session.agents.set('default', {
      agentId: 'default', ref: '@e5', label: 'Sign in', x: 510, y: 240, action: 'focus',
    });
    const out = formatAttentionState(session);
    expect(out).toContain('--- attention ---');
    expect(out).toContain('default');
    expect(out).toContain('@e5');
    expect(out).toContain('"Sign in"');
    expect(out).toContain('(510, 240)');
    expect(out).toContain('[look]');
  });

  it('uses [click] label for click action', () => {
    session.agents.set('bot', {
      agentId: 'bot', ref: '@e3', label: 'Add', x: 200, y: 100, action: 'click',
    });
    expect(formatAttentionState(session)).toContain('[click]');
  });

  it('formats two agents', () => {
    session.agents.set('browse', { agentId:'browse', ref:'@e1', label:'Nav', x:50, y:10, action:'focus' });
    session.agents.set('click',  { agentId:'click',  ref:'@e9', label:'Buy', x:600,y:300,action:'click' });
    const out = formatAttentionState(session);
    expect(out).toContain('browse');
    expect(out).toContain('click');
  });
});
