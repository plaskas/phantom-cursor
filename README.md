# 👁 Phantom Cursor
### Claude Agent Vision Layer — Claude Code Plugin

> Phantom cursor overlay + DOM attention layer for Claude browser agents.  
> Replaces screenshot dependency with structured element targeting, and shows  
> users exactly what Claude is looking at in real time.

---

## What it does

### Two cursor types per agent
| Cursor | Shape | Purpose |
|--------|-------|---------|
| **Attention cursor** | 👁 Eye | Where Claude is *looking* — moves before reading |
| **Action cursor** | ↖ Arrow | Where Claude is *clicking* — animates on interaction |

### Multi-agent support
Each agent gets its own colour-coded cursor pair:
- **Agent 1 (Reader)** — Purple `#7C6FFF` — scans/reads the DOM
- **Agent 2 (Actor)** — Pink `#FF6F91` — clicks and interacts
- **Agent 3** — Green `#6FFFB0`
- **Agent 4** — Yellow `#FFD16F`

### DOM snapshot (screenshot replacement)
`phantom_snapshot()` returns structured element data instead of a full-page screenshot.

| Method | Tokens | Precision |
|--------|--------|-----------|
| Full screenshot | ~40,000 | Medium (pixel guessing) |
| DOM snapshot | ~500 | High (exact selectors + labels) |

---

## Installation

### 1. Load the Chrome Extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select `chrome-extension/` folder
4. Pin the 👁 icon in your toolbar

### 2. Launch Chrome with debugging port

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-debug

# Windows
chrome.exe --remote-debugging-port=9222
```

### 3. Install MCP server dependencies

```bash
cd claude-plugin
npm install
```

### 4. Register with Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "phantom-cursor": {
      "command": "node",
      "args": ["/Users/Nick/Documents/GitHub/phantom-cursor/claude-plugin/server.js"],
      "env": { "CDP_PORT": "9222" }
    }
  }
}
```

Then restart Claude Code:
```bash
claude .
```

---

## Usage in Claude Code

```
# Snapshot page structure (replaces screenshot)
phantom_snapshot()

# Focus attention cursor on an element
phantom_focus(selector=".submit-button")

# Animate a click (pair with actual CDP click)
phantom_click(selector=".submit-button")

# Two agents in parallel
phantom_focus(selector=".search-form", agentId="agent-1")
phantom_focus(selector=".results", agentId="agent-2")
```

---

## Demo

Open `demo/index.html` in a browser — no extension or server needed.

Keyboard shortcuts:
- `⌘S` — Run snapshot
- `1` — Focus heading
- `2` — Focus CTA button
- `3` — Focus input
- `C` — Animate click
- `P` — Parallel agents demo
- `ESC` — Clear all cursors

---

## Project Structure

```
phantom-cursor/
├── chrome-extension/
│   ├── manifest.json
│   ├── icons/
│   └── src/
│       ├── content.js     ← cursor overlays + DOM serialiser
│       ├── background.js  ← CDP command router
│       ├── overlay.css    ← animations + ring styles
│       └── popup.html     ← extension popup UI
├── claude-plugin/
│   ├── server.js          ← MCP server (6 tools)
│   ├── package.json
│   └── PLUGIN.md
├── demo/
│   └── index.html         ← interactive standalone demo
└── README.md
```

---

## Roadmap

- [ ] v0.2 — WebSocket bridge (no CDP port needed)
- [ ] v0.3 — Scroll tracking
- [ ] v0.4 — Agent trail history (faint path of prior positions)
- [ ] v0.5 — Multi-tab support
- [ ] v1.0 — Submit to Anthropic official plugin marketplace

---

MIT License · Built for the Claude Code plugin ecosystem
