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
// Session Manifest — tracks what's running for crash recovery
// ---------------------------------------------------------------------------

type SurfaceManifest = {
  surface_ref: string;
  cli: string;
  session_id: string | null;
  cwd: string;
};

type WorkspaceManifest = {
  workspace_ref: string;
  name: string;
  surfaces: SurfaceManifest[];
};

type SessionManifest = {
  saved_at: string;
  project_root: string;
  git_branch: string | null;
  workspaces: WorkspaceManifest[];
};

const MANIFEST_DIR = PROJECT_ROOT ? join(PROJECT_ROOT, '.cmux-swarm') : join(homedir(), '.cmux-swarm');
const MANIFEST_PATH = join(MANIFEST_DIR, 'session.json');

function saveManifest(manifest: SessionManifest): void {
  mkdirSync(MANIFEST_DIR, { recursive: true });
  if (existsSync(MANIFEST_PATH)) {
    const backupPath = join(MANIFEST_DIR, 'session.backup.json');
    try { renameSync(MANIFEST_PATH, backupPath); } catch { /* ignore */ }
  }
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

function loadManifest(): SessionManifest | null {
  try {
    if (!existsSync(MANIFEST_PATH)) return null;
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CLI Session ID Detection
// ---------------------------------------------------------------------------

function detectCliFromScreen(screenText: string): string | null {
  const lower = screenText.toLowerCase();
  if (lower.includes('claude') && (lower.includes('code') || lower.includes('anthropic'))) return 'claude';
  if (lower.includes('gemini')) return 'gemini';
  if (lower.includes('codex')) return 'codex';
  if (lower.includes('opencode')) return 'opencode';
  if (lower.includes('goose')) return 'goose';
  return null;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

function getSessionId(cli: string, cwd: string): string | null {
  try {
    switch (cli) {
      case 'claude': {
        const sessionsDir = join(homedir(), '.claude', 'sessions');
        if (!existsSync(sessionsDir)) return null;
        const files = readdirSync(sessionsDir)
          .filter(f => f.endsWith('.json'))
          .map(f => {
            const full = join(sessionsDir, f);
            try {
              const data = JSON.parse(readFileSync(full, 'utf8'));
              return { mtime: statSync(full).mtimeMs, cwd: data.cwd, sessionId: data.sessionId };
            } catch { return null; }
          })
          .filter((f): f is NonNullable<typeof f> => f !== null)
          .sort((a, b) => b.mtime - a.mtime);

        const cwdMatch = files.find(f => f.cwd && normalizePath(f.cwd) === normalizePath(cwd));
        if (cwdMatch) return cwdMatch.sessionId ?? null;
        if (files.length > 0) return files[0]!.sessionId ?? null;
        return null;
      }

      case 'codex': {
        const codexDir = join(homedir(), '.codex', 'sessions');
        if (!existsSync(codexDir)) return null;
        const files: { mtime: number; path: string }[] = [];
        const walk = (dir: string) => {
          for (const entry of readdirSync(dir)) {
            const full = join(dir, entry);
            const st = statSync(full);
            if (st.isDirectory()) { walk(full); }
            else if (entry.startsWith('rollout-') && entry.endsWith('.jsonl')) {
              files.push({ mtime: st.mtimeMs, path: full });
            }
          }
        };
        walk(codexDir);
        files.sort((a, b) => b.mtime - a.mtime);

        for (const file of files) {
          try {
            const firstLine = readFileSync(file.path, 'utf8').split('\n')[0];
            if (!firstLine) continue;
            const meta = JSON.parse(firstLine);
            if (meta.type === 'session_meta' && meta.payload?.cwd) {
              if (normalizePath(meta.payload.cwd) === normalizePath(cwd)) {
                return meta.payload.id ?? null;
              }
            }
          } catch { continue; }
        }
        if (files.length > 0) {
          try {
            const firstLine = readFileSync(files[0]!.path, 'utf8').split('\n')[0];
            if (firstLine) return JSON.parse(firstLine).payload?.id ?? null;
          } catch { /* ignore */ }
        }
        return null;
      }

      case 'gemini': {
        const projectsFile = join(homedir(), '.gemini', 'projects.json');
        const geminiDir = join(homedir(), '.gemini', 'tmp');
        if (!existsSync(geminiDir)) return null;

        let targetSlug: string | null = null;
        if (existsSync(projectsFile)) {
          const raw = JSON.parse(readFileSync(projectsFile, 'utf8'));
          const mapping: Record<string, string> = raw.projects ?? raw;
          targetSlug = mapping[cwd] ?? null;
          if (!targetSlug) {
            for (const [path, slug] of Object.entries(mapping)) {
              if (normalizePath(path) === normalizePath(cwd)) { targetSlug = slug; break; }
            }
          }
        }

        const dirsToSearch = targetSlug
          ? [join(geminiDir, targetSlug)]
          : readdirSync(geminiDir).map(d => join(geminiDir, d));

        for (const dir of dirsToSearch) {
          const chatsDir = join(dir, 'chats');
          if (!existsSync(chatsDir)) continue;
          const sessions = readdirSync(chatsDir)
            .filter(f => f.endsWith('.json'))
            .map(f => ({ mtime: statSync(join(chatsDir, f)).mtimeMs, path: join(chatsDir, f) }))
            .sort((a, b) => b.mtime - a.mtime);
          if (sessions.length > 0) {
            const data = JSON.parse(readFileSync(sessions[0]!.path, 'utf8'));
            return data.sessionId ?? null;
          }
        }
        return null;
      }

      case 'opencode': {
        const dbPaths = [
          join(homedir(), '.local', 'share', 'opencode', 'opencode.db'),
          join(homedir(), '.opencode', 'opencode.db'),
        ];
        for (const dbPath of dbPaths) {
          if (!existsSync(dbPath)) continue;
          try {
            const escaped = cwd.replace(/'/g, "''");
            const result = execFileSync('sqlite3', [dbPath,
              `SELECT id FROM session WHERE directory = '${escaped}' ORDER BY rowid DESC LIMIT 1;`
            ], { encoding: 'utf8', timeout: 5000 }).trim();
            if (result) return result;
          } catch { /* ignore */ }
        }
        try {
          const dbPath = dbPaths[0]!;
          if (existsSync(dbPath)) {
            const result = execFileSync('sqlite3', [dbPath,
              `SELECT id FROM session ORDER BY rowid DESC LIMIT 1;`
            ], { encoding: 'utf8', timeout: 5000 }).trim();
            if (result) return result;
          }
        } catch { /* ignore */ }
        return null;
      }

      case 'goose': {
        try {
          const result = execFileSync('goose', ['session', 'list', '--format', 'json', '--limit', '1'], {
            encoding: 'utf8', timeout: 5000,
          });
          const sessions = JSON.parse(result);
          if (Array.isArray(sessions) && sessions.length > 0) {
            return sessions[0].session_id ?? sessions[0].id ?? null;
          }
        } catch { /* ignore */ }
        return null;
      }

      default:
        return null;
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CLI Trust Setup — pre-trust directories so CLIs don't prompt
// ---------------------------------------------------------------------------

function ensureCliTrust(cli: string, cwd: string): void {
  try {
    switch (cli) {
      case 'claude': {
        const configFile = join(homedir(), '.claude.json');
        let config: Record<string, any> = {};
        try { config = JSON.parse(readFileSync(configFile, 'utf8')); } catch { /* ignore */ }
        if (!config.projects) config.projects = {};
        const proj = config.projects[cwd] ?? {};
        if (!proj.hasTrustDialogAccepted) {
          proj.hasTrustDialogAccepted = true;
          config.projects[cwd] = proj;
          writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n', 'utf8');
        }
        break;
      }
      case 'gemini': {
        const trustFile = join(homedir(), '.gemini', 'trustedFolders.json');
        let existing: Record<string, string> = {};
        try { existing = JSON.parse(readFileSync(trustFile, 'utf8')); } catch { /* ignore */ }
        if (!existing[cwd]) {
          existing[cwd] = 'TRUST_FOLDER';
          mkdirSync(dirname(trustFile), { recursive: true });
          writeFileSync(trustFile, JSON.stringify(existing, null, 2) + '\n', 'utf8');
        }
        break;
      }
      case 'codex': {
        const configFile = join(homedir(), '.codex', 'config.toml');
        let content = '';
        try { content = readFileSync(configFile, 'utf8'); } catch { /* ignore */ }
        const fwdCwd = cwd.replace(/\\/g, '/');
        if (!content.includes(`[projects.'${fwdCwd}']`)) {
          mkdirSync(dirname(configFile), { recursive: true });
          writeFileSync(configFile, content + `\n[projects.'${fwdCwd}']\ntrust_level = "trusted"\n`, 'utf8');
        }
        break;
      }
    }
  } catch { /* best effort */ }
}

function ensureCliConfig(cli: string): void {
  const def = CLI_DEFS[cli];
  if (!def?.configSetup) return;
  const { path: configPath, settings } = def.configSetup;
  const resolved = configPath.replace('~', homedir());
  const dir = dirname(resolved);
  try {
    mkdirSync(dir, { recursive: true });
    let existing: Record<string, unknown> = {};
    try { existing = JSON.parse(readFileSync(resolved, 'utf8')); } catch { /* ignore */ }
    const updated = { ...existing, ...settings };
    writeFileSync(resolved, JSON.stringify(updated, null, 2) + '\n', 'utf8');
  } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// Resume Command Building
// ---------------------------------------------------------------------------

function buildResumeCommand(cli: string, sessionId: string | null, cwd: string): string {
  const def = CLI_DEFS[cli];
  if (!def) return 'bash';

  ensureCliTrust(cli, cwd);

  const base = [def.bin, ...def.skipPermFlags].join(' ');
  const envPrefix = def.skipPermEnv
    ? Object.entries(def.skipPermEnv).map(([k, v]) => `${k}=${v}`).join(' ') + ' '
    : '';

  if (!sessionId) {
    switch (cli) {
      case 'claude':
        return `(${envPrefix}${base} --continue) || (${envPrefix}${base})`;
      case 'gemini':
        return `(${envPrefix}${base} --resume latest) || (${envPrefix}${base})`;
      case 'codex':
        return `(codex resume --last) || (${envPrefix}${base})`;
      case 'opencode':
        return `(${envPrefix}${base} --continue) || (${envPrefix}${base})`;
      case 'goose':
        return `(${envPrefix}goose session --resume) || (${envPrefix}${base})`;
      default:
        return `${envPrefix}${base}`;
    }
  }

  switch (cli) {
    case 'claude':
      return `${envPrefix}${base} --resume ${sessionId}`;
    case 'gemini':
      return `${envPrefix}${base} --resume latest`;
    case 'codex':
      return `codex resume ${sessionId}`;
    case 'opencode':
      return `${envPrefix}${base} --session ${sessionId}`;
    case 'goose':
      return `${envPrefix}goose session --resume --session-id ${sessionId}`;
    default:
      return `${envPrefix}${base}`;
  }
}

// ---------------------------------------------------------------------------
// Capture Manifest — snapshot current state
// ---------------------------------------------------------------------------

function captureManifest(): SessionManifest {
  let branch: string | null = null;
  try {
    branch = execFileSync('git', ['-C', PROJECT_ROOT ?? '.', 'branch', '--show-current'], {
      encoding: 'utf8', timeout: 5000,
    }).trim() || null;
  } catch { /* ignore */ }

  let treeOutput: string;
  try { treeOutput = cmux('tree', '--all'); } catch { treeOutput = ''; }

  let workspaceList: string;
  try { workspaceList = cmux('list-workspaces'); } catch { workspaceList = ''; }
  const wsRefs = workspaceList.match(/workspace:\d+/g) ?? [];

  const workspaces: WorkspaceManifest[] = [];

  for (const wsRef of wsRefs) {
    let wsName = wsRef;
    try {
      const sidebar = cmux('sidebar-state', '--workspace', wsRef);
      const cwdMatch = sidebar.match(/cwd[:\s]+([^\n]+)/i);
      wsName = cwdMatch?.[1]?.trim() ?? wsRef;
    } catch { /* ignore */ }

    let surfList: string;
    try { surfList = cmux('list-pane-surfaces', '--workspace', wsRef); } catch { surfList = ''; }
    const surfRefs = surfList.match(/surface:\d+/g) ?? [];

    const surfaces: SurfaceManifest[] = [];

    for (const surfRef of surfRefs) {
      let screenText = '';
      try {
        screenText = cmux('read-screen', '--surface', surfRef, '--workspace', wsRef, '--lines', '30');
      } catch { /* ignore */ }

      const cli = detectCliFromScreen(screenText) ?? 'shell';

      let surfCwd = PROJECT_ROOT ?? homedir();
      try {
        const sidebarState = cmux('sidebar-state', '--workspace', wsRef);
        const cwdMatch = sidebarState.match(/cwd[:\s]+([^\n]+)/i);
        if (cwdMatch) surfCwd = cwdMatch[1]!.trim();
      } catch { /* ignore */ }

      const sessionId = cli !== 'shell' ? getSessionId(cli, surfCwd) : null;

      surfaces.push({
        surface_ref: surfRef,
        cli,
        session_id: sessionId,
        cwd: surfCwd,
      });
    }

    workspaces.push({
      workspace_ref: wsRef,
      name: wsName,
      surfaces,
    });
  }

  return {
    saved_at: new Date().toISOString(),
    project_root: PROJECT_ROOT ?? process.cwd(),
    git_branch: branch,
    workspaces,
  };
}

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
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    try {
      if (isCmuxRunning()) {
        const manifest = captureManifest();
        saveManifest(manifest);
      }
    } catch { /* best effort */ }
    autoSaveTimer = null;
  }, 2000); // 2 second debounce
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

// ============================================================================
// C. WINDOW MANAGEMENT
// ============================================================================

server.tool(
  'cmux_list_windows',
  'List all open windows.',
  {},
  safe(async () => ok(cmux('list-windows'))),
);

server.tool(
  'cmux_current_window',
  'Get the currently focused window.',
  {},
  safe(async () => ok(cmux('current-window'))),
);

server.tool(
  'cmux_new_window',
  'Create a new window.',
  {},
  safeMut(async () => ok(cmux('new-window'))),
);

server.tool(
  'cmux_focus_window',
  'Focus a specific window.',
  {
    window: z.string().describe('Window ID to focus'),
  },
  safe(async ({ window: win }) => ok(cmux('focus-window', '--window', win))),
);

server.tool(
  'cmux_close_window',
  'Close a window.',
  {
    window: z.string().describe('Window ID to close'),
  },
  safeMut(async ({ window: win }) => ok(cmux('close-window', '--window', win))),
);

server.tool(
  'cmux_rename_window',
  'Rename a window.',
  {
    title: z.string().describe('New window title'),
    workspace: z.string().optional().describe('Workspace ID/ref'),
  },
  safeMut(async ({ title, workspace }) => {
    const args = ['rename-window'];
    if (workspace) args.push('--workspace', workspace);
    args.push(title);
    return ok(cmux(...args));
  }),
);

// ============================================================================
// D. SURFACE (TAB) MANAGEMENT
// ============================================================================

server.tool(
  'cmux_new_surface',
  'Create a new surface (tab) — terminal or browser.',
  {
    type: z.enum(['terminal', 'browser']).optional().describe('Surface type (default: terminal)'),
    pane: z.string().optional().describe('Pane ID/ref to create surface in'),
    workspace: z.string().optional().describe('Workspace ID/ref'),
    url: z.string().optional().describe('URL for browser surfaces'),
  },
  safeMut(async ({ type, pane, workspace, url }) => {
    const args = ['new-surface'];
    if (type) args.push('--type', type);
    if (pane) args.push('--pane', pane);
    if (workspace) args.push('--workspace', workspace);
    if (url) args.push('--url', url);
    return ok(cmux(...args));
  }),
);

server.tool(
  'cmux_close_surface',
  'Close a surface (tab).',
  {
    surface: z.string().optional().describe('Surface ID/ref to close'),
    workspace: z.string().optional().describe('Workspace ID/ref'),
  },
  safeMut(async ({ surface, workspace }) => {
    const args = ['close-surface', ...wsArgs(workspace, surface)];
    return ok(cmux(...args));
  }),
);

server.tool(
  'cmux_rename_tab',
  'Rename a tab.',
  {
    title: z.string().describe('New tab title'),
    workspace: z.string().optional().describe('Workspace ref'),
    tab: z.string().optional().describe('Tab ref'),
    surface: z.string().optional().describe('Surface ref'),
  },
  safeMut(async ({ title, workspace, tab, surface }) => {
    const args = ['rename-tab'];
    if (workspace) args.push('--workspace', workspace);
    if (tab) args.push('--tab', tab);
    if (surface) args.push('--surface', surface);
    args.push(title);
    return ok(cmux(...args));
  }),
);

server.tool(
  'cmux_move_surface',
  'Move a surface to a different pane, workspace, or window.',
  {
    surface: z.string().describe('Surface ID/ref to move'),
    pane: z.string().optional().describe('Target pane ID/ref'),
    workspace: z.string().optional().describe('Target workspace ID/ref'),
    window: z.string().optional().describe('Target window ID/ref'),
    before: z.string().optional().describe('Place before this surface'),
    after: z.string().optional().describe('Place after this surface'),
    index: z.number().optional().describe('Target index position'),
    focus: z.boolean().optional().describe('Focus after moving'),
  },
  safeMut(async ({ surface, pane, workspace, window: win, before, after, index, focus }) => {
    const args = ['move-surface', '--surface', surface];
    if (pane) args.push('--pane', pane);
    if (workspace) args.push('--workspace', workspace);
    if (win) args.push('--window', win);
    if (before) args.push('--before', before);
    if (after) args.push('--after', after);
    if (index !== undefined) args.push('--index', String(index));
    if (focus !== undefined) args.push('--focus', String(focus));
    return ok(cmux(...args));
  }),
);

server.tool(
  'cmux_reorder_surface',
  'Reorder a tab within its pane.',
  {
    surface: z.string().describe('Surface ref to reorder'),
    index: z.number().optional().describe('Target index position'),
    before: z.string().optional().describe('Place before this surface ref'),
    after: z.string().optional().describe('Place after this surface ref'),
  },
  safeMut(async ({ surface, index, before, after }) => {
    const args = ['reorder-surface', '--surface', surface];
    if (index !== undefined) args.push('--index', String(index));
    if (before) args.push('--before', before);
    if (after) args.push('--after', after);
    return ok(cmux(...args));
  }),
);

server.tool(
  'cmux_reorder_workspace',
  'Reorder a workspace in the sidebar.',
  {
    workspace: z.string().describe('Workspace ref to reorder'),
    index: z.number().optional().describe('Target index position'),
    before: z.string().optional().describe('Place before this workspace ref'),
    after: z.string().optional().describe('Place after this workspace ref'),
    window: z.string().optional().describe('Window ref'),
  },
  safeMut(async ({ workspace, index, before, after, window: win }) => {
    const args = ['reorder-workspace', '--workspace', workspace];
    if (index !== undefined) args.push('--index', String(index));
    if (before) args.push('--before', before);
    if (after) args.push('--after', after);
    if (win) args.push('--window', win);
    return ok(cmux(...args));
  }),
);

server.tool(
  'cmux_move_workspace_to_window',
  'Move a workspace to a different window without closing it.',
  {
    workspace: z.string().describe('Workspace ref to move'),
    window: z.string().describe('Target window ref'),
  },
  safeMut(async ({ workspace, window: win }) => {
    return ok(cmux('move-workspace-to-window', '--workspace', workspace, '--window', win));
  }),
);

server.tool(
  'cmux_drag_surface_to_split',
  'Move a tab into a split position — turns a tab into its own pane by dragging it to a side.',
  {
    surface: z.string().describe('Surface ref to drag'),
    direction: z.enum(['left', 'right', 'up', 'down']).describe('Direction to split into'),
  },
  safeMut(async ({ surface, direction }) => {
    return ok(cmux('drag-surface-to-split', '--surface', surface, direction));
  }),
);

// ============================================================================
// E. PANE / SPLIT OPERATIONS
// ============================================================================

server.tool(
  'cmux_list_panes',
  'List all panes in a workspace.',
  {
    workspace: z.string().optional().describe('Workspace ID/ref (default: current)'),
  },
  safe(async ({ workspace }) => {
    const args = ['list-panes'];
    if (workspace) args.push('--workspace', workspace);
    return ok(cmux(...args));
  }),
);

server.tool(
  'cmux_list_pane_surfaces',
  'List all pane surfaces in a workspace — returns the surface refs needed by other tools.',
  {
    workspace: z.string().optional().describe('Workspace ref'),
  },
  safe(async ({ workspace }) => {
    const args = ['list-pane-surfaces'];
    if (workspace) args.push('--workspace', workspace);
    return ok(cmux(...args));
  }),
);

server.tool(
  'cmux_list_panels',
  'List all panels in a workspace.',
  {
    workspace: z.string().optional().describe('Workspace ID/ref (default: current)'),
  },
  safe(async ({ workspace }) => {
    const args = ['list-panels'];
    if (workspace) args.push('--workspace', workspace);
    return ok(cmux(...args));
  }),
);

server.tool(
  'cmux_new_split',
  'Split an existing pane in a given direction.',
  {
    direction: z.enum(['left', 'right', 'up', 'down']).describe('Split direction'),
    workspace: z.string().optional().describe('Workspace ID/ref'),
    surface: z.string().optional().describe('Surface ID/ref to split from'),
    panel: z.string().optional().describe('Panel ID/ref to split from'),
  },
  safeMut(async ({ direction, workspace, surface, panel }) => {
    const args = ['new-split', direction];
    if (workspace) args.push('--workspace', workspace);
    if (surface) args.push('--surface', surface);
    if (panel) args.push('--panel', panel);
    return ok(cmux(...args));
  }),
);

server.tool(
  'cmux_new_pane',
  'Create a new pane (terminal or browser) in a workspace.',
  {
    type: z.enum(['terminal', 'browser']).optional().describe('Pane type'),
    direction: z.enum(['left', 'right', 'up', 'down']).optional().describe('Split direction'),
    workspace: z.string().optional().describe('Workspace ID/ref'),
    url: z.string().optional().describe('URL for browser panes'),
  },
  safeMut(async ({ type, direction, workspace, url }) => {
    const args = ['new-pane'];
    if (type) args.push('--type', type);
    if (direction) args.push('--direction', direction);
    if (workspace) args.push('--workspace', workspace);
    if (url) args.push('--url', url);
    return ok(cmux(...args));
  }),
);

server.tool(
  'cmux_focus_pane',
  'Focus a specific pane.',
  {
    pane: z.string().describe('Pane ID/ref to focus'),
    workspace: z.string().optional().describe('Workspace ID/ref'),
  },
  safe(async ({ pane, workspace }) => {
    const args = ['focus-pane', '--pane', pane];
    if (workspace) args.push('--workspace', workspace);
    return ok(cmux(...args));
  }),
);

server.tool(
  'cmux_resize_pane',
  'Resize a pane in a direction.',
  {
    pane: z.string().describe('Pane ID/ref to resize'),
    direction: z.enum(['L', 'R', 'U', 'D']).describe('Resize direction'),
    amount: z.number().optional().describe('Resize amount in cells'),
    workspace: z.string().optional().describe('Workspace ID/ref'),
  },
  safeMut(async ({ pane, direction, amount, workspace }) => {
    const args = ['resize-pane', '--pane', pane, `-${direction}`];
    if (amount !== undefined) args.push('--amount', String(amount));
    if (workspace) args.push('--workspace', workspace);
    return ok(cmux(...args));
  }),
);

server.tool(
  'cmux_swap_pane',
  'Swap two panes.',
  {
    pane: z.string().describe('Source pane ID/ref'),
    target_pane: z.string().describe('Target pane ID/ref'),
    workspace: z.string().optional().describe('Workspace ID/ref'),
  },
  safeMut(async ({ pane, target_pane, workspace }) => {
    const args = ['swap-pane', '--pane', pane, '--target-pane', target_pane];
    if (workspace) args.push('--workspace', workspace);
    return ok(cmux(...args));
  }),
);

server.tool(
  'cmux_break_pane',
  'Move a pane to its own new workspace.',
  {
    workspace: z.string().optional().describe('Workspace ID/ref'),
    pane: z.string().optional().describe('Pane ID/ref'),
    surface: z.string().optional().describe('Surface ID/ref'),
  },
  safeMut(async ({ workspace, pane, surface }) => {
    const args = ['break-pane'];
    if (workspace) args.push('--workspace', workspace);
    if (pane) args.push('--pane', pane);
    if (surface) args.push('--surface', surface);
    return ok(cmux(...args));
  }),
);

server.tool(
  'cmux_join_pane',
  'Join a pane into another pane — merges two split panes together.',
  {
    target_pane: z.string().describe('Target pane ref to join into'),
    workspace: z.string().optional().describe('Workspace ref'),
    pane: z.string().optional().describe('Source pane ref to move'),
    surface: z.string().optional().describe('Surface ref'),
  },
  safeMut(async ({ target_pane, workspace, pane, surface }) => {
    const args = ['join-pane', '--target-pane', target_pane];
    if (workspace) args.push('--workspace', workspace);
    if (pane) args.push('--pane', pane);
    if (surface) args.push('--surface', surface);
    return ok(cmux(...args));
  }),
);

server.tool(
  'cmux_respawn_pane',
  'Restart a pane process.',
  {
    workspace: z.string().optional().describe('Workspace ID/ref'),
    surface: z.string().optional().describe('Surface ID/ref'),
    command: z.string().optional().describe('Command to run (default: original shell)'),
  },
  safeMut(async ({ workspace, surface, command }) => {
    const args = ['respawn-pane', ...wsArgs(workspace, surface)];
    if (command) args.push('--command', command);
    return ok(cmux(...args));
  }),
);

// ============================================================================
// F. TEXT I/O
// ============================================================================

server.tool(
  'cmux_send',
  'Send text to a surface without pressing Enter.',
  {
    text: z.string().describe('Text to send'),
    workspace: z.string().optional().describe('Workspace ID/ref'),
    surface: z.string().optional().describe('Surface ID/ref'),
  },
  safe(async ({ text, workspace, surface }) => {
    const args = ['send', ...wsArgs(workspace, surface), text];
    return ok(cmux(...args));
  }),
);

server.tool(
  'cmux_send_submit',
  'Send text and press Enter — primary method for injecting commands and prompts.',
  {
    text: z.string().describe('Text to send'),
    workspace: z.string().optional().describe('Workspace ID/ref'),
    surface: z.string().optional().describe('Surface ID/ref'),
  },
  safeMut(async ({ text, workspace, surface }) => {
    const ws = wsArgs(workspace, surface);
    cmux('send', ...ws, text);
    cmux('send-key', ...ws, 'enter');
    return ok({ sent: text, submitted: true });
  }),
);

server.tool(
  'cmux_send_key',
  'Send a key press (enter, tab, escape, backspace, delete, up, down, left, right, ctrl+c, etc.).',
  {
    key: z.string().describe('Key to send'),
    workspace: z.string().optional().describe('Workspace ID/ref'),
    surface: z.string().optional().describe('Surface ID/ref'),
  },
  safe(async ({ key, workspace, surface }) => {
    const args = ['send-key', ...wsArgs(workspace, surface), key];
    return ok(cmux(...args));
  }),
);

server.tool(
  'cmux_send_panel',
  'Send text to a specific panel.',
  {
    panel: z.string().describe('Panel ID/ref'),
    text: z.string().describe('Text to send'),
    workspace: z.string().optional().describe('Workspace ID/ref'),
  },
  safe(async ({ panel, text, workspace }) => {
    const args = ['send-panel', '--panel', panel];
    if (workspace) args.push('--workspace', workspace);
    args.push(text);
    return ok(cmux(...args));
  }),
);

server.tool(
  'cmux_read_screen',
  'Read terminal output from a surface.',
  {
    workspace: z.string().optional().describe('Workspace ID/ref'),
    surface: z.string().optional().describe('Surface ID/ref'),
    scrollback: z.boolean().optional().describe('Include scrollback buffer'),
    lines: z.number().optional().describe('Number of lines to read'),
  },
  safe(async ({ workspace, surface, scrollback, lines }) => {
    const args = ['read-screen', ...wsArgs(workspace, surface)];
    if (scrollback) args.push('--scrollback');
    if (lines !== undefined) args.push('--lines', String(lines));
    return ok(cmux(...args));
  }),
);

server.tool(
  'cmux_capture_pane',
  'Capture pane output (tmux-compatible). Alias for read-screen.',
  {
    workspace: z.string().optional().describe('Workspace ID/ref'),
    surface: z.string().optional().describe('Surface ID/ref'),
    scrollback: z.boolean().optional().describe('Include scrollback buffer'),
    lines: z.number().optional().describe('Number of lines to read'),
  },
  safe(async ({ workspace, surface, scrollback, lines }) => {
    const args = ['capture-pane', ...wsArgs(workspace, surface)];
    if (scrollback) args.push('--scrollback');
    if (lines !== undefined) args.push('--lines', String(lines));
    return ok(cmux(...args));
  }),
);

// ============================================================================
// G. SIDEBAR METADATA
// ============================================================================

server.tool(
  'cmux_set_status',
  'Set a sidebar metadata status pill (key-value badge) for a workspace.',
  {
    key: z.string().describe('Status key (unique identifier)'),
    value: z.string().describe('Status value to display'),
    icon: z.string().optional().describe('Icon name'),
    color: z.string().optional().describe('Color hex'),
    workspace: z.string().optional().describe('Workspace ID/ref'),
  },
  safe(async ({ key, value, icon, color, workspace }) => {
    const args = ['set-status', key, value];
    if (icon) args.push('--icon', icon);
    if (color) args.push('--color', color);
    if (workspace) args.push('--workspace', workspace);
    return ok(cmux(...args));
  }),
);

server.tool(
  'cmux_clear_status',
  'Clear a sidebar status key.',
  {
    key: z.string().describe('Status key to clear'),
    workspace: z.string().optional().describe('Workspace ID/ref'),
  },
  safe(async ({ key, workspace }) => {
    const args = ['clear-status', key];
    if (workspace) args.push('--workspace', workspace);
    return ok(cmux(...args));
  }),
);

server.tool(
  'cmux_list_status',
  'List all sidebar status entries for a workspace.',
  {
    workspace: z.string().optional().describe('Workspace ID/ref'),
  },
  safe(async ({ workspace }) => {
    const args = ['list-status'];
    if (workspace) args.push('--workspace', workspace);
    return ok(cmux(...args));
  }),
);

server.tool(
  'cmux_set_progress',
  'Set a sidebar progress indicator (0.0 to 1.0).',
  {
    progress: z.number().min(0).max(1).describe('Progress value (0.0 to 1.0)'),
    label: z.string().optional().describe('Progress label text'),
    workspace: z.string().optional().describe('Workspace ID/ref'),
  },
  safe(async ({ progress, label, workspace }) => {
    const args = ['set-progress', String(progress)];
    if (label) args.push('--label', label);
    if (workspace) args.push('--workspace', workspace);
    return ok(cmux(...args));
  }),
);

server.tool(
  'cmux_clear_progress',
  'Clear the sidebar progress indicator.',
  {
    workspace: z.string().optional().describe('Workspace ID/ref'),
  },
  safe(async ({ workspace }) => {
    const args = ['clear-progress'];
    if (workspace) args.push('--workspace', workspace);
    return ok(cmux(...args));
  }),
);

server.tool(
  'cmux_log',
  'Write a log entry to the sidebar.',
  {
    message: z.string().describe('Log message'),
    level: z.enum(['info', 'progress', 'success', 'warning', 'error']).optional().describe('Log level'),
    source: z.string().optional().describe('Source name'),
    workspace: z.string().optional().describe('Workspace ID/ref'),
  },
  safe(async ({ message, level, source, workspace }) => {
    const args = ['log'];
    if (level) args.push('--level', level);
    if (source) args.push('--source', source);
    if (workspace) args.push('--workspace', workspace);
    args.push('--', message);
    return ok(cmux(...args));
  }),
);

server.tool(
  'cmux_sidebar_state',
  'Get current sidebar state (cwd, git branch, ports, status, progress, logs).',
  {
    workspace: z.string().optional().describe('Workspace ID/ref'),
  },
  safe(async ({ workspace }) => {
    const args = ['sidebar-state'];
    if (workspace) args.push('--workspace', workspace);
    return ok(cmux(...args));
  }),
);

// ============================================================================
// H. NOTIFICATIONS
// ============================================================================

server.tool(
  'cmux_notify',
  'Send a notification to a workspace/surface.',
  {
    title: z.string().describe('Notification title'),
    subtitle: z.string().optional().describe('Notification subtitle'),
    body: z.string().optional().describe('Notification body'),
    workspace: z.string().optional().describe('Workspace ID/ref'),
    surface: z.string().optional().describe('Surface ID/ref'),
  },
  safe(async ({ title, subtitle, body, workspace, surface }) => {
    const args = ['notify', '--title', title];
    if (subtitle) args.push('--subtitle', subtitle);
    if (body) args.push('--body', body);
    const ws = wsArgs(workspace, surface);
    args.push(...ws);
    return ok(cmux(...args));
  }),
);

server.tool(
  'cmux_list_notifications',
  'List all notifications.',
  {},
  safe(async () => ok(cmux('list-notifications'))),
);

server.tool(
  'cmux_clear_notifications',
  'Clear all notifications.',
  {},
  safe(async () => ok(cmux('clear-notifications'))),
);

// ============================================================================
// I. BROWSER AUTOMATION
// ============================================================================

server.tool(
  'cmux_browser_open',
  'Open a browser surface (split in the current workspace).',
  {
    url: z.string().optional().describe('URL to open'),
    surface: z.string().optional().describe('Existing browser surface ID/ref'),
  },
  safe(async ({ url, surface }) => {
    const args = ['browser'];
    if (surface) args.push('--surface', surface);
    args.push('open');
    if (url) args.push(url);
    return ok(cmux(...args));
  }),
);

server.tool(
  'cmux_browser_navigate',
  'Navigate the browser: goto a URL, or go back/forward/reload.',
  {
    action: z.enum(['goto', 'back', 'forward', 'reload']).describe('Navigation action'),
    url: z.string().optional().describe('URL (required for goto)'),
    surface: z.string().optional().describe('Browser surface ID/ref'),
  },
  safe(async ({ action, url, surface }) => {
    const args = ['browser'];
    if (surface) args.push('--surface', surface);
    args.push(action);
    if (action === 'goto' && url) args.push(url);
    return ok(cmux(...args));
  }),
);

server.tool(
  'cmux_browser_snapshot',
  'Get a DOM accessibility snapshot of the browser page.',
  {
    interactive: z.boolean().optional().describe('Include interactive elements only'),
    compact: z.boolean().optional().describe('Compact output'),
    max_depth: z.number().optional().describe('Max DOM depth'),
    selector: z.string().optional().describe('CSS selector to scope snapshot'),
    surface: z.string().optional().describe('Browser surface ID/ref'),
  },
  safe(async ({ interactive, compact, max_depth, selector, surface }) => {
    const args = ['browser'];
    if (surface) args.push('--surface', surface);
    args.push('snapshot');
    if (interactive) args.push('--interactive');
    if (compact) args.push('--compact');
    if (max_depth !== undefined) args.push('--max-depth', String(max_depth));
    if (selector) args.push('--selector', selector);
    return ok(cmux(...args));
  }),
);

server.tool(
  'cmux_browser_screenshot',
  'Take a screenshot of the browser page.',
  {
    out: z.string().optional().describe('Output file path'),
    surface: z.string().optional().describe('Browser surface ID/ref'),
  },
  safe(async ({ out, surface }) => {
    const args = ['browser'];
    if (surface) args.push('--surface', surface);
    args.push('screenshot');
    if (out) args.push('--out', out);
    args.push('--json');
    return ok(cmux(...args));
  }),
);

server.tool(
  'cmux_browser_eval',
  'Execute JavaScript in the browser page.',
  {
    script: z.string().describe('JavaScript code to execute'),
    surface: z.string().optional().describe('Browser surface ID/ref'),
  },
  safe(async ({ script, surface }) => {
    const args = ['browser'];
    if (surface) args.push('--surface', surface);
    args.push('eval', script);
    return ok(cmux(...args));
  }),
);

server.tool(
  'cmux_browser_click',
  'Click an element in the browser.',
  {
    selector: z.string().describe('CSS selector or element ref'),
    surface: z.string().optional().describe('Browser surface ID/ref'),
  },
  safe(async ({ selector, surface }) => {
    const args = ['browser'];
    if (surface) args.push('--surface', surface);
    args.push('click', selector);
    return ok(cmux(...args));
  }),
);

server.tool(
  'cmux_browser_fill',
  'Fill an input field in the browser.',
  {
    selector: z.string().describe('CSS selector of the input'),
    value: z.string().describe('Value to fill'),
    surface: z.string().optional().describe('Browser surface ID/ref'),
  },
  safe(async ({ selector, value, surface }) => {
    const args = ['browser'];
    if (surface) args.push('--surface', surface);
    args.push('fill', selector, value);
    return ok(cmux(...args));
  }),
);

server.tool(
  'cmux_browser_type',
  'Type text into an element in the browser (key by key).',
  {
    selector: z.string().describe('CSS selector of the element'),
    text: z.string().describe('Text to type'),
    surface: z.string().optional().describe('Browser surface ID/ref'),
  },
  safe(async ({ selector, text, surface }) => {
    const args = ['browser'];
    if (surface) args.push('--surface', surface);
    args.push('type', selector, text);
    return ok(cmux(...args));
  }),
);

server.tool(
  'cmux_browser_wait',
  'Wait for a condition in the browser (selector, text, URL, load state).',
  {
    selector: z.string().optional().describe('CSS selector to wait for'),
    text: z.string().optional().describe('Text to wait for'),
    url_contains: z.string().optional().describe('Wait until URL contains this string'),
    load_state: z.enum(['interactive', 'complete']).optional().describe('Wait for load state'),
    timeout_ms: z.number().optional().describe('Timeout in milliseconds'),
    surface: z.string().optional().describe('Browser surface ID/ref'),
  },
  safe(async ({ selector, text, url_contains, load_state, timeout_ms, surface }) => {
    const args = ['browser'];
    if (surface) args.push('--surface', surface);
    args.push('wait');
    if (selector) args.push('--selector', selector);
    if (text) args.push('--text', text);
    if (url_contains) args.push('--url-contains', url_contains);
    if (load_state) args.push('--load-state', load_state);
    if (timeout_ms !== undefined) args.push('--timeout-ms', String(timeout_ms));
    return ok(cmux(...args));
  }),
);

server.tool(
  'cmux_browser_get',
  'Get data from the browser page (url, title, text, html, value, attribute, element count).',
  {
    property: z.enum(['url', 'title', 'text', 'html', 'value', 'attr', 'count', 'box', 'styles']).describe('Property to get'),
    selector: z.string().optional().describe('CSS selector'),
    attribute: z.string().optional().describe('Attribute name (required for attr)'),
    surface: z.string().optional().describe('Browser surface ID/ref'),
  },
  safe(async ({ property, selector, attribute, surface }) => {
    const args = ['browser'];
    if (surface) args.push('--surface', surface);
    args.push('get', property);
    if (selector) args.push(selector);
    if (attribute) args.push(attribute);
    return ok(cmux(...args));
  }),
);

server.tool(
  'cmux_browser_tab',
  'Manage browser tabs (new, list, switch, close).',
  {
    action: z.enum(['new', 'list', 'switch', 'close']).describe('Tab action'),
    tab_index: z.string().optional().describe('Tab index (for switch/close)'),
    surface: z.string().optional().describe('Browser surface ID/ref'),
  },
  safe(async ({ action, tab_index, surface }) => {
    const args = ['browser'];
    if (surface) args.push('--surface', surface);
    args.push('tab', action);
    if (tab_index) args.push(tab_index);
    return ok(cmux(...args));
  }),
);

server.tool(
  'cmux_browser_console',
  'Get or clear browser console logs/errors.',
  {
    type: z.enum(['console', 'errors']).describe('Log type'),
    action: z.enum(['list', 'clear']).describe('Action'),
    surface: z.string().optional().describe('Browser surface ID/ref'),
  },
  safe(async ({ type, action, surface }) => {
    const args = ['browser'];
    if (surface) args.push('--surface', surface);
    args.push(type, action);
    return ok(cmux(...args));
  }),
);

// ============================================================================
// J. COMPOSITE / HIGH-LEVEL TOOLS
// ============================================================================

server.tool(
  'cmux_launch_agents',
  `Create a workspace and launch N AI coding agents in a grid layout.
Supports: ${Object.keys(CLI_DEFS).join(', ')}.`,
  {
    cli: z.enum(['claude', 'gemini', 'codex', 'opencode', 'goose']).describe('Which AI CLI to launch'),
    count: z.number().min(1).max(12).describe('Number of agent panes'),
    cwd: z.string().optional().describe('Working directory (default: project root)'),
    workspace_name: z.string().optional().describe('Name for the new workspace'),
    prompt: z.string().optional().describe('Initial prompt to send to each agent after launch'),
  },
  safeMut(async ({ cli, count, cwd, workspace_name, prompt }) => {
    if (!isCmuxRunning()) {
      return err('CMUX is not running. Open cmux.app first.');
    }

    const def = CLI_DEFS[cli];
    if (!def) return err(`Unknown CLI: ${cli}`);

    const workDir = cwd ?? PROJECT_ROOT ?? homedir();

    // 1. Create workspace
    const wsResult = cmux('new-workspace', '--cwd', workDir);

    // 2. Rename workspace
    const name = workspace_name ?? `${def.label} x${count}`;
    try { cmux('rename-workspace', name); } catch { /* ignore */ }

    // 3. Build grid by splitting
    const cols = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / cols);

    for (let c = 1; c < cols; c++) {
      try { cmux('new-split', 'right'); } catch { /* ignore */ }
    }

    if (rows > 1) {
      let paneList: string;
      try { paneList = cmux('list-panes'); } catch { paneList = ''; }

      for (let r = 1; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (r * cols + c >= count) break;
          try { cmux('new-split', 'down'); } catch { /* ignore */ }
        }
      }
    }

    // 4. Get final pane list and launch CLI in each
    let finalPanes: string;
    try { finalPanes = cmux('list-pane-surfaces'); } catch { finalPanes = ''; }

    const cliCmd = [def.bin, ...def.skipPermFlags].join(' ');
    const envPrefix = def.skipPermEnv
      ? Object.entries(def.skipPermEnv).map(([k, v]) => `${k}=${v}`).join(' ') + ' '
      : '';
    const fullCmd = envPrefix + cliCmd;

    const surfaceRefs = finalPanes.match(/surface:\d+/g) ?? [];
    const launched: string[] = [];

    for (let i = 0; i < Math.min(surfaceRefs.length, count); i++) {
      const ref = surfaceRefs[i];
      try {
        cmux('send', '--surface', ref, fullCmd);
        cmux('send-key', '--surface', ref, 'enter');
        launched.push(ref);
      } catch { /* ignore individual failures */ }
    }

    // 5. Optionally send initial prompt after a brief delay
    if (prompt && launched.length > 0) {
      await new Promise(r => setTimeout(r, 3000));
      for (const ref of launched) {
        try {
          cmux('send', '--surface', ref, prompt);
          cmux('send-key', '--surface', ref, 'enter');
        } catch { /* ignore */ }
      }
    }

    // 6. Set sidebar status
    try {
      cmux('set-status', 'agents', `${launched.length} ${def.label}`, '--icon', 'cpu');
    } catch { /* ignore */ }

    return ok({
      workspace: name,
      cli: cli,
      grid: `${cols}x${rows}`,
      launched: launched.length,
      surfaces: launched,
      command: fullCmd,
      ...(prompt ? { prompt_sent: prompt } : {}),
    });
  }),
);

server.tool(
  'cmux_read_all',
  'Read output from all panes/surfaces in the current (or specified) workspace.',
  {
    workspace: z.string().optional().describe('Workspace ID/ref'),
    lines: z.number().optional().describe('Lines per pane (default: 20)'),
  },
  safe(async ({ workspace, lines: lineCount }) => {
    const numLines = lineCount ?? 20;

    const args = ['list-pane-surfaces'];
    if (workspace) args.push('--workspace', workspace);
    let paneList: string;
    try { paneList = cmux(...args); } catch { return ok({ panes: [] }); }

    const surfaceRefs = paneList.match(/surface:\d+/g) ?? [];
    const results: { surface: string; output: string }[] = [];

    for (const ref of surfaceRefs) {
      try {
        const readArgs = ['read-screen', '--surface', ref, '--lines', String(numLines)];
        if (workspace) readArgs.push('--workspace', workspace);
        const output = cmux(...readArgs);
        results.push({ surface: ref, output });
      } catch (e: any) {
        results.push({ surface: ref, output: `(error: ${e.message})` });
      }
    }

    return ok({ total: results.length, panes: results });
  }),
);

server.tool(
  'cmux_broadcast',
  'Send the same text + Enter to ALL panes in a workspace.',
  {
    text: z.string().describe('Text to broadcast'),
    workspace: z.string().optional().describe('Workspace ID/ref'),
  },
  safe(async ({ text, workspace }) => {
    const args = ['list-pane-surfaces'];
    if (workspace) args.push('--workspace', workspace);
    let paneList: string;
    try { paneList = cmux(...args); } catch { return ok({ sent_to: 0 }); }

    const surfaceRefs = paneList.match(/surface:\d+/g) ?? [];
    let sent = 0;

    for (const ref of surfaceRefs) {
      try {
        const ws = workspace ? ['--workspace', workspace] : [];
        cmux('send', '--surface', ref, ...ws, text);
        cmux('send-key', '--surface', ref, ...ws, 'enter');
        sent++;
      } catch { /* ignore */ }
    }

    return ok({ sent_to: sent, total: surfaceRefs.length, text });
  }),
);

server.tool(
  'cmux_workspace_snapshot',
  'Full workspace snapshot: tree + all pane output + sidebar state.',
  {
    workspace: z.string().optional().describe('Workspace ID/ref'),
    lines: z.number().optional().describe('Lines per pane (default: 20)'),
  },
  safe(async ({ workspace, lines: lineCount }) => {
    const numLines = lineCount ?? 20;

    let tree: string | undefined;
    try {
      const args = ['tree'];
      if (workspace) args.push('--workspace', workspace);
      tree = cmux(...args);
    } catch { /* ignore */ }

    let sidebar: string | undefined;
    try {
      const args = ['sidebar-state'];
      if (workspace) args.push('--workspace', workspace);
      sidebar = cmux(...args);
    } catch { /* ignore */ }

    const paneArgs = ['list-pane-surfaces'];
    if (workspace) paneArgs.push('--workspace', workspace);
    let paneList: string;
    try { paneList = cmux(...paneArgs); } catch { paneList = ''; }

    const surfaceRefs = paneList.match(/surface:\d+/g) ?? [];
    const panes: { surface: string; output: string }[] = [];

    for (const ref of surfaceRefs) {
      try {
        const readArgs = ['read-screen', '--surface', ref, '--lines', String(numLines)];
        if (workspace) readArgs.push('--workspace', workspace);
        const output = cmux(...readArgs);
        panes.push({ surface: ref, output });
      } catch (e: any) {
        panes.push({ surface: ref, output: `(error: ${e.message})` });
      }
    }

    return ok({ tree, sidebar, total_panes: panes.length, panes });
  }),
);

// ============================================================================
// K. ADDITIONAL TOOLS
// ============================================================================

server.tool(
  'cmux_launch_grid',
  'Create a workspace with an exact rows x cols grid of panes, each running an optional command.',
  {
    rows: z.number().min(1).max(10).describe('Number of rows'),
    cols: z.number().min(1).max(10).describe('Number of columns'),
    command: z.string().optional().describe('Command to run in each pane'),
    cwd: z.string().optional().describe('Working directory'),
    workspace_name: z.string().optional().describe('Name for the workspace'),
  },
  safeMut(async ({ rows, cols, command, cwd, workspace_name }) => {
    if (!isCmuxRunning()) return err('CMUX is not running. Open cmux.app first.');

    const workDir = cwd ?? PROJECT_ROOT ?? homedir();
    cmux('new-workspace', '--cwd', workDir);
    if (workspace_name) {
      try { cmux('rename-workspace', workspace_name); } catch { /* ignore */ }
    }

    for (let c = 1; c < cols; c++) {
      try { cmux('new-split', 'right'); } catch { /* ignore */ }
    }
    if (rows > 1) {
      for (let r = 1; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (r * cols + c >= rows * cols) break;
          try { cmux('new-split', 'down'); } catch { /* ignore */ }
        }
      }
    }

    if (command) {
      let paneList: string;
      try { paneList = cmux('list-pane-surfaces'); } catch { paneList = ''; }
      const surfaceRefs = paneList.match(/surface:\d+/g) ?? [];
      for (const ref of surfaceRefs) {
        try {
          cmux('send', '--surface', ref, command);
          cmux('send-key', '--surface', ref, 'enter');
        } catch { /* ignore */ }
      }
    }

    return ok({ grid: `${rows}x${cols}`, total: rows * cols, workspace: workspace_name });
  }),
);

server.tool(
  'cmux_launch_mixed',
  `Launch agents with DIFFERENT CLIs in one workspace.
Supports: ${Object.keys(CLI_DEFS).join(', ')}.`,
  {
    agents: z.array(z.object({
      cli: z.enum(['claude', 'gemini', 'codex', 'opencode', 'goose']).describe('CLI to use'),
      label: z.string().optional().describe('Optional label'),
    })).describe('List of agents to launch'),
    cwd: z.string().optional().describe('Working directory'),
    workspace_name: z.string().optional().describe('Name for the workspace'),
  },
  safeMut(async ({ agents, cwd, workspace_name }) => {
    if (!isCmuxRunning()) return err('CMUX is not running. Open cmux.app first.');

    const workDir = cwd ?? PROJECT_ROOT ?? homedir();
    const count = agents.length;

    cmux('new-workspace', '--cwd', workDir);
    const name = workspace_name ?? `Mixed x${count}`;
    try { cmux('rename-workspace', name); } catch { /* ignore */ }

    const cols = Math.ceil(Math.sqrt(count));
    for (let c = 1; c < cols; c++) {
      try { cmux('new-split', 'right'); } catch { /* ignore */ }
    }
    const rows = Math.ceil(count / cols);
    if (rows > 1) {
      for (let r = 1; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (r * cols + c >= count) break;
          try { cmux('new-split', 'down'); } catch { /* ignore */ }
        }
      }
    }

    let paneList: string;
    try { paneList = cmux('list-pane-surfaces'); } catch { paneList = ''; }
    const surfaceRefs = paneList.match(/surface:\d+/g) ?? [];
    const launched: { surface: string; cli: string; label?: string }[] = [];

    for (let i = 0; i < Math.min(surfaceRefs.length, count); i++) {
      const agent = agents[i];
      const def = CLI_DEFS[agent.cli];
      if (!def) continue;

      const envPrefix = def.skipPermEnv
        ? Object.entries(def.skipPermEnv).map(([k, v]) => `${k}=${v}`).join(' ') + ' '
        : '';
      const fullCmd = envPrefix + [def.bin, ...def.skipPermFlags].join(' ');

      try {
        cmux('send', '--surface', surfaceRefs[i], fullCmd);
        cmux('send-key', '--surface', surfaceRefs[i], 'enter');
        launched.push({ surface: surfaceRefs[i], cli: agent.cli, label: agent.label });
      } catch { /* ignore */ }
    }

    return ok({ workspace: name, launched });
  }),
);

server.tool(
  'cmux_send_submit_some',
  'Send the same text + Enter to SPECIFIC surfaces (not all).',
  {
    surface_refs: z.array(z.string()).describe('List of surface refs to target'),
    text: z.string().describe('Text to send and submit'),
    workspace: z.string().optional().describe('Workspace ref'),
  },
  safe(async ({ surface_refs, text, workspace }) => {
    let sent = 0;
    for (const ref of surface_refs) {
      try {
        const ws = workspace ? ['--workspace', workspace] : [];
        cmux('send', '--surface', ref, ...ws, text);
        cmux('send-key', '--surface', ref, ...ws, 'enter');
        sent++;
      } catch { /* ignore */ }
    }
    return ok({ sent_to: sent, total: surface_refs.length, text });
  }),
);

server.tool(
  'cmux_send_key_all',
  'Send a key (e.g., ctrl+c, escape) to ALL panes in a workspace.',
  {
    key: z.string().describe('Key to send'),
    workspace: z.string().optional().describe('Workspace ref'),
  },
  safe(async ({ key, workspace }) => {
    const args = ['list-pane-surfaces'];
    if (workspace) args.push('--workspace', workspace);
    let paneList: string;
    try { paneList = cmux(...args); } catch { return ok({ sent_to: 0 }); }

    const surfaceRefs = paneList.match(/surface:\d+/g) ?? [];
    let sent = 0;

    for (const ref of surfaceRefs) {
      try {
        const ws = workspace ? ['--workspace', workspace] : [];
        cmux('send-key', '--surface', ref, ...ws, key);
        sent++;
      } catch { /* ignore */ }
    }

    return ok({ sent_to: sent, total: surfaceRefs.length, key });
  }),
);

server.tool(
  'cmux_send_each',
  'Send DIFFERENT text to each pane in a workspace. Texts array maps to panes in surface order.',
  {
    texts: z.array(z.string()).describe('Array of texts, one per pane'),
    workspace: z.string().optional().describe('Workspace ref'),
  },
  safe(async ({ texts, workspace }) => {
    const args = ['list-pane-surfaces'];
    if (workspace) args.push('--workspace', workspace);
    let paneList: string;
    try { paneList = cmux(...args); } catch { return ok({ sent_to: 0 }); }

    const surfaceRefs = paneList.match(/surface:\d+/g) ?? [];
    let sent = 0;

    for (let i = 0; i < Math.min(surfaceRefs.length, texts.length); i++) {
      try {
        const ws = workspace ? ['--workspace', workspace] : [];
        cmux('send', '--surface', surfaceRefs[i], ...ws, texts[i]);
        cmux('send-key', '--surface', surfaceRefs[i], ...ws, 'enter');
        sent++;
      } catch { /* ignore */ }
    }

    return ok({ sent_to: sent, total: surfaceRefs.length });
  }),
);

server.tool(
  'cmux_read_all_deep',
  'Deep read of ALL panes. For idle CLI agents, prompts them and returns their summary. For busy agents, reads passively.',
  {
    workspace: z.string().optional().describe('Workspace ref'),
    lines: z.number().optional().describe('Lines for non-queryable panes (default: 20)'),
    query: z.string().optional().describe('Question to ask idle agents'),
  },
  safe(async ({ workspace, lines: lineCount, query }) => {
    const numLines = lineCount ?? 20;
    const prompt = query ?? 'Briefly summarize what you have done and your current status.';

    const args = ['list-pane-surfaces'];
    if (workspace) args.push('--workspace', workspace);
    let paneList: string;
    try { paneList = cmux(...args); } catch { return ok({ panes: [] }); }

    const surfaceRefs = paneList.match(/surface:\d+/g) ?? [];
    const results: { surface: string; output: string; queried: boolean }[] = [];

    for (const ref of surfaceRefs) {
      try {
        const ws = workspace ? ['--workspace', workspace] : [];
        const screen = cmux('read-screen', '--surface', ref, ...ws, '--lines', '5');
        const lastLine = screen.trim().split('\n').pop() ?? '';
        const isIdle = /[>$%\u276F]\s*$/.test(lastLine) || /\?\s*$/.test(lastLine);

        if (isIdle) {
          cmux('send', '--surface', ref, ...ws, prompt);
          cmux('send-key', '--surface', ref, ...ws, 'enter');
          await new Promise(r => setTimeout(r, 5000));
          const output = cmux('read-screen', '--surface', ref, ...ws, '--lines', String(numLines));
          results.push({ surface: ref, output, queried: true });
        } else {
          const output = cmux('read-screen', '--surface', ref, ...ws, '--lines', String(numLines));
          results.push({ surface: ref, output, queried: false });
        }
      } catch (e: any) {
        results.push({ surface: ref, output: `(error: ${e.message})`, queried: false });
      }
    }

    return ok({ total: results.length, panes: results });
  }),
);

server.tool(
  'cmux_start',
  'Launch CMUX if not already running. Opens the cmux.app.',
  {
    cwd: z.string().optional().describe('Working directory'),
  },
  safe(async ({ cwd }) => {
    if (isCmuxRunning()) {
      return ok({ already_running: true });
    }

    const workDir = cwd ?? PROJECT_ROOT ?? homedir();
    try {
      execSync(`open -a cmux "${workDir}"`, { timeout: 10_000 });
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 1000));
        if (isCmuxRunning()) {
          return ok({ started: true, cwd: workDir });
        }
      }
      return ok({ started: false, note: 'CMUX opened but socket not ready yet.' });
    } catch (e: any) {
      return err(`Failed to start CMUX: ${e.message}`);
    }
  }),
);

