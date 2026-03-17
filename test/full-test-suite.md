# cmux-agent-mcp Parallel Test Suite

**cmux-agent-mcp tests itself.** The orchestrator uses CMUX MCP tools to spawn 6 Claude agents in a grid, each running a subset of tests in parallel. Uses MACP for coordination and result collection.

**Tools under test:** All 81 cmux-agent-mcp MCP tools.

---

## INSTRUCTIONS FOR THE ORCHESTRATOR AGENT

You are the **orchestrator**. You do NOT run the tests yourself. You use cmux-agent-mcp to spawn 6 Claude agents, distribute test groups to each, collect results via MACP, and produce the final report.

### Phase 1: Launch all 6 runners (ONE tool call)

Call `cmux_launch_agents` with ALL of the following in a SINGLE call:

```json
{
  "cli": "claude",
  "count": 6,
  "workspace_name": "Test Runners",
  "tab_names": [
    "Runner A: Status+WS+Win",
    "Runner B: Surfaces+Panes",
    "Runner C: Text IO+Bulk",
    "Runner D: Sidebar+Move",
    "Runner E: Launchers+Sessions",
    "Runner F: Browser+Find"
  ],
  "assignments": [
    "<RUNNER_A_PROMPT>",
    "<RUNNER_B_PROMPT>",
    "<RUNNER_C_PROMPT>",
    "<RUNNER_D_PROMPT>",
    "<RUNNER_E_PROMPT>",
    "<RUNNER_F_PROMPT>"
  ],
  "progress": 0.15,
  "progress_label": "Tests dispatched to 6 runners..."
}
```

This single call does everything: creates the workspace, builds the 3×2 grid, launches Claude Code in all 6 panes, waits for CLIs to start, renames each tab, sends each runner its unique prompt, and sets the progress bar. The response includes `surfaces` (all 6 surface refs) and `workspace_ref`.

**DO NOT use `cmux_launch_grid` — that creates empty panes without CLIs. DO NOT make separate calls for renaming tabs, launching CLIs, or sending prompts. `cmux_launch_agents` does it all.**

Each runner's prompt (the `assignments` array) should follow this template:

```
You are test runner [A-F]. Execute the test steps below using cmux-agent-mcp MCP tools.
For every Verify instruction, actually inspect the returned data.
Track every check as PASS or FAIL.
DO NOT clean up — leave all workspaces open.
Each test creates its OWN workspaces — do not touch the "Test Runners" workspace.

When done, send your results via macp_send_channel with channel "sensei" in this exact JSON format:
{"runner": "[A-F]", "tests": [01,02,...], "total": N, "passed": N, "failed": N, "results": [{"test": "01", "step": "1.1", "check": "description", "result": "PASS|FAIL", "details": "..."}]}

Here are your test sections:

[PASTE THE RELEVANT TEST GROUP BELOW]
```

### Phase 4: Monitor progress

Poll with `cmux_read_all` every 30 seconds to watch progress. Use `cmux_set_progress` on the orchestrator workspace to show overall completion (0/6, 1/6, ... 6/6).

Also poll `macp_poll` to check for result messages from runners.

### Phase 5: Collect results

Wait for all 6 runners to send their results via MACP. As each arrives:
1. Parse the JSON results
2. Update `cmux_set_status` with runner status (e.g., `Runner A: 7/7 PASS`)
3. Acknowledge with `macp_ack`

If a runner hasn't reported within 10 minutes, read its screen with `cmux_read_screen` to check status.

### Phase 6: Human Verification Gate

**STOP HERE. Do NOT clean up automatically.**

All test workspaces are still open in CMUX for the user to visually inspect.

**Print the Final Report first**, then ask the user:

> "All 6 test runners are complete and the report is above. All test workspaces are still open in CMUX for you to visually inspect. Once you've verified everything looks correct, would you like me to clean up all test workspaces?"

**Only after the user confirms**, close each test workspace by name. Do NOT use `cmux_close_all`.

### Phase 7: Final Report

Print the combined report from all 6 runners:

