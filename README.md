# cmux-agent-mcp

CMUX MCP Server — a programmable terminal control plane for multi-agent AI workflows.

Turns [CMUX](https://cmux.dev) into a remote-controllable terminal multiplexer that any AI coding CLI can be orchestrated through. One orchestrator agent spawns, monitors, and communicates with any number of AI agents running in parallel across multiple projects.

## What This Does

- **Spawn AI agents** in CMUX workspaces — Claude Code, Gemini CLI, Codex CLI, OpenCode, Goose
- **Inject prompts** into running agent sessions as if a human typed them
- **Read output** from any pane — passive (fast) or deep (asks agents for status)
- **Orchestrate** — send different plans to different agents in one call
- **Manage workspaces** — create, rename, reorder, move between windows
- **Split panes** — horizontal, vertical, grid layouts, drag-to-split
- **Browser automation** — open URLs, navigate, snapshot DOM, evaluate JS, click/fill/type
- **Sidebar metadata** — status pills, progress bars, log entries
- **Notifications** — send alerts with blue ring indicators
- **Session recovery** — save/restore full layouts including CLI session IDs and conversations
- **Auto-skip permissions** — each CLI's autonomous mode is handled automatically
- **Auto-save** — sessions are saved automatically after every layout change

## Architecture

```
+---------------------------------------------------+
|         Your AI Agent (Claude, etc.)               |
|                                                    |
|  "Launch 4 agents and distribute tasks"            |
|                       |                            |
|                  MCP Tool Calls                    |
|                       |                            |
+---------------------------------------------------+
|                  cmux-agent-mcp                        |
|              (this MCP server)                     |
|                       |                            |
|              cmux CLI commands                     |
|                       |                            |
+---------------------------------------------------+
|                     CMUX                           |
|                                                    |
|  +-- Sidebar ----+  +-- Tab Bar ---------------+  |
|  | agents        |  | Claude 1 x | ~/p/sensei  |  |
|  | > project-a   |  +-----------------------------+|
|  |   project-b   |  | +--------+ +--------+    |  |
|  |   outputs     |  | | Claude | | Gemini |    |  |
|  |   edit        |  | | Agent  | | Agent  |    |  |
|  +---------------+  | +--------+ +--------+    |  |
|                      | | Codex  | | Shell  |    |  |
|                      | | Agent  | |        |    |  |
|                      | +--------+ +--------+    |  |
|                      +-----------------------------+
+---------------------------------------------------+
```

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) (v22.5+)
- [CMUX](https://cmux.dev) — install via `brew tap manaflow-ai/cmux && brew install --cask cmux`

### Install

One command:

```bash
npm install -g cmux-agent-mcp
```

Install automatically registers the MCP server globally for all AI coding tools:

| Config file | For |
|---|---|
| `~/.claude.json` | Claude Code, Codex |
| `~/.cursor/mcp.json` | Cursor |
| VS Code `mcp.json` | VS Code |
| `~/.gemini/settings.json` | Gemini CLI |
| `~/.config/opencode/...` | OpenCode |

One install, every project, every tool. Existing config files are merged — other MCP servers won't be touched.

To re-run manually or for per-project setup:

```bash
cmux-agent-mcp init              # re-run global setup
cmux-agent-mcp init --project    # per-project setup (current dir)
cmux-agent-mcp init --root /path # per-project setup (specific dir)
```

### Install from source

```bash
git clone https://github.com/multiagentcognition/cmux-agent-mcp.git
cd cmux-agent-mcp
npm install --ignore-scripts
npm run build
node build/cli.js init       # register globally
```

## 81 MCP Tools

### Status & Discovery

| Tool | Description |
|------|-------------|
| `cmux_status` | Check if CMUX is installed/running, show hierarchy summary |
| `cmux_tree` | Full hierarchy tree of windows, workspaces, panes, surfaces |
| `cmux_identify` | Context info for focused window/workspace/pane/surface |
| `cmux_find` | Search across windows and panes by content or title |
| `cmux_start` | Launch CMUX if not running |
| `cmux_screenshot` | Capture screenshot of CMUX window |

### Workspace Management

| Tool | Description |
|------|-------------|
| `cmux_list_workspaces` | List all open workspaces |
| `cmux_current_workspace` | Get the currently active workspace |
| `cmux_new_workspace` | Create a new workspace with optional cwd/command |
| `cmux_select_workspace` | Switch to a specific workspace |
| `cmux_close_workspace` | Close a workspace and all its panes |
| `cmux_rename_workspace` | Rename a workspace (changes the sidebar name) |
| `cmux_reorder_workspace` | Reorder a workspace in the sidebar |
| `cmux_move_workspace_to_window` | Move a workspace to a different window |

### Window Management

| Tool | Description |
|------|-------------|
| `cmux_list_windows` | List all open windows |
| `cmux_current_window` | Get the currently focused window |
| `cmux_new_window` | Create a new window |
| `cmux_focus_window` | Focus a specific window |
| `cmux_close_window` | Close a window |
| `cmux_rename_window` | Rename a window (changes the title bar) |

### Surface (Tab) Management

| Tool | Description |
|------|-------------|
| `cmux_new_surface` | Create a new tab (terminal or browser) |
| `cmux_close_surface` | Close a tab |
| `cmux_rename_tab` | Rename a tab (changes the tab bar name) |
| `cmux_move_surface` | Move a tab to a different pane/workspace/window |
| `cmux_reorder_surface` | Reorder a tab within its pane |
| `cmux_drag_surface_to_split` | Turn a tab into its own split pane |

### Pane / Split Operations

| Tool | Description |
|------|-------------|
| `cmux_list_panes` | List all panes in a workspace |
| `cmux_list_pane_surfaces` | List pane surfaces with refs |
| `cmux_list_panels` | List all panels in a workspace |
| `cmux_new_split` | Split a pane (left/right/up/down) |
| `cmux_new_pane` | Create a new pane |
| `cmux_focus_pane` | Focus a specific pane |
| `cmux_resize_pane` | Resize a pane |
| `cmux_swap_pane` | Swap two panes |
| `cmux_break_pane` | Move a pane to its own workspace |
| `cmux_join_pane` | Merge a pane into another |
| `cmux_respawn_pane` | Restart a pane's process |

### Text I/O

| Tool | Description |
|------|-------------|
| `cmux_send` | Send text without pressing Enter |
| `cmux_send_submit` | Send text and press Enter |
| `cmux_send_key` | Send a key press (enter, ctrl+c, escape, etc.) |
| `cmux_send_panel` | Send text to a specific panel |
| `cmux_read_screen` | Read terminal output from a surface |
| `cmux_capture_pane` | tmux-compatible capture |

### Bulk Text Operations

| Tool | Description |
|------|-------------|
| `cmux_broadcast` | Send same text + Enter to ALL panes |
| `cmux_send_each` | Send DIFFERENT text to each pane (in order) |
| `cmux_send_submit_some` | Send text to SPECIFIC surfaces only |
| `cmux_send_key_all` | Send a key to ALL panes (e.g., ctrl+c to cancel all) |
| `cmux_read_all` | Read output from all panes |
| `cmux_read_all_deep` | Deep read — prompts idle agents for status |
| `cmux_workspace_snapshot` | Full snapshot: tree + all output + sidebar state |

### Sidebar Metadata

| Tool | Description |
|------|-------------|
| `cmux_set_status` | Set a sidebar status pill (key-value badge) |
| `cmux_clear_status` | Clear a status pill |
| `cmux_list_status` | List all status entries |
| `cmux_set_progress` | Set a progress indicator (0.0-1.0) |
| `cmux_clear_progress` | Clear the progress indicator |
| `cmux_log` | Write a log entry to the sidebar |
| `cmux_sidebar_state` | Get full sidebar state |

### Notifications

| Tool | Description |
|------|-------------|
| `cmux_notify` | Send a notification (blue ring + sidebar highlight) |
| `cmux_list_notifications` | List all notifications |
| `cmux_clear_notifications` | Clear all notifications |

### Browser Automation

| Tool | Description |
|------|-------------|
| `cmux_browser_open` | Open a browser surface |
| `cmux_browser_navigate` | Navigate: goto, back, forward, reload |
| `cmux_browser_snapshot` | DOM accessibility snapshot |
| `cmux_browser_screenshot` | Take a page screenshot |
| `cmux_browser_eval` | Execute JavaScript |
| `cmux_browser_click` | Click an element |
| `cmux_browser_fill` | Fill an input field |
| `cmux_browser_type` | Type text into an element |
| `cmux_browser_wait` | Wait for a condition (selector, text, URL, load state) |
| `cmux_browser_get` | Get page data (url, title, text, html, value, attr, count) |
| `cmux_browser_tab` | Manage browser tabs (new, list, switch, close) |
| `cmux_browser_console` | Get/clear console logs and errors |

### High-Level Launchers

| Tool | Description |
|------|-------------|
| `cmux_open_cli` | Open a single AI CLI in a new or existing workspace |
| `cmux_launch_agents` | Create workspace with N agents in a grid layout |
| `cmux_launch_grid` | Create an exact rows x cols grid of panes |
| `cmux_launch_mixed` | Launch different CLIs in one workspace |
| `cmux_orchestrate` | Send different prompts to specific surfaces in one call |
| `cmux_close_all` | Close all workspaces |

### Session Management

| Tool | Description |
|------|-------------|
| `cmux_session_save` | Save current state for crash recovery |
| `cmux_session_recover` | Recreate layout and resume CLI conversations |
| `cmux_session_reconcile` | Compare manifest vs live state, report drift |

## Orchestration Workflow

The typical multi-agent workflow:

```
1. cmux_launch_agents(cli: "claude", count: 4)
   → Creates a workspace with 4 Claude Code agents in a 2x2 grid

2. cmux_orchestrate(assignments: [
     { surface: "surface:10", text: "Implement the auth module..." },
     { surface: "surface:11", text: "Write tests for the API..." },
     { surface: "surface:12", text: "Refactor the database layer..." },
     { surface: "surface:13", text: "Update the documentation..." },
   ])
   → Each agent receives its specific task

3. cmux_read_all()
   → Check all agents' progress at once

4. cmux_read_all_deep()
   → Ask idle agents to summarize their status
```

Mixed-CLI orchestration:

```
cmux_launch_mixed(agents: [
  { cli: "claude", label: "Architect" },
  { cli: "gemini", label: "Reviewer" },
  { cli: "codex",  label: "Implementer" },
])
```

## Session Recovery

Sessions are **auto-saved** after every layout change. If CMUX crashes or you restart your machine, call `cmux_session_recover` to recreate everything — including resuming CLI conversations.

### CLI Session Resume

| CLI | Resume Method |
|-----|--------------|
| Claude Code | `--resume <session-id>` or `--continue` |
| Gemini CLI | `--resume latest` |
| Codex | `codex resume <session-id>` |
| OpenCode | `--session <session-id>` or `--continue` |
| Goose | `session --resume --session-id <session-id>` |

Session IDs are detected from each CLI's session storage:
- Claude: `~/.claude/sessions/*.json`
- Codex: `~/.codex/sessions/**/rollout-*.jsonl`
- Gemini: `~/.gemini/projects.json` + `~/.gemini/tmp/*/chats/*.json`
- OpenCode: `~/.local/share/opencode/opencode.db` (SQLite)
- Goose: `goose session list --format json`

## Auto-Trust & Permissions

When launching agents, cmux-agent-mcp automatically:
- **Claude Code**: Sets `hasTrustDialogAccepted: true` in `~/.claude.json`
- **Gemini CLI**: Adds directory to `~/.gemini/trustedFolders.json`
- **Codex**: Adds `trust_level = "trusted"` to `~/.codex/config.toml`
- **OpenCode**: Sets `permission: 'allow'` in its config

No permission prompts — agents start working immediately.

## ID Reference Format

CMUX uses ref format for IDs: `workspace:5`, `surface:8`, `pane:3`, `tab:2`, `window:1`. Always use the ref format, not bare numbers. Use `cmux_identify` or `cmux_list_pane_surfaces` to discover refs.

## CMUX Hierarchy

```
Window → Workspace(s) → Pane(s) → Surface(s) → Panel(s)
```

- **Window**: macOS window
- **Workspace**: Sidebar entry (like a "tab group")
- **Pane**: Split region within a workspace
- **Surface**: Tab within a pane (terminal or browser)
- **Panel**: Content inside a surface

## Naming Conventions

| What you see | What to rename |
|---|---|
| Sidebar entry | `cmux_rename_workspace` |
| Tab at top | `cmux_rename_tab` |
| Window title bar | `cmux_rename_window` |

## Platform Support

macOS only — CMUX is a native macOS application.

## Testing

The `test/full-test-suite.md` file contains a comprehensive test plan covering all 81 tools. Give it to any AI coding agent to execute:

```
Tag test/full-test-suite.md and say "Execute this test suite"
```

Tests leave all workspaces open for human visual verification before cleanup.

## License

[PolyForm Strict 1.0.0](https://polyformproject.org/licenses/strict/1.0.0)
