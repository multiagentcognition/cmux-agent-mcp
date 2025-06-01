/**
 * CMUX MCP Server
 *
 * Exposes CMUX's terminal multiplexer as MCP tools.
 * Agents can create workspaces, spawn panes, inject prompts, read output,
 * manage layouts, control the sidebar, send notifications, and automate
 * the built-in browser without knowing the CLI syntax.
 */

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Server Configuration
// ---------------------------------------------------------------------------

const PROJECT_ROOT: string | undefined =
  process.env['CMUX_PROJECT_ROOT'] ??
  process.env['MACP_PROJECT_ROOT'] ??
  process.cwd();

// ---------------------------------------------------------------------------
// CLI Definitions — all supported AI coding CLIs
// ---------------------------------------------------------------------------

type CliDef = {
  bin: string;
  skipPermFlags: string[];
  skipPermEnv?: Record<string, string>;
  label: string;
};

const CLI_DEFS: Record<string, CliDef> = {
  claude: {
    bin: 'claude',
    skipPermFlags: ['--dangerously-skip-permissions'],
    label: 'Claude Code',
  },
  gemini: {
    bin: 'gemini',
    skipPermFlags: ['--no-sandbox'],
    label: 'Gemini CLI',
  },
  codex: {
    bin: 'codex',
    skipPermFlags: ['-a', 'never'],
    label: 'Codex CLI',
  },
  opencode: {
    bin: 'opencode',
    skipPermFlags: [],
    label: 'OpenCode',
  },
  goose: {
    bin: 'goose',
    skipPermFlags: [],
    skipPermEnv: { GOOSE_MODE: 'auto' },
    label: 'Goose',
  },
};

// ---------------------------------------------------------------------------
// CMUX CLI Helpers
// ---------------------------------------------------------------------------

function cmuxBin(): string {
  if (process.env['CMUX_BIN']) return process.env['CMUX_BIN'];
  const bundled = '/Applications/cmux.app/Contents/Resources/bin/cmux';
  if (existsSync(bundled)) return bundled;
  return 'cmux';
}

function cmux(...args: string[]): string {
  try {
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    if (process.env['CMUX_SOCKET_PATH']) {
      env['CMUX_SOCKET_PATH'] = process.env['CMUX_SOCKET_PATH'];
    }
    return execFileSync(cmuxBin(), args, {
      encoding: 'utf8',
      timeout: 30_000,
      env,
    }).trim();
  } catch (err: any) {
    throw new Error(`cmux ${args.join(' ')} failed: ${err.stderr || err.message}`);
  }
}

function cmuxJson(...args: string[]): any {
  const raw = cmux(...args, '--json');
  return JSON.parse(raw);
}