```markdown
# cmux-agent-mcp Test Report (Parallel)

**Date:** <current date/time>
**Execution mode:** 6 parallel runners via cmux-agent-mcp self-test
**Total checks:** <number>
**Passed:** <number>
**Failed:** <number>
**Pass rate:** <percentage>

## Results

| Runner | Test | Step | Check | Result | Details |
|--------|------|------|-------|--------|---------|
| A | 01 | 1.1 | Status installed=true | PASS/FAIL | <details> |
| ... | ... | ... | ... | ... | ... |

## Failed Checks (for fixing)

<List only the FAIL rows with full error details, surface refs, and the exact
error message returned by the tool. This section can be given directly to the
AI to fix the MCP.>

## Tools Not Tested

<List any of the 81 tools that were NOT exercised by this test suite.>

## Runner Timing

| Runner | Tests | Duration | Status |
|--------|-------|----------|--------|
| A | 01, 02, 03 | Xm Ys | PASS/FAIL |
| B | 04, 05 | Xm Ys | PASS/FAIL |
| C | 06, 07 | Xm Ys | PASS/FAIL |
| D | 08, 09 | Xm Ys | PASS/FAIL |
| E | 10, 11 | Xm Ys | PASS/FAIL |
| F | 12, 13 | Xm Ys | PASS/FAIL |
```

---

## Test Groups

Each group is self-contained. Every test creates its own workspaces with unique names to avoid collisions between runners.

---

### GROUP A: Status, Discovery, Workspace Management, Window Management (Tests 01-03)

#### Test 01: Status and Discovery

**Tools tested:** `cmux_status`, `cmux_tree`, `cmux_identify`, `cmux_find`, `cmux_list_workspaces`, `cmux_current_workspace`, `cmux_list_windows`, `cmux_current_window`

##### Step 1.1 — Status check

Call `cmux_status`.

**Verify:**
- Response contains `installed: true`
- Response contains `running: true`
- `supported_clis` is an array containing "claude", "gemini", "codex", "opencode", "goose"
- `project_root` is a non-empty string

##### Step 1.2 — Tree view

Call `cmux_tree` with `all: true`.

**Verify:** Response is a non-empty string containing text (the hierarchy tree).

##### Step 1.3 — Identify

Call `cmux_identify`.

**Verify:** Response is non-empty and contains ref-formatted IDs (strings matching patterns like `workspace:\d+`, `surface:\d+`, etc).

##### Step 1.4 — List workspaces

Call `cmux_list_workspaces`.

**Verify:** Response is non-empty (at least one workspace exists).

##### Step 1.5 — Current workspace

Call `cmux_current_workspace`.

**Verify:** Response contains a workspace identifier.

##### Step 1.6 — List windows

Call `cmux_list_windows`.

**Verify:** Response is non-empty.

##### Step 1.7 — Current window

Call `cmux_current_window`.

**Verify:** Response contains a window identifier.

#### Test 02: Workspace Management

**Tools tested:** `cmux_new_workspace`, `cmux_rename_workspace`, `cmux_select_workspace`, `cmux_reorder_workspace`, `cmux_close_workspace`

##### Step 2.1 — Create workspace

Call `cmux_new_workspace` with `cwd: "/tmp/cmux-test-A"`.

**Verify:** Response is non-empty (no error). Record the response.

##### Step 2.2 — List workspaces and find new one

Call `cmux_list_workspaces`.

**Verify:** Record a workspace ref for the new workspace.

##### Step 2.3 — Rename workspace

Call `cmux_rename_workspace` with `title: "A-Test Suite WS"`.

**Verify:** Response indicates success (no error).

##### Step 2.4 — Select workspace

Call `cmux_list_workspaces` to find another workspace ref.
Call `cmux_select_workspace` with that ref.

**Verify:** Response indicates success. Call `cmux_current_workspace` and verify it changed.

##### Step 2.5 — Close the test workspace

Call `cmux_list_workspaces` to find the "A-Test Suite WS" workspace ref.
Call `cmux_close_workspace` with that ref.

**Verify:** Response indicates success. Call `cmux_list_workspaces` and verify the workspace count decreased.

#### Test 03: Window Management

**Tools tested:** `cmux_new_window`, `cmux_focus_window`, `cmux_rename_window`, `cmux_close_window`

##### Step 3.1 — Create window

Call `cmux_list_windows` and record count as WINDOWS_BEFORE.
Call `cmux_new_window`.

**Verify:** Response is non-empty. Call `cmux_list_windows` — count should be WINDOWS_BEFORE + 1. Record the new window ref.

##### Step 3.2 — Rename window

Call `cmux_rename_window` with `title: "A-Test Window"`.

**Verify:** Response indicates success.

##### Step 3.3 — Focus original window