server.tool(
  'cmux_close_all',
  'Close ALL workspaces — full shutdown of all panes.',
  {},
  safeMut(async () => {
    let wsList: string;
    try { wsList = cmux('list-workspaces'); } catch { return ok({ closed: 0 }); }

    const wsRefs = wsList.match(/workspace:\d+/g) ?? [];
    let closed = 0;

    for (const ref of wsRefs) {
      try {
        cmux('close-workspace', '--workspace', ref);
        closed++;
      } catch { /* ignore */ }
    }

    return ok({ closed, total: wsRefs.length });
  }),
);

server.tool(
  'cmux_screenshot',
  'Take a screenshot of the CMUX window using macOS screencapture.',
  {
    output_path: z.string().optional().describe('Output file path'),
  },
  safe(async ({ output_path }) => {
    const ts = Date.now();
    const outPath = output_path ?? `/tmp/cmux-screenshot-${ts}.png`;
    try {
      execSync(`screencapture -l $(osascript -e 'tell app "cmux" to id of window 1') "${outPath}"`, {
        timeout: 10_000,
        encoding: 'utf8',
      });
    } catch {
      execSync(`screencapture -w "${outPath}"`, { timeout: 10_000 });
    }
    return ok({ screenshot: outPath });
  }),
);

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

export async function runServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