function isCmuxInstalled(): boolean {
  const bundled = '/Applications/cmux.app/Contents/Resources/bin/cmux';
  if (existsSync(bundled)) return true;
  try {
    execSync('which cmux', { encoding: 'utf8', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function isCmuxRunning(): boolean {
  try {
    cmux('ping');
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function ok(data: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
}

function err(message: string): { content: { type: 'text'; text: string }[]; isError: true } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Wrap a tool handler with standard error handling */
function safe(fn: (...args: any[]) => any) {
  return async (...args: any[]) => {
    try {
      return await fn(...args);
    } catch (e: any) {
      return err(e.message ?? String(e));
    }
  };
}

/** Wrap a MUTATING tool handler — auto-saves session after success */
function safeMut(fn: (...args: any[]) => any) {
  return async (...args: any[]) => {
    try {
      const result = await fn(...args);
      scheduleAutoSave();
      return result;
    } catch (e: any) {
      return err(e.message ?? String(e));
    }
  };
}

/** Default workspace/surface from params or env */
function wsArgs(workspace?: string, surface?: string): string[] {
  const args: string[] = [];
  const ws = workspace ?? process.env['CMUX_WORKSPACE_ID'];
  const sf = surface ?? process.env['CMUX_SURFACE_ID'];
  if (ws) args.push('--workspace', ws);
  if (sf) args.push('--surface', sf);
  return args;
}

// ---------------------------------------------------------------------------
// Auto-save — save manifest after mutating operations
// ---------------------------------------------------------------------------

let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleAutoSave(): void {
  // Will be implemented with session management
  return;
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({ name: 'cmux-swarm', version: '0.1.0' });

// ---------------------------------------------------------------------------
// ID Format Note:
// CMUX uses ref format for IDs: "workspace:N", "surface:N", "pane:N", "tab:N", "window:N"
// where N is a number. Always use the ref format (e.g., "surface:8") not bare numbers ("8").
// Use cmux_identify, cmux_tree, cmux_list_panes, or cmux_list_pane_surfaces to discover refs.
// ---------------------------------------------------------------------------

// ============================================================================
// A. STATUS & DISCOVERY
// ============================================================================

server.tool(
  'cmux_status',
  'Check if CMUX is installed and running. Shows project config and full hierarchy.',
  {},
  safe(async () => {
    const installed = isCmuxInstalled();
    const running = installed ? isCmuxRunning() : false;

    if (!running) {
      return ok({
        installed,
        running: false,
        project_root: PROJECT_ROOT ?? '(not set)',
        note: installed
          ? 'CMUX is installed but not running. Open cmux.app to start it.'
          : 'CMUX is not installed. Install with: brew tap manaflow-ai/cmux && brew install --cask cmux',
      });
    }

    let tree: string | undefined;
    try { tree = cmux('tree', '--all'); } catch { /* ignore */ }

    return ok({
      installed: true,
      running: true,
      project_root: PROJECT_ROOT ?? '(not set)',
      supported_clis: Object.keys(CLI_DEFS),
      tree,
    });
  }),
);

server.tool(
  'cmux_tree',
  'Show full hierarchy tree of windows, workspaces, panes, surfaces, and panels.',
  {
    workspace: z.string().optional().describe('Workspace ID/ref to scope the tree'),
    all: z.boolean().optional().describe('Show all windows (default: current)'),
  },
  safe(async ({ workspace, all }) => {
    const args = ['tree'];
    if (all) args.push('--all');
    if (workspace) args.push('--workspace', workspace);
    return ok(cmux(...args));
  }),
);

server.tool(
  'cmux_identify',
  'Show context info for the current CMUX session — focused window, workspace, pane, surface refs. Call this first to discover IDs for other tools.',
  {
    workspace: z.string().optional().describe('Workspace ID/ref'),
    surface: z.string().optional().describe('Surface ID/ref'),
  },
  safe(async ({ workspace, surface }) => {
    const args = ['identify', ...wsArgs(workspace, surface)];
    return ok(cmux(...args));
  }),
);

server.tool(
  'cmux_find',
  'Search across windows and panes by content or title.',
  {
    query: z.string().describe('Search query'),
    content: z.boolean().optional().describe('Search pane content (not just titles)'),
    select: z.boolean().optional().describe('Auto-select the matching pane'),
  },
  safe(async ({ query, content, select }) => {
    const args = ['find-window'];
    if (content) args.push('--content');
    if (select) args.push('--select');
    args.push(query);
    return ok(cmux(...args));
  }),
);

// ============================================================================
// B. WORKSPACE MANAGEMENT
// ============================================================================

server.tool(
  'cmux_list_workspaces',
  'List all open workspaces.',
  {},
  safe(async () => ok(cmux('list-workspaces'))),
);

server.tool(
  'cmux_current_workspace',
  'Get the currently active workspace.',
  {},
  safe(async () => ok(cmux('current-workspace'))),
);

server.tool(
  'cmux_new_workspace',
  'Create a new workspace with optional working directory and command.',
  {
    cwd: z.string().optional().describe('Working directory for the new workspace'),
    command: z.string().optional().describe('Command to run in the initial pane'),
  },
  safeMut(async ({ cwd, command }) => {
    const args = ['new-workspace'];
    if (cwd) args.push('--cwd', cwd);
    if (command) args.push('--command', command);
    return ok(cmux(...args));
  }),
);

server.tool(
  'cmux_select_workspace',
  'Switch to a specific workspace.',
  {
    workspace: z.string().describe('Workspace ID or ref to switch to'),
  },
  safe(async ({ workspace }) => ok(cmux('select-workspace', '--workspace', workspace))),
);

server.tool(
  'cmux_close_workspace',
  'Close a workspace and all its panes.',
  {
    workspace: z.string().describe('Workspace ID or ref to close'),
  },
  safeMut(async ({ workspace }) => ok(cmux('close-workspace', '--workspace', workspace))),
);

server.tool(
  'cmux_rename_workspace',
  'Rename a workspace.',
  {
    title: z.string().describe('New workspace title'),
    workspace: z.string().optional().describe('Workspace ID/ref (default: current)'),
  },
  safeMut(async ({ title, workspace }) => {
    const args = ['rename-workspace'];
    if (workspace) args.push('--workspace', workspace);
    args.push(title);
    return ok(cmux(...args));
  }),
);

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

export async function runServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