Call `cmux_list_windows` to get the original window ref.
Call `cmux_focus_window` with that ref.

**Verify:** Response indicates success.

##### Step 3.4 — Close test window

Call `cmux_close_window` with the test window ref from Step 3.1.

**Verify:** Response indicates success. Call `cmux_list_windows` — count should be back to WINDOWS_BEFORE.

---

### GROUP B: Surfaces, Tabs, Pane Splits, Pane Operations (Tests 04-05)

#### Test 04: Surfaces, Tabs, and Pane Splits

**Tools tested:** `cmux_new_workspace`, `cmux_new_split`, `cmux_new_surface`, `cmux_new_pane`, `cmux_list_panes`, `cmux_list_pane_surfaces`, `cmux_list_panels`, `cmux_rename_tab`, `cmux_close_surface`

##### Step 4.1 — Create a test workspace

Call `cmux_new_workspace` with `cwd: "/tmp/cmux-test-B-04"`.
Call `cmux_rename_workspace` with `title: "B-Split Test"`.

**Verify:** Success.

##### Step 4.2 — Split right

Call `cmux_new_split` with `direction: "right"`.

**Verify:** Response is non-empty. Call `cmux_list_panes` — should show 2 panes.

##### Step 4.3 — Split down

Call `cmux_new_split` with `direction: "down"`.

**Verify:** Call `cmux_list_panes` — should show 3 panes.

##### Step 4.4 — List pane surfaces

Call `cmux_list_pane_surfaces`.

**Verify:** Response contains at least 3 `surface:\d+` refs. Record all surface refs as SURF_A, SURF_B, SURF_C.

##### Step 4.5 — List panels

Call `cmux_list_panels`.

**Verify:** Response is non-empty.

##### Step 4.6 — Create a new surface (tab)

Call `cmux_list_panes` and get a pane ref.
Call `cmux_new_surface` with `type: "terminal"` and `pane: <pane_ref>`.

**Verify:** Response indicates a new surface was created. Call `cmux_list_pane_surfaces` — should have one more surface than before.

##### Step 4.7 — Rename a tab

Call `cmux_rename_tab` with `title: "B-My Test Tab"` and `surface: SURF_A`.

**Verify:** Response indicates success.

##### Step 4.8 — Close the extra surface

Call `cmux_close_surface` with the surface created in Step 4.6.

**Verify:** Response indicates success.

#### Test 05: Pane Operations

**Tools tested:** `cmux_focus_pane`, `cmux_resize_pane`, `cmux_swap_pane`, `cmux_break_pane`, `cmux_join_pane`, `cmux_respawn_pane`

##### Step 5.1 — Setup: create workspace with 2 panes

Call `cmux_new_workspace`.
Call `cmux_rename_workspace` with `title: "B-Pane Ops Test"`.
Call `cmux_new_split` with `direction: "right"`.
Call `cmux_list_panes`. Record two pane refs as PANE_1, PANE_2.

**Verify:** 2 panes exist.

##### Step 5.2 — Focus pane

Call `cmux_focus_pane` with `pane: PANE_1`.

**Verify:** Response indicates success.

##### Step 5.3 — Resize pane

Call `cmux_resize_pane` with `pane: PANE_1`, `direction: "R"`, `amount: 5`.

**Verify:** Response indicates success (no error).

##### Step 5.4 — Swap panes

Call `cmux_swap_pane` with `pane: PANE_1`, `target_pane: PANE_2`.

**Verify:** Response indicates success.

##### Step 5.5 — Respawn pane

Call `cmux_respawn_pane`.

**Verify:** Response indicates success.

##### Step 5.6 — Break pane

Call `cmux_list_workspaces` and record count as WS_BEFORE.
Call `cmux_break_pane` with `pane: PANE_2`.

**Verify:** Call `cmux_list_workspaces` — count should be WS_BEFORE + 1.

---

### GROUP C: Text I/O and Bulk Text Operations (Tests 06-07)

#### Test 06: Text I/O

**Tools tested:** `cmux_send`, `cmux_send_submit`, `cmux_send_key`, `cmux_read_screen`, `cmux_capture_pane`, `cmux_send_panel`

##### Step 6.1 — Setup

Call `cmux_new_workspace` with `cwd: "/tmp/cmux-test-C-06"`.
Call `cmux_rename_workspace` with `title: "C-Text IO Test"`.
Call `cmux_list_pane_surfaces`. Record surface ref as SURF.

##### Step 6.2 — Send text without Enter

Call `cmux_send` with `text: "echo HELLO_C_TEST"`, `surface: SURF`.

**Verify:** Response indicates success. Call `cmux_read_screen` with `surface: SURF` — should show `echo HELLO_C_TEST` on the command line (not executed yet).

##### Step 6.3 — Send Enter key

Call `cmux_send_key` with `key: "enter"`, `surface: SURF`.

Wait 1 second. Call `cmux_read_screen` with `surface: SURF`, `lines: 10`.

**Verify:** Output contains `HELLO_C_TEST` (the echo result).

##### Step 6.4 — Send text with submit

Call `cmux_send_submit` with `text: "echo SUBMIT_C_42"`, `surface: SURF`.

Wait 1 second. Call `cmux_read_screen` with `surface: SURF`, `lines: 10`.

**Verify:** Output contains `SUBMIT_C_42`.

##### Step 6.5 — Capture pane

Call `cmux_capture_pane` with `lines: 20`.

**Verify:** Output contains `SUBMIT_C_42`.

##### Step 6.6 — Read with scrollback

Call `cmux_read_screen` with `scrollback: true`, `lines: 50`.

**Verify:** Output contains both `HELLO_C_TEST` and `SUBMIT_C_42`.

#### Test 07: Bulk Text Operations

**Tools tested:** `cmux_broadcast`, `cmux_send_each`, `cmux_send_submit_some`, `cmux_send_key_all`, `cmux_read_all`

##### Step 7.1 — Setup: workspace with 3 panes

Call `cmux_new_workspace`.
Call `cmux_rename_workspace` with `title: "C-Bulk Text Test"`.
Call `cmux_new_split` with `direction: "right"`.
Call `cmux_new_split` with `direction: "down"`.
Call `cmux_list_pane_surfaces`. Record 3 surface refs.

##### Step 7.2 — Broadcast

Call `cmux_broadcast` with `text: "echo BROADCAST_C"`.

Wait 2 seconds. Call `cmux_read_all` with `lines: 5`.

**Verify:** `total` is 3. ALL 3 panes' output contains `BROADCAST_C`.

##### Step 7.3 — Send each

Call `cmux_send_each` with `texts: ["echo C_ONE", "echo C_TWO", "echo C_THREE"]`.

Wait 2 seconds. Call `cmux_read_all` with `lines: 5`.

**Verify:** Pane outputs contain `C_ONE`, `C_TWO`, `C_THREE` respectively.

##### Step 7.4 — Send to specific surfaces

Call `cmux_send_submit_some` with the first 2 surface refs and `text: "echo C_SELECTED"`.

Wait 2 seconds. Call `cmux_read_all` with `lines: 5`.

**Verify:** First 2 panes contain `C_SELECTED`. Third pane does NOT.

##### Step 7.5 — Send key to all

Call `cmux_send_key_all` with `key: "enter"`.

**Verify:** Response shows `sent_to: 3`.

---

### GROUP D: Sidebar Metadata, Notifications, Move/Reorder (Tests 08-09)

#### Test 08: Sidebar Metadata and Notifications

**Tools tested:** `cmux_set_status`, `cmux_list_status`, `cmux_clear_status`, `cmux_set_progress`, `cmux_clear_progress`, `cmux_log`, `cmux_sidebar_state`, `cmux_notify`, `cmux_list_notifications`, `cmux_clear_notifications`

##### Step 8.1 — Setup

Call `cmux_new_workspace`.
Call `cmux_rename_workspace` with `title: "D-Sidebar Test"`.

##### Step 8.2 — Set status

Call `cmux_set_status` with `key: "build_d"`, `value: "passing"`, `icon: "check"`, `color: "#00ff00"`.

**Verify:** Response indicates success.

##### Step 8.3 — List status

Call `cmux_list_status`.

**Verify:** Response contains "build_d" and "passing".

##### Step 8.4 — Set progress

Call `cmux_set_progress` with `progress: 0.75`, `label: "Testing D..."`.

**Verify:** Response indicates success.

##### Step 8.5 — Log entry

Call `cmux_log` with `message: "Test log D"`, `level: "info"`, `source: "runner-d"`.

**Verify:** Response indicates success.

##### Step 8.6 — Sidebar state

Call `cmux_sidebar_state`.

**Verify:** Response is non-empty and contains sidebar data.

##### Step 8.7 — Notify

Call `cmux_notify` with `title: "Runner D Notification"`, `body: "Test from runner D"`.

**Verify:** Response indicates success.

##### Step 8.8 — List notifications

Call `cmux_list_notifications`.

**Verify:** Response contains notification data.

##### Step 8.9 — Clear everything

Call `cmux_clear_status` with `key: "build_d"`.
Call `cmux_clear_progress`.
Call `cmux_clear_notifications`.

**Verify:** All three return success. Call `cmux_list_status` — should NOT contain "build_d".

#### Test 09: Move and Reorder Operations

**Tools tested:** `cmux_move_surface`, `cmux_reorder_surface`, `cmux_drag_surface_to_split`, `cmux_reorder_workspace`, `cmux_move_workspace_to_window`

##### Step 9.1 — Setup: 2 workspaces, first with 2 tabs

Call `cmux_new_workspace`.
Call `cmux_rename_workspace` with `title: "D-Move Test A"`.
Call `cmux_list_panes`. Record a pane ref.
Call `cmux_new_surface` with `type: "terminal"` and the pane ref.
Call `cmux_list_pane_surfaces`. Record surface refs as SURF_1, SURF_2.

Call `cmux_new_workspace`.
Call `cmux_rename_workspace` with `title: "D-Move Test B"`.

##### Step 9.2 — Reorder surfaces (tabs)

Call `cmux_reorder_surface` with `surface: SURF_2`, `index: 0`.

**Verify:** Response indicates success.

##### Step 9.3 — Drag surface to split

Call `cmux_drag_surface_to_split` with `surface: SURF_1`, `direction: "right"`.

**Verify:** Response indicates success. Call `cmux_list_panes` — should show 2 panes.

##### Step 9.4 — Reorder workspaces

Call `cmux_list_workspaces`. Find refs for "D-Move Test A" and "D-Move Test B".
Call `cmux_reorder_workspace` with the "D-Move Test B" workspace and `index: 0`.

**Verify:** Response indicates success.

---

### GROUP E: High-Level Launchers, Orchestration, Session Management (Tests 10-11)

#### Test 10: High-Level Launchers and Orchestration

**Tools tested:** `cmux_launch_agents`, `cmux_launch_grid`, `cmux_launch_mixed`, `cmux_open_cli`, `cmux_orchestrate`, `cmux_read_all`, `cmux_read_all_deep`, `cmux_workspace_snapshot`

##### Step 10.1 — Launch grid (2x2)

Call `cmux_launch_grid` with `rows: 2`, `cols: 2`, `workspace_name: "E-Grid Test"`.

**Verify:** Response contains `grid: "2x2"`. Call `cmux_list_pane_surfaces` — should show 4 surface refs.

##### Step 10.2 — Send echo to each pane

Call `cmux_send_each` with `texts: ["echo E_A", "echo E_B", "echo E_C", "echo E_D"]`.

Wait 2 seconds.

##### Step 10.3 — Read all

Call `cmux_read_all` with `lines: 5`.

**Verify:** `total` is 4. Outputs contain `E_A`, `E_B`, `E_C`, `E_D`.

##### Step 10.4 — Workspace snapshot

Call `cmux_workspace_snapshot` with `lines: 5`.

**Verify:** Response contains `tree` (non-null), `sidebar` (non-null), `total_panes: 4`, and `panes` array with 4 entries.

##### Step 10.5 — Open single CLI

Call `cmux_open_cli` with `cli: "claude"`, `workspace_name: "E-Claude Solo"`, `cwd: "/tmp/cmux-test-E-10"`.

Wait 3 seconds.

**Verify:** Response has `cli: "claude"` and a `surface` ref. Call `cmux_read_screen` on that surface — output should contain "claude" or "Claude".

##### Step 10.6 — Launch mixed agents

Call `cmux_launch_mixed` with:
```json
{
  "agents": [
    {"cli": "claude", "label": "E-Writer"},
    {"cli": "claude", "label": "E-Reviewer"}
  ],
  "workspace_name": "E-Mixed Agents",
  "cwd": "/tmp/cmux-test-E-10"
}
```

Wait 3 seconds.

**Verify:** Response has `launched` array with 2 entries.

##### Step 10.7 — Orchestrate

Get the surface refs from the launched mixed agents.
Call `cmux_orchestrate` with:
```json
{
  "assignments": [
    {"surface": "<first>", "text": "echo E_WRITER"},
    {"surface": "<second>", "text": "echo E_REVIEWER"}
  ]
}
```

Wait 2 seconds. Call `cmux_read_all`.

**Verify:** `sent` equals 2. Outputs contain `E_WRITER` and `E_REVIEWER`.

##### Step 10.8 — Read all deep

Call `cmux_read_all_deep` with `lines: 10`.

**Verify:** Response has `total` and `panes` array. Each pane has `queried` boolean field.

#### Test 11: Session Management

**Tools tested:** `cmux_session_save`, `cmux_session_reconcile`, `cmux_session_recover`

##### Step 11.1 — Setup

Call `cmux_new_workspace` with `cwd: "/tmp/cmux-test-E-11"`.
Call `cmux_rename_workspace` with `title: "E-Session Test"`.
Call `cmux_new_split` with `direction: "right"`.
Call `cmux_send_submit` with `text: "echo E_SESSION_A"` on the first surface.
Call `cmux_send_submit` with `text: "echo E_SESSION_B"` on the second surface.

Wait 1 second.

##### Step 11.2 — Save session

Call `cmux_session_save`.

**Verify:**
- `saved` is `true`
- `workspaces` is at least 1
- `surfaces` is at least 2
- `path` is a non-empty string

##### Step 11.3 — Reconcile (in sync)

Call `cmux_session_reconcile`.

**Verify:** `has_manifest` is `true`. `in_sync` is `true`.

##### Step 11.4 — Detect drift

Call `cmux_new_split` with `direction: "down"`.
Call `cmux_session_reconcile`.

**Verify:** `in_sync` is `false`. `appeared` should be non-empty.

##### Step 11.5 — Save and re-reconcile

Call `cmux_session_save`.
Call `cmux_session_reconcile`.

**Verify:** `in_sync` is `true`.

---

### GROUP F: Browser Automation, Find, Screenshot (Tests 12-13)

#### Test 12: Browser Automation

**Tools tested:** `cmux_browser_open`, `cmux_browser_navigate`, `cmux_browser_get`, `cmux_browser_snapshot`, `cmux_browser_wait`, `cmux_browser_eval`, `cmux_browser_console`

##### Step 12.1 — Setup

Call `cmux_new_workspace`.
Call `cmux_rename_workspace` with `title: "F-Browser Test"`.

##### Step 12.2 — Open browser

Call `cmux_browser_open` with `url: "https://example.com"`.

Wait 3 seconds.

**Verify:** Response indicates success.

##### Step 12.3 — Get page URL

Call `cmux_browser_get` with `property: "url"`.

**Verify:** Response contains "example.com".

##### Step 12.4 — Get page title

Call `cmux_browser_get` with `property: "title"`.

**Verify:** Response contains "Example Domain" (or similar).

##### Step 12.5 — DOM snapshot

Call `cmux_browser_snapshot` with `compact: true`.

**Verify:** Response is non-empty and contains DOM content.

##### Step 12.6 — Evaluate JavaScript

Call `cmux_browser_eval` with `script: "document.title"`.

**Verify:** Response contains "Example Domain".

##### Step 12.7 — Navigate

Call `cmux_browser_navigate` with `action: "goto"`, `url: "https://httpbin.org/html"`.

Wait 3 seconds. Call `cmux_browser_get` with `property: "url"`.

**Verify:** Response contains "httpbin.org".

##### Step 12.8 — Console

Call `cmux_browser_console` with `type: "console"`, `action: "list"`.

**Verify:** Response is non-empty (even if empty list — no error).

#### Test 13: Find and Screenshot

**Tools tested:** `cmux_find`, `cmux_screenshot`, `cmux_start`

##### Step 13.1 — Create a workspace with a known title

Call `cmux_new_workspace`.
Call `cmux_rename_workspace` with `title: "F-Findable WS"`.
Call `cmux_send_submit` with `text: "echo UNIQUE_F_FINDME"`.

Wait 1 second.

##### Step 13.2 — Find by title

Call `cmux_find` with `query: "F-Findable"`.

**Verify:** Response is non-empty (found the workspace).

##### Step 13.3 — Find by content

Call `cmux_find` with `query: "UNIQUE_F_FINDME"`, `content: true`.

**Verify:** Response is non-empty (found the pane by content).

##### Step 13.4 — Screenshot

Call `cmux_screenshot`.

**Verify:** Response contains a `screenshot` path ending in `.png`.
