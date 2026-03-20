/**
 * CMUX MCP Server
 *
 * Exposes CMUX's terminal multiplexer as MCP tools.
 * Agents can create workspaces, spawn panes, inject prompts, read output,
 * manage layouts, control the sidebar, send notifications, and automate
 * the built-in browser without knowing the CLI syntax.
 */

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { CmuxSocket, cliArgsToSocketCall, formatResponse } from './cmux-socket.js';

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
  configSetup?: {
    path: string;
    settings: Record<string, unknown>;
  };
  trustSetup?: 'claude' | 'gemini' | 'codex';
  label: string;
};

const CLI_DEFS: Record<string, CliDef> = {
  claude: {
    bin: 'claude',
    skipPermFlags: ['--dangerously-skip-permissions'],
    trustSetup: 'claude',
    label: 'Claude Code',
  },
  gemini: {
    bin: 'gemini',
    skipPermFlags: ['--no-sandbox'],
    trustSetup: 'gemini',
    label: 'Gemini CLI',
  },
  codex: {
    bin: 'codex',
    skipPermFlags: ['-a', 'never'],
    trustSetup: 'codex',
    label: 'Codex CLI',
  },
  opencode: {
    bin: 'opencode',
    skipPermFlags: [],
    configSetup: { path: '~/.config/opencode/opencode.json', settings: { permission: 'allow' } },
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

const MANIFEST_DIR = PROJECT_ROOT ? join(PROJECT_ROOT, '.cmux-agent-mcp') : join(homedir(), '.cmux-agent-mcp');
const MANIFEST_PATH = join(MANIFEST_DIR, 'session.json');
const AUTOSAVE_PATH = join(MANIFEST_DIR, 'session.autosave.json');

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

/**
 * Detect which CLI is running in a surface by reading its output.
 * Returns the CLI key (claude, gemini, codex, etc.) or null.
 */
function detectCliFromScreen(screenText: string): string | null {
  const lower = screenText.toLowerCase();
  if (lower.includes('claude') && (lower.includes('code') || lower.includes('anthropic'))) return 'claude';
  if (lower.includes('gemini')) return 'gemini';
  if (lower.includes('codex')) return 'codex';
  if (lower.includes('opencode')) return 'opencode';
  if (lower.includes('goose')) return 'goose';
  return null;
}

/**
 * Get session ID for a CLI based on its working directory.
 *
 * Per-CLI session storage:
 * - Claude: ~/.claude/sessions/{PID}.json → { sessionId, cwd }
 * - Codex:  ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl → first line has session_meta
 * - Gemini: ~/.gemini/projects.json maps CWD→slug, ~/.gemini/tmp/{slug}/chats/*.json
 * - OpenCode: ~/.local/share/opencode/opencode.db (SQLite)
 * - Goose: goose session list --format json
 */
function getSessionId(cli: string, cwd: string): string | null {
  try {
    switch (cli) {
      case 'claude': {
        // Search ~/.claude/sessions/ for session files matching this CWD
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

        // Match by CWD
        const cwdMatch = files.find(f => f.cwd && normalizePath(f.cwd) === normalizePath(cwd));
        if (cwdMatch) return cwdMatch.sessionId ?? null;
        // Fallback: most recent session
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
        // Fallback: newest
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
        // Fallback without CWD filter
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

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
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
    // No session ID — try "resume latest" with fallback to fresh
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

  // Specific session ID — targeted resume
  switch (cli) {
    case 'claude':
      return `${envPrefix}${base} --resume ${sessionId}`;
    case 'gemini':
      // Gemini only accepts "latest", not UUIDs
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

async function captureManifest(): Promise<SessionManifest> {
  let branch: string | null = null;
  try {
    branch = execFileSync('git', ['-C', PROJECT_ROOT ?? '.', 'branch', '--show-current'], {
      encoding: 'utf8', timeout: 5000,
    }).trim() || null;
  } catch { /* ignore */ }

  // Get the full tree to understand workspace structure
  let treeOutput: string;
  try { treeOutput = await cmux('tree', '--all'); } catch { treeOutput = ''; }

  // List all workspaces
  let workspaceList: string;
  try { workspaceList = await cmux('list-workspaces'); } catch { workspaceList = ''; }
  const wsRefs = workspaceList.match(/workspace:\d+/g) ?? [];

  const workspaces: WorkspaceManifest[] = [];

  for (const wsRef of wsRefs) {
    // Get workspace name
    let wsName = wsRef;
    try {
      const sidebar = await cmux('sidebar-state', '--workspace', wsRef);
      const cwdMatch = sidebar.match(/cwd[:\s]+([^\n]+)/i);
      wsName = cwdMatch?.[1]?.trim() ?? wsRef;
    } catch { /* ignore */ }

    // List surfaces in this workspace
    let surfList: string;
    try { surfList = await cmux('list-pane-surfaces', '--workspace', wsRef); } catch { surfList = ''; }
    const surfRefs = surfList.match(/surface:\d+/g) ?? [];

    const surfaces: SurfaceManifest[] = [];

    for (const surfRef of surfRefs) {
      // Read screen to detect CLI
      let screenText = '';
      try {
        screenText = await cmux('read-screen', '--surface', surfRef, '--workspace', wsRef, '--lines', '30');
      } catch { /* ignore */ }

      const cli = detectCliFromScreen(screenText) ?? 'shell';

      // Get CWD from sidebar state
      let surfCwd = PROJECT_ROOT ?? homedir();
      try {
        const sidebarState = await cmux('sidebar-state', '--workspace', wsRef);
        const cwdMatch = sidebarState.match(/cwd[:\s]+([^\n]+)/i);
        if (cwdMatch) surfCwd = cwdMatch[1]!.trim();
      } catch { /* ignore */ }

      // Get session ID if it's a known CLI
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
// Session manifest persistence
// ---------------------------------------------------------------------------

function loadAutoSave(): SessionManifest | null {
  try {
    if (!existsSync(AUTOSAVE_PATH)) return null;
    return JSON.parse(readFileSync(AUTOSAVE_PATH, 'utf8'));
  } catch {
    return null;
  }
}


// ---------------------------------------------------------------------------
// CMUX CLI Helpers (legacy — kept for cmuxBin reference)
// ---------------------------------------------------------------------------

function cmuxBin(): string {
  if (process.env['CMUX_BIN']) return process.env['CMUX_BIN'];
  const bundled = '/Applications/cmux.app/Contents/Resources/bin/cmux';
  if (existsSync(bundled)) return bundled;
  return 'cmux';
}

// ---------------------------------------------------------------------------
// CMUX Transport — persistent socket with CLI fallback for unsupported methods
// ---------------------------------------------------------------------------

let socket: CmuxSocket | null = null;

async function initTransport(): Promise<void> {
  socket = new CmuxSocket();
  await socket.connect();
}

/**
 * Execute a cmux command via persistent socket.
 * All commands go through the socket — no CLI subprocess fallback.
 * JSON-RPC commands use the persistent connection.
 * Sidebar commands use the raw text protocol on a dedicated connection.
 */
async function cmux(...args: string[]): Promise<string> {
  if (!socket) throw new Error('CMUX socket not initialized — is CMUX running?');

  const translated = cliArgsToSocketCall(args);
  if (!translated) {
    throw new Error(`Unrecognized cmux command: ${args[0]}`);
  }

  if (translated.kind === 'json') {
    const result = await socket.call(translated.method, translated.params);
    return formatResponse(translated.method, result);
  }

  // Raw sidebar protocol
  const uuid = await socket.resolveWorkspaceUUID(translated.workspaceRef);
  const rawCmd = `${translated.rawCommand} --tab=${uuid}`;
  return await socket.callRaw(rawCmd);
}

async function cmuxJson(...args: string[]): Promise<any> {
  if (!socket) throw new Error('CMUX socket not initialized — is CMUX running?');

  const translated = cliArgsToSocketCall(args.filter(a => a !== '--json'));
  if (translated && translated.kind === 'json') {
    return await socket.call(translated.method, translated.params);
  }
  const raw = await cmux(...args, '--json');
  return JSON.parse(raw);
}

async function isCmuxRunning(): Promise<boolean> {
  try {
    await cmux('ping');
    return true;
  } catch {
    return false;
  }
}

/** Extract workspace ref (e.g. "workspace:6") from cmux new-workspace output like "OK workspace:6" */
function parseWorkspaceRef(output: string): string | null {
  const m = output.match(/workspace:\d+/);
  return m ? m[0] : null;
}

/** Get all surface refs across ALL panes in a workspace using list-panels (not list-pane-surfaces which only returns focused pane). */
async function allSurfaceRefs(workspace?: string): Promise<string[]> {
  const args = ['list-panels'];
  if (workspace) args.push('--workspace', workspace);
  let panelList: string;
  try { panelList = await cmux(...args); } catch { return []; }
  return panelList.match(/surface:\d+/g) ?? [];
}

/** Resolve a pane ref to its first (selected) surface ref. If already a surface ref, return as-is. */
async function resolvePanelRef(ref: string, workspace?: string): Promise<string> {
  if (!ref.startsWith('pane:')) return ref;
  const args = ['list-pane-surfaces', '--pane', ref];
  if (workspace) args.push('--workspace', workspace);
  const output = await cmux(...args);
  const m = output.match(/surface:\d+/);
  if (!m) throw new Error(`No surfaces found in ${ref}`);
  return m[0];
}

/** Map a key name (e.g. "enter", "ctrl+c") to text bytes for send-panel. */
function keyToText(key: string): string | null {
  const k = key.toLowerCase();
  // Keys handled by CLI escape sequence parsing (literal \n, \r, \t in the string)
  const escMap: Record<string, string> = {
    'enter': '\\n', 'return': '\\r',
    'tab': '\\t',
  };
  if (escMap[k]) return escMap[k];
  // Raw byte control characters
  const rawMap: Record<string, string> = {
    'escape': '\x1b', 'esc': '\x1b',
    'backspace': '\x7f',
    'delete': '\x1b[3~',
    'up': '\x1b[A', 'down': '\x1b[B',
    'left': '\x1b[D', 'right': '\x1b[C',
    'home': '\x1b[H', 'end': '\x1b[F',
  };
  if (rawMap[k]) return rawMap[k];
  // ctrl+letter → raw control byte
  const ctrlMatch = k.match(/^ctrl\+([a-z])$/);
  if (ctrlMatch) return String.fromCharCode(ctrlMatch[1].charCodeAt(0) - 96);
  return null;
}

/** Get all unique panel refs in a workspace. */
async function allPanelRefs(workspace?: string): Promise<string[]> {
  const args = ['list-panels'];
  if (workspace) args.push('--workspace', workspace);
  let panelList: string;
  try { panelList = await cmux(...args); } catch { return []; }
  const refs = panelList.match(/panel:\d+/g) ?? [];
  return [...new Set(refs)];
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

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function ok(data: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
}

function err(message: string): { content: { type: 'text'; text: string }[]; isError: true } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// ---------------------------------------------------------------------------
// Batch execution registry — stores raw handlers for cmux_batch
// ---------------------------------------------------------------------------

const toolRegistry = new Map<string, { handler: (params: any) => Promise<any>; mutating: boolean }>();

/** Drill into a nested object by path like ".surfaces[0].ref" */
function drillPath(obj: unknown, path: string): unknown {
  if (!path || obj == null) return obj;
  const segments = path.match(/\.(\w+)|\[(\d+)\]/g);
  if (!segments) return obj;
  let cur: any = obj;
  for (const seg of segments) {
    if (cur == null) return undefined;
    if (seg.startsWith('.')) cur = cur[seg.slice(1)];
    else if (seg.startsWith('[')) cur = cur[parseInt(seg.slice(1, -1))];
  }
  return cur;
}

/** Resolve $steps[N].path.to.field references in a string value.
 *  If the entire string is a single ref, returns the raw value (preserving type). */
function resolveVarRef(value: string, outputs: unknown[]): unknown {
  const fullMatch = value.match(/^\$steps\[(\d+)\](.*)$/);
  if (fullMatch && value === fullMatch[0]) {
    const stepIdx = parseInt(fullMatch[1]);
    if (stepIdx >= outputs.length) return value;
    return drillPath(outputs[stepIdx], fullMatch[2]);
  }
  return value.replace(/\$steps\[(\d+)\]([.\[][^\s,}"]*)/g, (_, idx, path) => {
    const i = parseInt(idx);
    if (i >= outputs.length) return _;
    const resolved = drillPath(outputs[i], path);
    return resolved != null ? String(resolved) : '';
  });
}

/** Recursively resolve variable refs in all string values of a params object */
function resolveAllVars(params: unknown, outputs: unknown[]): unknown {
  if (typeof params === 'string') return resolveVarRef(params, outputs);
  if (Array.isArray(params)) return params.map(v => resolveAllVars(v, outputs));
  if (params && typeof params === 'object') {
    const resolved: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(params)) {
      resolved[key] = resolveAllVars(val, outputs);
    }
    return resolved;
  }
  return params;
}

/** Extract the data payload from an ok() response */
function unwrapOk(result: any): unknown {
  try {
    if (result?.content?.[0]?.text) {
      return JSON.parse(result.content[0].text);
    }
  } catch { /* not JSON, return as-is */ }
  return result?.content?.[0]?.text ?? result;
}

/** Wrap a tool handler with standard error handling */
/** Enrich common errors with actionable suggestions */
function enrichError(msg: string): string {
  if (msg.includes('Surface is not a terminal')) {
    return msg + '\n\nHINT: This surface is running an AI CLI. Use cmux_read_all (not cmux_read_screen) to read, and cmux_orchestrate (not cmux_send/cmux_send_submit) to send prompts.';
  }
  return msg;
}

function safe(fn: (...args: any[]) => any) {
  return async (...args: any[]) => {
    try {
      return await fn(...args);
    } catch (e: any) {
      return err(enrichError(e.message ?? String(e)));
    }
  };
}

/** Wrap a MUTATING tool handler with standard error handling */
function safeMut(fn: (...args: any[]) => any) {
  return async (...args: any[]) => {
    try {
      return await fn(...args);
    } catch (e: any) {
      return err(enrichError(e.message ?? String(e)));
    }
  };
}

/** Register a tool that can be called from cmux_batch. Also registers with the MCP server. */
function registerBatchable(
  name: string,
  desc: string,
  schema: Record<string, z.ZodType<any>>,
  handler: (params: any) => Promise<any>,
  mutating: boolean,
) {
  toolRegistry.set(name, { handler, mutating });
  server.tool(name, desc, schema, mutating ? safeMut(handler) : safe(handler));
}

/** Default workspace/surface from params or env */
function wsArgs(workspace?: string, surface?: string): string[] {
  const args: string[] = [];
  const ws = workspace ?? process.env['CMUX_WORKSPACE_ID'];
  const sf = surface ?? (workspace ? undefined : process.env['CMUX_SURFACE_ID']);
  if (ws) args.push('--workspace', ws);
  if (sf) args.push('--surface', sf);
  return args;
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({ name: 'cmux-agent-mcp', version: '0.1.0' });

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
  'Check if CMUX is installed and running. Shows project config and full hierarchy. IMPORTANT: All cmux tools use ref format for IDs (e.g., "surface:8", "workspace:5", "pane:3", "tab:2"). Use cmux_identify or cmux_list_pane_surfaces to discover refs.',
  {},
  safe(async () => {
    const installed = isCmuxInstalled();
    const running = installed ? await isCmuxRunning() : false;

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
    try { tree = await cmux('tree', '--all'); } catch { /* ignore */ }

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
    return ok(await cmux(...args));
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
    return ok(await cmux(...args));
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
    return ok(await cmux(...args));
  }),
);

// ============================================================================
// B. WORKSPACE MANAGEMENT
// ============================================================================

registerBatchable(
  'cmux_list_workspaces',
  'List all open workspaces.',
  {},
  async () => ok(await cmux('list-workspaces')),
  false,
);

server.tool(
  'cmux_current_workspace',
  'Get the currently active workspace.',
  {},
  safe(async () => ok(await cmux('current-workspace'))),
);

server.tool(
  'cmux_new_workspace',
  'Create a new workspace. Returns the workspace_ref so you can use it immediately without a follow-up list call.',
  {
    cwd: z.string().optional().describe('Working directory for the new workspace'),
    command: z.string().optional().describe('Command to run in the initial pane'),
  },
  safeMut(async ({ cwd, command }) => {
    const args = ['new-workspace'];
    if (cwd) args.push('--cwd', cwd);
    if (command) args.push('--command', command);
    const result = await cmux(...args);
    const wsRef = parseWorkspaceRef(result);
    return ok({ workspace_ref: wsRef, raw: result });
  }),
);

server.tool(
  'cmux_select_workspace',
  'Switch to a specific workspace.',
  {
    workspace: z.string().describe('Workspace ID or ref to switch to'),
  },
  safe(async ({ workspace }) => ok(await cmux('select-workspace', '--workspace', workspace))),
);

server.tool(
  'cmux_close_workspace',
  'Close one or more workspaces and all their panes. Pass a single ref or an array of refs.',
  {
    workspace: z.union([z.string(), z.array(z.string())]).describe('Workspace ref(s) to close — single string or array of strings'),
  },
  safeMut(async ({ workspace }) => {
    const refs = Array.isArray(workspace) ? workspace : [workspace];
    const results: { ref: string; closed: boolean; error?: string }[] = [];
    for (const ref of refs) {
      try {
        await cmux('close-workspace', '--workspace', ref);
        results.push({ ref, closed: true });
      } catch (e: any) {
        results.push({ ref, closed: false, error: e.message });
      }
    }
    if (refs.length === 1) return ok(results[0].closed ? `OK ${refs[0]}` : results[0].error);
    return ok({ closed: results.filter(r => r.closed).length, total: refs.length, results });
  }),
);

registerBatchable(
  'cmux_rename_workspace',
  'Rename a workspace — this changes the name shown in the SIDEBAR. The sidebar displays workspace names, not tab names. Use this to rename what appears in the left sidebar.',
  {
    title: z.string().describe('New workspace title'),
    workspace: z.string().optional().describe('Workspace ID/ref (default: current)'),
  },
  async ({ title, workspace }) => {
    const args = ['rename-workspace'];
    if (workspace) args.push('--workspace', workspace);
    args.push(title);
    return ok(await cmux(...args));
  },
  true,
);

// ============================================================================
// C. WINDOW MANAGEMENT
// ============================================================================

server.tool(
  'cmux_list_windows',
  'List all open windows.',
  {},
  safe(async () => ok(await cmux('list-windows'))),
);

server.tool(
  'cmux_current_window',
  'Get the currently focused window.',
  {},
  safe(async () => ok(await cmux('current-window'))),
);

server.tool(
  'cmux_new_window',
  'Create a new window. Returns the window ref.',
  {},
  safeMut(async () => {
    const result = await cmux('new-window');
    const m = result.match(/OK\s+([0-9A-Fa-f-]{36})/);
    return ok({ window_ref: m ? m[1] : null, raw: result });
  }),
);

server.tool(
  'cmux_focus_window',
  'Focus a specific window.',
  {
    window: z.string().describe('Window ID to focus'),
  },
  safe(async ({ window: win }) => ok(await cmux('focus-window', '--window', win))),
);

server.tool(
  'cmux_close_window',
  'Close a window.',
  {
    window: z.string().describe('Window ID to close'),
  },
  safeMut(async ({ window: win }) => ok(await cmux('close-window', '--window', win))),
);

registerBatchable(
  'cmux_rename_window',
  'Rename a window — this changes the TITLE BAR text at the very top of the window.',
  {
    title: z.string().describe('New window title'),
    workspace: z.string().optional().describe('Workspace ID/ref'),
  },
  async ({ title, workspace }) => {
    const args = ['rename-window'];
    if (workspace) args.push('--workspace', workspace);
    args.push(title);
    return ok(await cmux(...args));
  },
  true,
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
    const ws = workspace ?? undefined;
    const beforeRefs = await allSurfaceRefs(ws);
    const args = ['new-surface'];
    if (type) args.push('--type', type);
    if (pane) args.push('--pane', pane);
    if (workspace) args.push('--workspace', workspace);
    if (url) args.push('--url', url);
    const result = await cmux(...args);
    const afterRefs = await allSurfaceRefs(ws);
    const newRef = afterRefs.find(r => !beforeRefs.includes(r));
    return ok({ surface: newRef ?? null, raw: result });
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
    return ok(await cmux(...args));
  }),
);

registerBatchable(
  'cmux_rename_tab',
  'Rename a tab — this changes the name shown in the TAB BAR (top), NOT the sidebar. The sidebar shows workspace names (use cmux_rename_workspace for that). To rename the window title bar, use cmux_rename_window. IDs must use ref format like "tab:8", not bare numbers.',
  {
    title: z.string().describe('New tab title'),
    workspace: z.string().optional().describe('Workspace ref (e.g., "workspace:5")'),
    tab: z.string().optional().describe('Tab ref (e.g., "tab:3")'),
    surface: z.string().optional().describe('Surface ref (e.g., "surface:8")'),
  },
  async ({ title, workspace, tab, surface }) => {
    const args = ['rename-tab'];
    if (workspace) args.push('--workspace', workspace);
    if (tab) args.push('--tab', tab);
    const sf = surface ?? process.env['CMUX_SURFACE_ID'];
    if (sf) args.push('--surface', sf);
    args.push(title);
    return ok(await cmux(...args));
  },
  true,
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
    return ok(await cmux(...args));
  }),
);

server.tool(
  'cmux_reorder_surface',
  'Reorder a tab within its pane — change its position without closing it.',
  {
    surface: z.string().describe('Surface ref to reorder (e.g., "surface:8")'),
    index: z.number().optional().describe('Target index position'),
    before: z.string().optional().describe('Place before this surface ref'),
    after: z.string().optional().describe('Place after this surface ref'),
  },
  safeMut(async ({ surface, index, before, after }) => {
    const args = ['reorder-surface', '--surface', surface];
    if (index !== undefined) args.push('--index', String(index));
    if (before) args.push('--before', before);
    if (after) args.push('--after', after);
    return ok(await cmux(...args));
  }),
);

server.tool(
  'cmux_reorder_workspace',
  'Reorder a workspace in the SIDEBAR — change its position without closing it.',
  {
    workspace: z.string().describe('Workspace ref to reorder (e.g., "workspace:5")'),
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
    return ok(await cmux(...args));
  }),
);

server.tool(
  'cmux_move_workspace_to_window',
  'Move a workspace to a different window without closing it.',
  {
    workspace: z.string().describe('Workspace ref to move (e.g., "workspace:5")'),
    window: z.string().describe('Target window ref (e.g., "window:1")'),
  },
  safeMut(async ({ workspace, window: win }) => {
    return ok(await cmux('move-workspace-to-window', '--workspace', workspace, '--window', win));
  }),
);

server.tool(
  'cmux_drag_surface_to_split',
  'Move a tab into a split position — turns a tab into its own pane by dragging it to a side. Does not close the tab.',
  {
    surface: z.string().describe('Surface ref to drag (e.g., "surface:8")'),
    direction: z.enum(['left', 'right', 'up', 'down']).describe('Direction to split into'),
    workspace: z.string().optional().describe('Workspace ID/ref (default: current)'),
  },
  safeMut(async ({ surface, direction, workspace }) => {
    // Try native command first
    try {
      const args = ['drag-surface-to-split', direction, '--surface', surface];
      if (workspace) args.push('--workspace', workspace);
      return ok(await cmux(...args));
    } catch {
      // Workaround: native command has surface lookup bug — emulate with new-split + move-surface
      const ws = workspace ?? undefined;
      const beforePanes = await allSurfaceRefs(ws);
      const splitArgs = ['new-split', direction];
      if (workspace) splitArgs.push('--workspace', workspace);
      await cmux(...splitArgs);
      const afterPanes = await allSurfaceRefs(ws);
      const newRef = afterPanes.find(r => !beforePanes.includes(r));
      if (!newRef) throw new Error('Failed to create new split pane');
      // Move the original surface into the new pane
      const moveArgs = ['move-surface', '--surface', surface];
      if (workspace) moveArgs.push('--workspace', workspace);
      await cmux(...moveArgs);
      return ok(`OK (emulated: split ${direction}, moved ${surface})`);
    }
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
    return ok(await cmux(...args));
  }),
);

registerBatchable(
  'cmux_list_pane_surfaces',
  'List all pane surfaces in a workspace — returns the surface refs (e.g., "surface:8") needed by other tools.',
  {
    workspace: z.string().optional().describe('Workspace ref (e.g., "workspace:5")'),
  },
  async ({ workspace }) => {
    const args = ['list-panels'];
    if (workspace) args.push('--workspace', workspace);
    return ok(await cmux(...args));
  },
  false,
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
    return ok(await cmux(...args));
  }),
);

server.tool(
  'cmux_new_split',
  `Split an existing pane. Returns the new surface ref and updated pane count.
- "right" or "left" = side-by-side (horizontal split, vertical divider) — like Cmd+D
- "down" or "up" = stacked top/bottom (vertical split, horizontal divider) — like Cmd+Shift+D
When user says "vertical pane/split", they mean stacked top-bottom, so use "down".
When user says "horizontal pane/split", they mean side-by-side, so use "right".`,
  {
    direction: z.enum(['left', 'right', 'up', 'down']).describe('right/left = side-by-side, down/up = stacked top-bottom'),
    workspace: z.string().optional().describe('Workspace ID/ref'),
    surface: z.string().optional().describe('Surface ID/ref to split from'),
    panel: z.string().optional().describe('Panel ID/ref to split from'),
  },
  safeMut(async ({ direction, workspace, surface, panel }) => {
    const ws = workspace ?? undefined;
    const beforeRefs = await allSurfaceRefs(ws);
    const args = ['new-split', direction];
    if (workspace) args.push('--workspace', workspace);
    const sf = surface ?? process.env['CMUX_SURFACE_ID'];
    if (sf) args.push('--surface', sf);
    if (panel) args.push('--panel', panel);
    const result = await cmux(...args);
    const afterRefs = await allSurfaceRefs(ws);
    const newRef = afterRefs.find(r => !beforeRefs.includes(r));
    return ok({ surface: newRef ?? null, pane_count: afterRefs.length, raw: result });
  }),
);

server.tool(
  'cmux_new_pane',
  'Create a new pane (terminal or browser) in a workspace. Returns the new surface ref.',
  {
    type: z.enum(['terminal', 'browser']).optional().describe('Pane type'),
    direction: z.enum(['left', 'right', 'up', 'down']).optional().describe('Split direction'),
    workspace: z.string().optional().describe('Workspace ID/ref'),
    url: z.string().optional().describe('URL for browser panes'),
  },
  safeMut(async ({ type, direction, workspace, url }) => {
    const ws = workspace ?? undefined;
    const beforeRefs = await allSurfaceRefs(ws);
    const args = ['new-pane'];
    if (type) args.push('--type', type);
    if (direction) args.push('--direction', direction);
    if (workspace) args.push('--workspace', workspace);
    if (url) args.push('--url', url);
    const result = await cmux(...args);
    const afterRefs = await allSurfaceRefs(ws);
    const newRef = afterRefs.find(r => !beforeRefs.includes(r));
    return ok({ surface: newRef ?? null, pane_count: afterRefs.length, raw: result });
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
    return ok(await cmux(...args));
  }),
);

server.tool(
  'cmux_resize_pane',
  'Resize a pane in a direction.',
  {
    pane: z.string().describe('Pane ID/ref to resize'),
    direction: z.enum(['L', 'R', 'U', 'D']).describe('Resize direction (L=left, R=right, U=up, D=down)'),
    amount: z.number().optional().describe('Resize amount in cells'),
    workspace: z.string().optional().describe('Workspace ID/ref'),
  },
  safeMut(async ({ pane, direction, amount, workspace }) => {
    const args = ['resize-pane', '--pane', pane, `-${direction}`];
    if (amount !== undefined) args.push('--amount', String(amount));
    if (workspace) args.push('--workspace', workspace);
    return ok(await cmux(...args));
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
    return ok(await cmux(...args));
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
    const sf = surface ?? process.env['CMUX_SURFACE_ID'];
    if (sf) args.push('--surface', sf);
    return ok(await cmux(...args));
  }),
);

server.tool(
  'cmux_join_pane',
  'Join a pane into another pane — merges two split panes together without closing either. The opposite of break-pane.',
  {
    target_pane: z.string().describe('Target pane ref to join into (e.g., "pane:5")'),
    workspace: z.string().optional().describe('Workspace ref'),
    pane: z.string().optional().describe('Source pane ref to move'),
    surface: z.string().optional().describe('Surface ref'),
  },
  safeMut(async ({ target_pane, workspace, pane, surface }) => {
    const args = ['join-pane', '--target-pane', target_pane];
    if (workspace) args.push('--workspace', workspace);
    if (pane) args.push('--pane', pane);
    const sf = surface ?? process.env['CMUX_SURFACE_ID'];
    if (sf) args.push('--surface', sf);
    return ok(await cmux(...args));
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
    return ok(await cmux(...args));
  }),
);

// ============================================================================
// F. TEXT I/O
// ============================================================================

server.tool(
  'cmux_send',
  'Send text to a PLAIN TERMINAL surface without pressing Enter. DOES NOT work on AI CLI surfaces — use cmux_orchestrate, cmux_broadcast, or cmux_send_each for agent surfaces.',
  {
    text: z.string().describe('Text to send'),
    workspace: z.string().optional().describe('Workspace ID/ref'),
    surface: z.string().optional().describe('Surface ID/ref'),
  },
  safe(async ({ text, workspace, surface }) => {
    const args = ['send', ...wsArgs(workspace, surface), text];
    return ok(await cmux(...args));
  }),
);

server.tool(
  'cmux_send_submit',
  'Send text and press Enter to a PLAIN TERMINAL surface. DOES NOT work on AI CLI surfaces (returns "Surface is not a terminal"). To send prompts to AI agents, use cmux_orchestrate, cmux_broadcast, or cmux_send_each instead.',
  {
    text: z.string().describe('Text to send'),
    workspace: z.string().optional().describe('Workspace ID/ref'),
    surface: z.string().optional().describe('Surface ID/ref'),
  },
  safeMut(async ({ text, workspace, surface }) => {
    const ws = wsArgs(workspace, surface);
    await cmux('send', ...ws, text);
    await cmux('send-key', ...ws, 'enter');
    return ok({ sent: text, submitted: true });
  }),
);

server.tool(
  'cmux_send_key',
  'Send a key press to a PLAIN TERMINAL surface (enter, tab, escape, backspace, delete, up, down, left, right, ctrl+c, etc.). DOES NOT work on AI CLI surfaces — use cmux_send_key_all for agent workspaces.',
  {
    key: z.string().describe('Key to send (e.g., enter, tab, escape, ctrl+c, up, down)'),
    workspace: z.string().optional().describe('Workspace ID/ref'),
    surface: z.string().optional().describe('Surface ID/ref'),
  },
  safe(async ({ key, workspace, surface }) => {
    const args = ['send-key', ...wsArgs(workspace, surface), key];
    return ok(await cmux(...args));
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
    const resolved = await resolvePanelRef(panel, workspace);
    const args = ['send-panel', '--panel', resolved];
    if (workspace) args.push('--workspace', workspace);
    args.push(text);
    return ok(await cmux(...args));
  }),
);

server.tool(
  'cmux_read_screen',
  'Read terminal output from a PLAIN TERMINAL surface. DOES NOT work on surfaces running AI CLIs (Claude, Gemini, etc.) — those return "Surface is not a terminal". To read from AI agent surfaces, use cmux_read_all or cmux_read_all_deep instead. Use --scrollback to include scroll buffer.',
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
    return ok(await cmux(...args));
  }),
);

server.tool(
  'cmux_capture_pane',
  'Capture pane output (tmux-compatible). Same limitations as cmux_read_screen — only works on plain terminal surfaces, NOT AI CLI surfaces.',
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
    return ok(await cmux(...args));
  }),
);

// ============================================================================
// G. SIDEBAR METADATA
// ============================================================================

registerBatchable(
  'cmux_set_status',
  'Set a sidebar metadata status pill (key-value badge) for a workspace. This does NOT rename the workspace — use cmux_rename_workspace to change the sidebar name.',
  {
    key: z.string().describe('Status key (unique identifier)'),
    value: z.string().describe('Status value to display'),
    icon: z.string().optional().describe('Icon name'),
    color: z.string().optional().describe('Color hex (e.g., #ff0000)'),
    workspace: z.string().optional().describe('Workspace ID/ref'),
  },
  async ({ key, value, icon, color, workspace }) => {
    const args = ['set-status', key, value];
    if (icon) args.push('--icon', icon);
    if (color) args.push('--color', color);
    if (workspace) args.push('--workspace', workspace);
    return ok(await cmux(...args));
  },
  false,
);

registerBatchable(
  'cmux_clear_status',
  'Clear a sidebar status key.',
  {
    key: z.string().describe('Status key to clear'),
    workspace: z.string().optional().describe('Workspace ID/ref'),
  },
  async ({ key, workspace }) => {
    const args = ['clear-status', key];
    if (workspace) args.push('--workspace', workspace);
    return ok(await cmux(...args));
  },
  false,
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
    return ok(await cmux(...args));
  }),
);

registerBatchable(
  'cmux_set_progress',
  'Set a sidebar progress indicator (0.0 to 1.0).',
  {
    progress: z.number().min(0).max(1).describe('Progress value (0.0 to 1.0)'),
    label: z.string().optional().describe('Progress label text'),
    workspace: z.string().optional().describe('Workspace ID/ref'),
  },
  async ({ progress, label, workspace }) => {
    const args = ['set-progress', String(progress)];
    if (label) args.push('--label', label);
    if (workspace) args.push('--workspace', workspace);
    return ok(await cmux(...args));
  },
  false,
);

registerBatchable(
  'cmux_clear_progress',
  'Clear the sidebar progress indicator.',
  {
    workspace: z.string().optional().describe('Workspace ID/ref'),
  },
  async ({ workspace }) => {
    const args = ['clear-progress'];
    if (workspace) args.push('--workspace', workspace);
    return ok(await cmux(...args));
  },
  false,
);

registerBatchable(
  'cmux_log',
  'Write a log entry to the sidebar.',
  {
    message: z.string().describe('Log message'),
    level: z.enum(['info', 'progress', 'success', 'warning', 'error']).optional().describe('Log level'),
    source: z.string().optional().describe('Source name'),
    workspace: z.string().optional().describe('Workspace ID/ref'),
  },
  async ({ message, level, source, workspace }) => {
    const args = ['log'];
    if (level) args.push('--level', level);
    if (source) args.push('--source', source);
    if (workspace) args.push('--workspace', workspace);
    args.push('--', message);
    return ok(await cmux(...args));
  },
  false,
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
    return ok(await cmux(...args));
  }),
);

// ============================================================================
// H. NOTIFICATIONS
// ============================================================================

/** Notification lines that have been cleared client-side (CMUX CLI clear may only dismiss badge). */
const clearedNotificationLines = new Set<string>();

registerBatchable(
  'cmux_notify',
  'Send a notification to a workspace/surface. Shows blue ring and sidebar highlight.',
  {
    title: z.string().describe('Notification title'),
    subtitle: z.string().optional().describe('Notification subtitle'),
    body: z.string().optional().describe('Notification body'),
    workspace: z.string().optional().describe('Workspace ID/ref'),
    surface: z.string().optional().describe('Surface ID/ref'),
  },
  async ({ title, subtitle, body, workspace, surface }) => {
    const args = ['notify', '--title', title];
    if (subtitle) args.push('--subtitle', subtitle);
    if (body) args.push('--body', body);
    const ws = wsArgs(workspace, surface);
    args.push(...ws);
    return ok(await cmux(...args));
  },
  false,
);
server.tool(
  'cmux_list_notifications',
  'List unread notifications.',
  {},
  safe(async () => {
    const raw = await cmux('list-notifications');
    const lines = raw
      .split('\n')
      .filter((line) => line.trim() && !clearedNotificationLines.has(line.trim()))
      .join('\n');
    return ok(lines || 'No unread notifications.');
  }),
);

server.tool(
  'cmux_clear_notifications',
  'Clear all notifications.',
  {},
  safe(async () => {
    // Call CLI clear (dismisses badge/ring)
    await cmux('clear-notifications');
    // Track all current notification lines so list_notifications filters them out
    try {
      const raw = await cmux('list-notifications');
      for (const line of raw.split('\n')) {
        if (line.trim()) clearedNotificationLines.add(line.trim());
      }
    } catch { /* best effort */ }
    return ok('OK');
  }),
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
    const sf = surface ?? process.env['CMUX_SURFACE_ID'];
    if (sf) args.push('--surface', sf);
    args.push('open');
    if (url) args.push(url);
    return ok(await cmux(...args));
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
    const sf = surface ?? process.env['CMUX_SURFACE_ID'];
    if (sf) args.push('--surface', sf);
    args.push(action);
    if (action === 'goto' && url) args.push(url);
    return ok(await cmux(...args));
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
    const sf = surface ?? process.env['CMUX_SURFACE_ID'];
    if (sf) args.push('--surface', sf);
    args.push('snapshot');
    if (interactive) args.push('--interactive');
    if (compact) args.push('--compact');
    if (max_depth !== undefined) args.push('--max-depth', String(max_depth));
    if (selector) args.push('--selector', selector);
    return ok(await cmux(...args));
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
    const outPath = out ?? `/tmp/cmux-screenshot-${Date.now()}.png`;
    const sf = surface ?? process.env['CMUX_SURFACE_ID'];

    // Try native browser screenshot (WKWebView takeSnapshot) first
    let nativeOk = false;
    try {
      const args = ['browser'];
      if (sf) args.push('--surface', sf);
      args.push('screenshot', '--out', outPath);
      const result = await cmux(...args);
      // Verify the file was actually created and is non-empty
      if (existsSync(outPath) && statSync(outPath).size > 0 && !result.includes('Failed')) {
        nativeOk = true;
      }
    } catch { /* fall through to screencapture */ }

    if (!nativeOk) {
      // Native snapshot is unreliable — fall back to macOS screencapture
      // Remove any empty/corrupt file from failed native attempt
      try { if (existsSync(outPath)) unlinkSync(outPath); } catch {}
      let captured = false;
      try {
        const windowId = execSync(
          `python3 -c "
import Quartz
wl = Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionOnScreenOnly, Quartz.kCGNullWindowID)
for w in wl:
    if w.get('kCGWindowOwnerName','') == 'cmux':
        print(w['kCGWindowNumber']); break
"`,
          { timeout: 5_000, encoding: 'utf8' },
        ).trim();
        if (windowId && /^\d+$/.test(windowId)) {
          execSync(`screencapture -l ${windowId} -x "${outPath}"`, { timeout: 10_000 });
          if (existsSync(outPath) && statSync(outPath).size > 0) captured = true;
        }
      } catch { /* fall through to full-screen capture */ }
      if (!captured) {
        execSync(`screencapture -x "${outPath}"`, { timeout: 10_000 });
      }
    }

    const data = readFileSync(outPath).toString('base64');
    return {
      content: [
        { type: 'image' as const, data, mimeType: 'image/png' },
        { type: 'text' as const, text: outPath },
      ],
    };
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
    const sf = surface ?? process.env['CMUX_SURFACE_ID'];
    if (sf) args.push('--surface', sf);
    args.push('eval', script);
    return ok(await cmux(...args));
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
    const sf = surface ?? process.env['CMUX_SURFACE_ID'];
    if (sf) args.push('--surface', sf);
    args.push('click', selector);
    return ok(await cmux(...args));
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
    const sf = surface ?? process.env['CMUX_SURFACE_ID'];
    if (sf) args.push('--surface', sf);
    args.push('fill', selector, value);
    return ok(await cmux(...args));
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
    const sf = surface ?? process.env['CMUX_SURFACE_ID'];
    if (sf) args.push('--surface', sf);
    args.push('type', selector, text);
    return ok(await cmux(...args));
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
    const sf = surface ?? process.env['CMUX_SURFACE_ID'];
    if (sf) args.push('--surface', sf);
    args.push('wait');
    if (selector) args.push('--selector', selector);
    if (text) args.push('--text', text);
    if (url_contains) args.push('--url-contains', url_contains);
    if (load_state) args.push('--load-state', load_state);
    if (timeout_ms !== undefined) args.push('--timeout-ms', String(timeout_ms));
    return ok(await cmux(...args));
  }),
);

server.tool(
  'cmux_browser_get',
  'Get data from the browser page (url, title, text, html, value, attribute, element count).',
  {
    property: z.enum(['url', 'title', 'text', 'html', 'value', 'attr', 'count', 'box', 'styles']).describe('Property to get'),
    selector: z.string().optional().describe('CSS selector (required for text/html/value/attr/count/box/styles)'),
    attribute: z.string().optional().describe('Attribute name (required for attr)'),
    surface: z.string().optional().describe('Browser surface ID/ref'),
  },
  safe(async ({ property, selector, attribute, surface }) => {
    const args = ['browser'];
    const sf = surface ?? process.env['CMUX_SURFACE_ID'];
    if (sf) args.push('--surface', sf);
    args.push('get', property);
    if (selector) args.push(selector);
    if (attribute) args.push(attribute);
    return ok(await cmux(...args));
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
    const sf = surface ?? process.env['CMUX_SURFACE_ID'];
    if (sf) args.push('--surface', sf);
    args.push('tab', action);
    if (tab_index) args.push(tab_index);
    return ok(await cmux(...args));
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
    const sf = surface ?? process.env['CMUX_SURFACE_ID'];
    if (sf) args.push('--surface', sf);
    args.push(type, action);
    return ok(await cmux(...args));
  }),
);

// ============================================================================
// J. COMPOSITE / HIGH-LEVEL TOOLS
// ============================================================================

registerBatchable(
  'cmux_launch_agents',
  `THE primary tool for launching AI agent swarms. Creates workspace, builds grid, launches CLIs, and optionally sends prompts — all in ONE call. Returns surface refs for all agents.
Pre-trusts the directory and configures each CLI for autonomous mode.
Supports: ${Object.keys(CLI_DEFS).join(', ')}.
PREFER THIS over cmux_launch_grid when you need AI agents. cmux_launch_grid creates empty panes; this tool launches actual CLIs.
INLINE ORCHESTRATION: Pass assignments (different prompt per agent), tab_names, status, and progress to do everything in one call — no follow-up calls needed.`,
  {
    cli: z.enum(['claude', 'gemini', 'codex', 'opencode', 'goose']).describe('Which AI CLI to launch'),
    count: z.number().min(1).max(12).describe('Number of agent panes'),
    cwd: z.string().optional().describe('Working directory (default: project root)'),
    workspace_name: z.string().optional().describe('Name for the new workspace'),
    prompt: z.string().optional().describe('Initial prompt to send to ALL agents after launch (ignored if assignments is set)'),
    assignments: z.array(z.string()).optional().describe('Different prompt for each agent in surface order. Overrides prompt.'),
    tab_names: z.array(z.string()).optional().describe('Rename tabs for each surface in order'),
    status: z.record(z.string(), z.string()).optional().describe('Additional sidebar status pills (key-value pairs)'),
    progress: z.number().min(0).max(1).optional().describe('Initial progress indicator (0.0 to 1.0)'),
    progress_label: z.string().optional().describe('Label for the progress indicator'),
    delay_ms: z.number().optional().describe('Delay between sending assignments in ms (default: 500)'),
  },
  async ({ cli, count, cwd, workspace_name, prompt, assignments, tab_names, status, progress, progress_label, delay_ms }) => {
    if (!await isCmuxRunning()) {
      return err('CMUX is not running. Open cmux.app first.');
    }

    const def = CLI_DEFS[cli];
    if (!def) return err(`Unknown CLI: ${cli}`);

    const workDir = cwd ?? PROJECT_ROOT ?? homedir();

    // 1. Create workspace and capture its ref
    const wsResult = await cmux('new-workspace', '--cwd', workDir);
    const wsRef = parseWorkspaceRef(wsResult);

    // 2. Rename workspace
    const name = workspace_name ?? `${def.label} x${count}`;
    try { await cmux('rename-workspace', name, ...(wsRef ? ['--workspace', wsRef] : [])); } catch { /* ignore */ }

    // 3. Build grid by splitting — pass workspace ref so splits go to the right workspace
    const cols = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / cols);
    const wsFlag = wsRef ? ['--workspace', wsRef] : [];

    // Create additional columns by splitting right from the first pane
    for (let c = 1; c < cols; c++) {
      try { await cmux('new-split', 'right', ...wsFlag); } catch { /* ignore */ }
    }

    // For each column, split down for additional rows — target each column's surface
    if (rows > 1) {
      const colSurfaces = await allSurfaceRefs(wsRef ?? undefined);
      for (let c = 0; c < colSurfaces.length; c++) {
        for (let r = 1; r < rows; r++) {
          if (r * cols + c >= count) break;
          try { await cmux('new-split', 'down', '--surface', colSurfaces[c], ...wsFlag); } catch { /* ignore */ }
        }
      }
    }

    // 4. Get final pane list using list-panels (returns ALL surfaces across ALL panes)
    const surfaceRefs = await allSurfaceRefs(wsRef ?? undefined);

    // Pre-trust directory and set up config
    ensureCliTrust(cli, workDir);
    ensureCliConfig(cli);

    // Build the CLI command
    const cliCmd = [def.bin, ...def.skipPermFlags].join(' ');
    const envPrefix = def.skipPermEnv
      ? Object.entries(def.skipPermEnv).map(([k, v]) => `${k}=${v}`).join(' ') + ' '
      : '';
    const fullCmd = envPrefix + cliCmd;

    // Send the command to each surface
    const launched: string[] = [];

    for (let i = 0; i < Math.min(surfaceRefs.length, count); i++) {
      const ref = surfaceRefs[i];
      try {
        await cmux('send', '--surface', ref, ...wsFlag, fullCmd);
        await cmux('send-key', '--surface', ref, ...wsFlag, 'enter');
        launched.push(ref);
      } catch { /* ignore individual failures */ }
    }

    // 5. Wait for CLIs to start before sending anything
    const needsWait = prompt || assignments;
    if (needsWait && launched.length > 0) {
      await new Promise(r => setTimeout(r, 3000));
    }

    // 5a. Send individual assignments (overrides prompt)
    let assignmentsSent = 0;
    if (assignments && assignments.length > 0 && launched.length > 0) {
      const assignDelay = delay_ms ?? 500;
      for (let i = 0; i < Math.min(launched.length, assignments.length); i++) {
        try {
          await cmux('send', '--surface', launched[i], ...wsFlag, assignments[i]);
          await cmux('send-key', '--surface', launched[i], ...wsFlag, 'enter');
          assignmentsSent++;
        } catch { /* ignore */ }
        if (assignDelay > 0 && i < assignments.length - 1) {
          await new Promise(r => setTimeout(r, assignDelay));
        }
      }
    } else if (prompt && launched.length > 0) {
      // 5b. Send same prompt to all (original behavior)
      for (const ref of launched) {
        try {
          await cmux('send', '--surface', ref, ...wsFlag, prompt);
          await cmux('send-key', '--surface', ref, ...wsFlag, 'enter');
        } catch { /* ignore */ }
      }
    }

    // 5c. Rename tabs if provided
    if (tab_names && tab_names.length > 0) {
      for (let i = 0; i < Math.min(launched.length, tab_names.length); i++) {
        try { await cmux('rename-tab', '--surface', launched[i], ...wsFlag, tab_names[i]); } catch { /* ignore */ }
      }
    }

    // 5d. Set progress if provided
    if (progress !== undefined) {
      try {
        const pArgs = ['set-progress', String(progress), ...wsFlag];
        if (progress_label) pArgs.push('--label', progress_label);
        await cmux(...pArgs);
      } catch { /* ignore */ }
    }

    // 6. Set sidebar status
    try {
      await cmux('set-status', ...wsFlag, 'agents', `${launched.length} ${def.label}`, '--icon', 'cpu');
    } catch { /* ignore */ }

    // 6b. Set custom status pills
    if (status) {
      for (const [key, value] of Object.entries(status)) {
        try { await cmux('set-status', ...wsFlag, key, String(value)); } catch { /* ignore */ }
      }
    }

    return ok({
      workspace: name,
      workspace_ref: wsRef,
      cli: cli,
      grid: `${cols}x${rows}`,
      launched: launched.length,
      surfaces: launched,
      command: fullCmd,
      ...(prompt && !assignments ? { prompt_sent: prompt } : {}),
      ...(assignments ? { assignments_sent: assignmentsSent } : {}),
      ...(tab_names ? { tabs_renamed: Math.min(launched.length, tab_names.length) } : {}),
    });
  }, true,
);

registerBatchable(
  'cmux_read_all',
  'Read output from ALL panes in a workspace — works on both plain terminals AND AI CLI surfaces. This is the preferred way to read agent output. For individual surface reads on plain terminals only, use cmux_read_screen.',
  {
    workspace: z.string().optional().describe('Workspace ID/ref'),
    lines: z.number().optional().describe('Lines per pane (default: 20)'),
  },
  async ({ workspace, lines: lineCount }) => {
    const numLines = lineCount ?? 20;

    // Get all surfaces across all panes using list-panels
    const surfaceRefs = await allSurfaceRefs(workspace ?? undefined);
    const results: { surface: string; output: string }[] = [];

    for (const ref of surfaceRefs) {
      try {
        const readArgs = ['read-screen', '--surface', ref, '--lines', String(numLines)];
        if (workspace) readArgs.push('--workspace', workspace);
        const output = await cmux(...readArgs);
        results.push({ surface: ref, output });
      } catch (e: any) {
        results.push({ surface: ref, output: `(error: ${e.message})` });
      }
    }

    return ok({ total: results.length, panes: results });
  }, false,
);

registerBatchable(
  'cmux_broadcast',
  'Send the same text + Enter to ALL panes in a workspace — useful for broadcasting instructions to all agents at once.',
  {
    text: z.string().describe('Text to broadcast'),
    workspace: z.string().optional().describe('Workspace ID/ref'),
  },
  async ({ text, workspace }) => {
    const surfaceRefs = await allSurfaceRefs(workspace ?? undefined);
    let sent = 0;

    for (const ref of surfaceRefs) {
      try {
        const ws = workspace ? ['--workspace', workspace] : [];
        await cmux('send-panel', '--panel', ref, ...ws, text);
        await cmux('send-key-panel', '--panel', ref, ...ws, 'enter');
        sent++;
      } catch { /* ignore */ }
    }

    return ok({ sent_to: sent, total: surfaceRefs.length, text });
  }, false,
);

server.tool(
  'cmux_workspace_snapshot',
  'Full workspace snapshot: tree + all pane output + sidebar state. Single call for complete situational awareness.',
  {
    workspace: z.string().optional().describe('Workspace ID/ref'),
    lines: z.number().optional().describe('Lines per pane (default: 20)'),
  },
  safe(async ({ workspace, lines: lineCount }) => {
    const numLines = lineCount ?? 20;

    // Tree
    let tree: string | undefined;
    try {
      const args = ['tree'];
      if (workspace) args.push('--workspace', workspace);
      tree = await cmux(...args);
    } catch { /* ignore */ }

    // Sidebar state
    let sidebar: string | undefined;
    try {
      const args = ['sidebar-state'];
      if (workspace) args.push('--workspace', workspace);
      sidebar = await cmux(...args);
    } catch { /* ignore */ }

    // Read all panes using list-panels (returns ALL surfaces across ALL panes)
    const surfaceRefs = await allSurfaceRefs(workspace ?? undefined);
    const panes: { surface: string; output: string }[] = [];

    for (const ref of surfaceRefs) {
      try {
        const readArgs = ['read-screen', '--surface', ref, '--lines', String(numLines)];
        if (workspace) readArgs.push('--workspace', workspace);
        const output = await cmux(...readArgs);
        panes.push({ surface: ref, output });
      } catch (e: any) {
        panes.push({ surface: ref, output: `(error: ${e.message})` });
      }
    }

    return ok({ tree, sidebar, total_panes: panes.length, panes });
  }),
);

// ============================================================================
// K. ADDITIONAL TOOLS (parity with wezterm-mcp)
// ============================================================================

registerBatchable(
  'cmux_launch_grid',
  `Create a workspace with an exact rows×cols grid of EMPTY terminal panes, each running an optional shell command. Returns surface refs for all panes.
NOTE: This does NOT launch AI coding CLIs. To launch Claude/Gemini/Codex agents in a grid, use cmux_launch_agents instead — it creates the grid, launches CLIs, and can send prompts, all in one call.`,
  {
    rows: z.number().min(1).max(10).describe('Number of rows'),
    cols: z.number().min(1).max(10).describe('Number of columns'),
    command: z.string().optional().describe('Command to run in each pane'),
    cwd: z.string().optional().describe('Working directory'),
    workspace_name: z.string().optional().describe('Name for the workspace'),
  },
  async ({ rows, cols, command, cwd, workspace_name }) => {
    if (!await isCmuxRunning()) return err('CMUX is not running. Open cmux.app first.');

    const workDir = cwd ?? PROJECT_ROOT ?? homedir();

    // Create workspace and capture its ref
    const wsResult = await cmux('new-workspace', '--cwd', workDir);
    const wsRef = parseWorkspaceRef(wsResult);
    const wsFlag = wsRef ? ['--workspace', wsRef] : [];

    if (workspace_name) {
      try { await cmux('rename-workspace', workspace_name, ...wsFlag); } catch { /* ignore */ }
    }

    // Build grid: split right for cols, then split each column down for rows
    for (let c = 1; c < cols; c++) {
      try { await cmux('new-split', 'right', ...wsFlag); } catch { /* ignore */ }
    }
    if (rows > 1) {
      // Get the surface refs for each column so we can target splits correctly
      const colSurfaces = await allSurfaceRefs(wsRef ?? undefined);
      for (const surface of colSurfaces) {
        for (let r = 1; r < rows; r++) {
          try { await cmux('new-split', 'down', '--surface', surface, ...wsFlag); } catch { /* ignore */ }
        }
      }
    }

    // Optionally run command in each pane
    if (command) {
      const surfaceRefs = await allSurfaceRefs(wsRef ?? undefined);
      for (const ref of surfaceRefs) {
        try {
          await cmux('send', '--surface', ref, ...wsFlag, command);
          await cmux('send-key', '--surface', ref, ...wsFlag, 'enter');
        } catch { /* ignore */ }
      }
    }

    const finalSurfaces = await allSurfaceRefs(wsRef ?? undefined);
    return ok({ grid: `${rows}x${cols}`, total: rows * cols, workspace: workspace_name, workspace_ref: wsRef, surfaces: finalSurfaces });
  }, true,
);

registerBatchable(
  'cmux_launch_mixed',
  `Launch agents with DIFFERENT CLIs in one workspace — e.g., 2 Claude + 1 Gemini + 1 Codex.
Pre-trusts directories and configures each CLI for autonomous mode.
Supports: ${Object.keys(CLI_DEFS).join(', ')}.
ORCHESTRATION: After launching, use cmux_orchestrate to assign specific tasks to each agent.`,
  {
    agents: z.array(z.object({
      cli: z.enum(['claude', 'gemini', 'codex', 'opencode', 'goose']).describe('CLI to use'),
      label: z.string().optional().describe('Optional label'),
    })).describe('List of agents to launch'),
    cwd: z.string().optional().describe('Working directory'),
    workspace_name: z.string().optional().describe('Name for the workspace'),
  },
  async ({ agents, cwd, workspace_name }) => {
    if (!await isCmuxRunning()) return err('CMUX is not running. Open cmux.app first.');

    const workDir = cwd ?? PROJECT_ROOT ?? homedir();
    const count = agents.length;

    // Create workspace and capture its ref
    const wsResult = await cmux('new-workspace', '--cwd', workDir);
    const wsRef = parseWorkspaceRef(wsResult);
    const wsFlag = wsRef ? ['--workspace', wsRef] : [];

    const name = workspace_name ?? `Mixed x${count}`;
    try { await cmux('rename-workspace', name, ...wsFlag); } catch { /* ignore */ }

    // Build grid
    const cols = Math.ceil(Math.sqrt(count));
    for (let c = 1; c < cols; c++) {
      try { await cmux('new-split', 'right', ...wsFlag); } catch { /* ignore */ }
    }
    const rows = Math.ceil(count / cols);
    if (rows > 1) {
      const colSurfaces = await allSurfaceRefs(wsRef ?? undefined);
      for (let c = 0; c < colSurfaces.length; c++) {
        for (let r = 1; r < rows; r++) {
          if (r * cols + c >= count) break;
          try { await cmux('new-split', 'down', '--surface', colSurfaces[c], ...wsFlag); } catch { /* ignore */ }
        }
      }
    }

    // Get all surfaces across all panes and launch each CLI
    const surfaceRefs = await allSurfaceRefs(wsRef ?? undefined);
    const launched: { surface: string; cli: string; label?: string }[] = [];

    for (let i = 0; i < Math.min(surfaceRefs.length, count); i++) {
      const agent = agents[i];
      const def = CLI_DEFS[agent.cli];
      if (!def) continue;

      ensureCliTrust(agent.cli, workDir);
      ensureCliConfig(agent.cli);

      const envPrefix = def.skipPermEnv
        ? Object.entries(def.skipPermEnv).map(([k, v]) => `${k}=${v}`).join(' ') + ' '
        : '';
      const fullCmd = envPrefix + [def.bin, ...def.skipPermFlags].join(' ');

      try {
        await cmux('send', '--surface', surfaceRefs[i], ...wsFlag, fullCmd);
        await cmux('send-key', '--surface', surfaceRefs[i], ...wsFlag, 'enter');
        launched.push({ surface: surfaceRefs[i], cli: agent.cli, label: agent.label });
      } catch { /* ignore */ }
    }

    return ok({ workspace: name, launched });
  }, true,
);

server.tool(
  'cmux_send_submit_some',
  'Send the same text + Enter to SPECIFIC surfaces (not all). Target by surface refs — useful when only some agents need the same instruction.',
  {
    surface_refs: z.array(z.string()).describe('List of surface refs to target (e.g., ["surface:8", "surface:10"])'),
    text: z.string().describe('Text to send and submit'),
    workspace: z.string().optional().describe('Workspace ref'),
  },
  safe(async ({ surface_refs, text, workspace }) => {
    let sent = 0;
    for (const ref of surface_refs) {
      try {
        const ws = workspace ? ['--workspace', workspace] : [];
        await cmux('send-panel', '--panel', ref, ...ws, text);
        await cmux('send-key-panel', '--panel', ref, ...ws, 'enter');
        sent++;
      } catch { /* ignore */ }
    }
    return ok({ sent_to: sent, total: surface_refs.length, text });
  }),
);

server.tool(
  'cmux_send_key_all',
  'Send a key (e.g., ctrl+c, escape) to ALL panes in a workspace. Useful for cancelling all agents.',
  {
    key: z.string().describe('Key to send (e.g., ctrl+c, escape, enter)'),
    workspace: z.string().optional().describe('Workspace ref'),
  },
  safe(async ({ key, workspace }) => {
    const surfaceRefs = await allSurfaceRefs(workspace ?? undefined);
    let sent = 0;
    const text = keyToText(key);

    for (const ref of surfaceRefs) {
      try {
        const ws = workspace ? ['--workspace', workspace] : [];
        if (text) {
          // Use send-panel (works on ALL surfaces regardless of focus)
          await cmux('send-panel', '--panel', ref, ...ws, text);
        } else {
          // Fallback for unmapped keys: send-key-panel (focus-dependent)
          await cmux('send-key-panel', '--panel', ref, ...ws, key);
        }
        sent++;
      } catch { /* ignore */ }
    }

    return ok({ sent_to: sent, total: surfaceRefs.length, key });
  }),
);

registerBatchable(
  'cmux_send_each',
  'Send DIFFERENT text to each pane in a workspace — useful for distributing tasks after cmux_launch_agents. Texts array maps to panes in surface order.',
  {
    texts: z.array(z.string()).describe('Array of texts, one per pane (in surface order)'),
    workspace: z.string().optional().describe('Workspace ref'),
  },
  async ({ texts, workspace }) => {
    const surfaceRefs = await allSurfaceRefs(workspace ?? undefined);
    let sent = 0;

    for (let i = 0; i < Math.min(surfaceRefs.length, texts.length); i++) {
      try {
        const ws = workspace ? ['--workspace', workspace] : [];
        await cmux('send-panel', '--panel', surfaceRefs[i], ...ws, texts[i]);
        await cmux('send-key-panel', '--panel', surfaceRefs[i], ...ws, 'enter');
        sent++;
      } catch { /* ignore */ }
    }

    return ok({ sent_to: sent, total: surfaceRefs.length });
  }, false,
);

server.tool(
  'cmux_read_all_deep',
  `Deep read of ALL panes. For idle CLI agents, prompts them asking "what have you done?" and returns their summary. For busy agents, reads passively (last N lines). This is slower but gives a real briefing from each agent.`,
  {
    workspace: z.string().optional().describe('Workspace ref'),
    lines: z.number().optional().describe('Lines for non-queryable panes (default: 20)'),
    query: z.string().optional().describe('Question to ask idle agents (default: "Briefly summarize what you have done and your current status.")'),
  },
  safe(async ({ workspace, lines: lineCount, query }) => {
    const numLines = lineCount ?? 20;
    const prompt = query ?? 'Briefly summarize what you have done and your current status.';

    const surfaceRefs = await allSurfaceRefs(workspace ?? undefined);
    const results: { surface: string; output: string; queried: boolean }[] = [];

    for (const ref of surfaceRefs) {
      try {
        const ws = workspace ? ['--workspace', workspace] : [];
        // Read current screen to detect state
        const screen = await cmux('read-screen', '--surface', ref, ...ws, '--lines', '5');

        // Simple heuristic: if screen ends with a prompt char (>, $, %), agent is idle
        const lastLine = screen.trim().split('\n').pop() ?? '';
        const isIdle = /[>$%❯]\s*$/.test(lastLine) || /\?\s*$/.test(lastLine);

        if (isIdle) {
          // Send the query and wait for response
          await cmux('send', '--surface', ref, ...ws, prompt);
          await cmux('send-key', '--surface', ref, ...ws, 'enter');
          // Wait for agent to respond
          await new Promise(r => setTimeout(r, 5000));
          const output = await cmux('read-screen', '--surface', ref, ...ws, '--lines', String(numLines));
          results.push({ surface: ref, output, queried: true });
        } else {
          // Busy — read passively
          const output = await cmux('read-screen', '--surface', ref, ...ws, '--lines', String(numLines));
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
    if (await isCmuxRunning()) {
      return ok({ already_running: true });
    }

    const workDir = cwd ?? PROJECT_ROOT ?? homedir();
    try {
      execSync(`open -a cmux "${workDir}"`, { timeout: 10_000 });
      // Wait for it to start
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 1000));
        if (await isCmuxRunning()) {
          return ok({ started: true, cwd: workDir });
        }
      }
      return ok({ started: false, note: 'CMUX opened but socket not ready yet. Try again in a moment.' });
    } catch (e: any) {
      return err(`Failed to start CMUX: ${e.message}`);
    }
  }),
);

server.tool(
  'cmux_close_all',
  'Close ALL workspaces (or all except specific ones). Use `except` to keep certain workspaces open — e.g., keep your own workspace while closing all test workspaces.',
  {
    except: z.array(z.string()).optional().describe('Workspace refs to keep open (e.g., ["workspace:1"])'),
  },
  safeMut(async ({ except }) => {
    // List all workspaces and close each (except excluded ones)
    let wsList: string;
    try { wsList = await cmux('list-workspaces'); } catch { return ok({ closed: 0 }); }

    const wsRefs = wsList.match(/workspace:\d+/g) ?? [];
    const excludeSet = new Set(except ?? []);
    let closed = 0;
    const skipped: string[] = [];

    for (const ref of wsRefs) {
      if (excludeSet.has(ref)) { skipped.push(ref); continue; }
      try {
        await cmux('close-workspace', '--workspace', ref);
        closed++;
      } catch { /* ignore */ }
    }

    return ok({ closed, total: wsRefs.length, skipped: skipped.length > 0 ? skipped : undefined });
  }),
);

server.tool(
  'cmux_screenshot',
  'Take a screenshot of the CMUX window using macOS screencapture.',
  {
    output_path: z.string().optional().describe('Output file path (default: /tmp/cmux-screenshot-<timestamp>.png)'),
  },
  safe(async ({ output_path }) => {
    const ts = Date.now();
    const outPath = output_path ?? `/tmp/cmux-screenshot-${ts}.png`;
    // Try to get the cmux window ID for a targeted capture
    let captured = false;
    try {
      // Use Python to query CGWindowListCopyWindowInfo for the cmux window ID
      const windowId = execSync(
        `python3 -c "
import Quartz
wl = Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionOnScreenOnly, Quartz.kCGNullWindowID)
for w in wl:
    if w.get('kCGWindowOwnerName','') == 'cmux':
        print(w['kCGWindowNumber']); break
"`,
        { timeout: 5_000, encoding: 'utf8' },
      ).trim();
      if (windowId && /^\d+$/.test(windowId)) {
        execSync(`screencapture -l ${windowId} -x "${outPath}"`, { timeout: 10_000 });
        captured = true;
      }
    } catch { /* fall through to full-screen capture */ }
    if (!captured) {
      // Fallback: capture entire screen non-interactively (-x = no sound)
      execSync(`screencapture -x "${outPath}"`, { timeout: 10_000 });
    }
    return ok({ screenshot: outPath, ...(captured ? {} : { note: 'Captured full screen (could not isolate cmux window)' }) });
  }),
);

registerBatchable(
  'cmux_open_cli',
  `Open a single AI coding CLI in a new workspace or a new split in an existing workspace.
Pre-trusts the directory and sets up config so the CLI starts without permission prompts.
Supports: claude, gemini, codex, opencode, goose.`,
  {
    cli: z.enum(['claude', 'gemini', 'codex', 'opencode', 'goose']).describe('Which AI CLI to launch'),
    cwd: z.string().optional().describe('Working directory (default: project root)'),
    workspace: z.string().optional().describe('Existing workspace ref to add a split to (omit to create new workspace)'),
    direction: z.enum(['left', 'right', 'up', 'down']).optional().describe('Split direction if adding to existing workspace'),
    workspace_name: z.string().optional().describe('Name for new workspace (only when creating new)'),
    prompt: z.string().optional().describe('Initial prompt to send after CLI starts'),
  },
  async ({ cli, cwd, workspace, direction, workspace_name, prompt }) => {
    if (!await isCmuxRunning()) return err('CMUX is not running. Open cmux.app first.');

    const def = CLI_DEFS[cli];
    if (!def) return err(`Unknown CLI: ${cli}`);

    const workDir = cwd ?? PROJECT_ROOT ?? homedir();

    // Pre-trust and configure
    ensureCliTrust(cli, workDir);
    ensureCliConfig(cli);

    const envPrefix = def.skipPermEnv
      ? Object.entries(def.skipPermEnv).map(([k, v]) => `${k}=${v}`).join(' ') + ' '
      : '';
    const fullCmd = envPrefix + [def.bin, ...def.skipPermFlags].join(' ');

    let surfRef: string;
    let wsFlag: string[] = [];

    if (workspace) {
      // Add to existing workspace as a split
      const dir = direction ?? 'right';
      await cmux('new-split', dir, '--workspace', workspace);
      const refs = await allSurfaceRefs(workspace);
      surfRef = refs[refs.length - 1] ?? 'surface:?';
      wsFlag = ['--workspace', workspace];
    } else {
      // Create new workspace and capture its ref
      const wsResult = await cmux('new-workspace', '--cwd', workDir);
      const wsRef = parseWorkspaceRef(wsResult);
      wsFlag = wsRef ? ['--workspace', wsRef] : [];
      const name = workspace_name ?? def.label;
      try { await cmux('rename-workspace', name, ...wsFlag); } catch { /* ignore */ }
      const refs = await allSurfaceRefs(wsRef ?? undefined);
      surfRef = refs[refs.length - 1] ?? 'surface:?';
    }

    // Launch the CLI
    await cmux('send', '--surface', surfRef, ...wsFlag, fullCmd);
    await cmux('send-key', '--surface', surfRef, ...wsFlag, 'enter');

    // Set sidebar status
    try {
      await cmux('set-status', ...wsFlag, 'cli', def.label, '--icon', 'cpu');
    } catch { /* ignore */ }

    // Optionally send initial prompt
    if (prompt) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        await cmux('send', '--surface', surfRef, ...wsFlag, prompt);
        await cmux('send-key', '--surface', surfRef, ...wsFlag, 'enter');
      } catch { /* ignore */ }
    }

    return ok({
      cli,
      surface: surfRef,
      command: fullCmd,
      cwd: workDir,
      ...(prompt ? { prompt_sent: prompt } : {}),
    });
  }, true,
);

registerBatchable(
  'cmux_orchestrate',
  `Send different prompts/plans to specific surfaces in one call — the core orchestration tool.
Use this after cmux_launch_agents or cmux_launch_mixed to distribute work to each agent.
Example: launch 4 Claude agents, then orchestrate by sending each agent its specific task.`,
  {
    assignments: z.array(z.object({
      surface: z.string().describe('Surface ref (e.g., "surface:8")'),
      text: z.string().describe('Prompt/plan to send to this agent'),
    })).describe('List of surface + prompt assignments'),
    workspace: z.string().optional().describe('Workspace ref (optional)'),
    delay_ms: z.number().optional().describe('Delay between sends in ms (default: 500)'),
  },
  async ({ assignments, workspace, delay_ms }) => {
    const delay = delay_ms ?? 500;
    const results: { surface: string; sent: boolean; error?: string }[] = [];

    for (const assignment of assignments) {
      try {
        const resolved = await resolvePanelRef(assignment.surface, workspace);
        const ws = workspace ? ['--workspace', workspace] : [];
        // Use send/send-key (like launch_agents) — works on both terminal and AI CLI surfaces
        await cmux('send', '--surface', resolved, ...ws, assignment.text);
        await cmux('send-key', '--surface', resolved, ...ws, 'enter');
        results.push({ surface: assignment.surface, sent: true });
      } catch (e: any) {
        results.push({ surface: assignment.surface, sent: false, error: e.message });
      }
      if (delay > 0) await new Promise(r => setTimeout(r, delay));
    }

    const sent = results.filter(r => r.sent).length;
    return ok({
      total: assignments.length,
      sent,
      failed: assignments.length - sent,
      results,
    });
  }, false,
);

// ============================================================================
// K2. BATCH EXECUTION
// ============================================================================

server.tool(
  'cmux_batch',
  `Execute multiple CMUX operations in a single MCP call. Each step references an existing cmux tool by name and provides its parameters. Steps run sequentially. Later steps can reference outputs from earlier steps using $steps[N].path.to.field syntax in string parameter values.

Example: Launch agents, set progress, and orchestrate — all in one call instead of 8+ separate tool calls.

Variable substitution: In any string param value, use $steps[0].surfaces[2] to reference the 3rd surface from step 0's output. If the entire value is a single $steps ref, the raw value is returned (preserving arrays/numbers). Embedded refs in larger strings are interpolated as strings.

Error handling: By default, stops on first error. Set continue_on_error: true to skip failures and continue.`,
  {
    steps: z.array(z.object({
      tool: z.string().describe('Tool name (e.g., "cmux_launch_agents", "cmux_set_status")'),
      params: z.record(z.string(), z.unknown()).describe('Parameters for the tool. String values may contain $steps[N].path refs.'),
      label: z.string().optional().describe('Optional human-readable label for this step'),
    })).min(1).max(30).describe('Ordered list of operations to execute'),
    continue_on_error: z.boolean().optional().describe('If true, continue executing steps after a failure (default: false)'),
  },
  safeMut(async ({ steps, continue_on_error }: { steps: { tool: string; params: Record<string, unknown>; label?: string }[]; continue_on_error?: boolean }) => {
    if (!await isCmuxRunning()) return err('CMUX is not running.');

    const outputs: unknown[] = [];
    const results: { step: number; label?: string; tool: string; ok: boolean; output?: unknown; error?: string }[] = [];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const entry = toolRegistry.get(step.tool);
      if (!entry) {
        const msg = `Unknown or non-batchable tool: ${step.tool}. Batchable tools: ${[...toolRegistry.keys()].join(', ')}`;
        results.push({ step: i, label: step.label, tool: step.tool, ok: false, error: msg });
        outputs.push(undefined);
        if (!continue_on_error) return ok({ completed: i, total: steps.length, results, stopped_at: i, error: msg });
        continue;
      }

      const resolvedParams = resolveAllVars(step.params, outputs) as Record<string, unknown>;

      try {
        const rawResult = await entry.handler(resolvedParams);
        const output = unwrapOk(rawResult);
        outputs.push(output);
        results.push({ step: i, label: step.label, tool: step.tool, ok: true, output });
      } catch (e: any) {
        const msg = e.message ?? String(e);
        results.push({ step: i, label: step.label, tool: step.tool, ok: false, error: msg });
        outputs.push(undefined);
        if (!continue_on_error) return ok({ completed: i, total: steps.length, results, stopped_at: i, error: msg });
      }
    }

    return ok({
      completed: results.filter(r => r.ok).length,
      total: steps.length,
      results,
    });
  }),
);

// ============================================================================
// L. SESSION MANAGEMENT — save, recover, reconcile
// ============================================================================

server.tool(
  'cmux_session_save',
  'Save current CMUX state (workspaces, panes, CLIs, session IDs) to a manifest for crash recovery. Call this after launching agents or making changes you want to be recoverable.',
  {},
  safe(async () => {
    if (!await isCmuxRunning()) {
      return ok({ error: 'CMUX is not running. Nothing to save.' });
    }

    const manifest = await captureManifest();
    saveManifest(manifest);

    const totalSurfaces = manifest.workspaces.reduce((sum, w) => sum + w.surfaces.length, 0);
    const withSession = manifest.workspaces.reduce(
      (sum, w) => sum + w.surfaces.filter(s => s.session_id !== null).length, 0);

    return ok({
      saved: true,
      path: MANIFEST_PATH,
      workspaces: manifest.workspaces.length,
      surfaces: totalSurfaces,
      sessions_captured: withSession,
      sessions_missing: totalSurfaces - withSession,
      note: withSession < totalSurfaces
        ? `${totalSurfaces - withSession} surface(s) have no session ID yet (they may be plain shells). Save again in a few seconds if CLIs are still starting.`
        : 'All session IDs captured. Full recovery is possible — CLI conversations can be resumed.',
    });
  }),
);

server.tool(
  'cmux_session_recover',
  `Recover a crashed CMUX session from the saved manifest. Recreates all workspaces, panes, and RESUMES each CLI's conversation session.
For example, if Claude Code was running with a long conversation, this will reopen Claude Code and resume that exact conversation using --resume <session_id>.
Supports session resume for: Claude Code (--resume/--continue), Gemini CLI (--resume latest), Codex (codex resume), OpenCode (--session/--continue), Goose (session --resume).`,
  {
    manifest_path: z.string().optional().describe('Path to manifest file (default: auto)'),
  },
  safeMut(async ({ manifest_path }) => {
    const path = manifest_path ?? MANIFEST_PATH;
    let manifest: SessionManifest | null;
    try {
      manifest = JSON.parse(readFileSync(path, 'utf8')) as SessionManifest;
    } catch {
      manifest = null;
    }
    // Fall back to autosave if no explicit manifest (or custom path) found
    if (!manifest && !manifest_path) {
      manifest = loadAutoSave();
    }

    if (!manifest) {
      return ok({
        error: 'No session manifest found.',
        path,
        note: 'Use cmux_session_save to create one while agents are running.',
      });
    }

    // Start CMUX if needed
    if (!await isCmuxRunning()) {
      try {
        execSync('open -a cmux', { timeout: 10_000 });
        // Wait for socket
        for (let i = 0; i < 15; i++) {
          await new Promise(r => setTimeout(r, 1000));
          if (await isCmuxRunning()) break;
        }
      } catch { /* ignore */ }

      if (!await isCmuxRunning()) {
        return ok({ error: 'CMUX could not be started.' });
      }
    }

    type RecoveredSurface = { cli: string; session_id: string | null; surface_ref: string; resumed: boolean };
    type RecoveredWorkspace = { name: string; surfaces: RecoveredSurface[] };
    const recoveredWorkspaces: RecoveredWorkspace[] = [];

    for (const mw of manifest.workspaces) {
      if (mw.surfaces.length === 0) continue;

      const recoveredSurfaces: RecoveredSurface[] = [];

      // Create a new workspace
      const firstSurface = mw.surfaces[0]!;
      const firstCwd = firstSurface.cwd || manifest.project_root;

      // Build resume command for first surface
      const firstCmd = buildResumeCommand(firstSurface.cli, firstSurface.session_id, firstCwd);
      const recoverWsResult = await cmux('new-workspace', '--cwd', firstCwd, '--command', firstCmd);
      const recoverWsRef = parseWorkspaceRef(recoverWsResult);
      const recoverWsFlag = recoverWsRef ? ['--workspace', recoverWsRef] : [];

      // Rename workspace
      try { await cmux('rename-workspace', mw.name, ...recoverWsFlag); } catch { /* ignore */ }

      // Get the surface ref of the first pane we just created
      const firstRefs = await allSurfaceRefs(recoverWsRef ?? undefined);
      const firstRef = firstRefs[firstRefs.length - 1] ?? 'surface:?';

      recoveredSurfaces.push({
        cli: firstSurface.cli,
        session_id: firstSurface.session_id,
        surface_ref: firstRef,
        resumed: firstSurface.session_id !== null,
      });

      // Create remaining surfaces as splits
      for (let i = 1; i < mw.surfaces.length; i++) {
        const surf = mw.surfaces[i]!;
        const surfCwd = surf.cwd || manifest.project_root;
        const cmd = buildResumeCommand(surf.cli, surf.session_id, surfCwd);

        // Alternate split direction for grid layout
        const dir = i % 2 === 1 ? 'right' : 'down';
        try {
          await cmux('new-split', dir, ...recoverWsFlag);
          // Small delay between spawns
          await new Promise(r => setTimeout(r, 500));

          // Get the new surface ref
          const newRefs = await allSurfaceRefs(recoverWsRef ?? undefined);
          const newRef = newRefs[newRefs.length - 1] ?? `surface:?`;

          // Send the resume command to the new split
          await cmux('send', '--surface', newRef, ...recoverWsFlag, cmd);
          await cmux('send-key', '--surface', newRef, ...recoverWsFlag, 'enter');

          recoveredSurfaces.push({
            cli: surf.cli,
            session_id: surf.session_id,
            surface_ref: newRef,
            resumed: surf.session_id !== null,
          });
        } catch { /* ignore individual failures */ }
      }

      recoveredWorkspaces.push({ name: mw.name, surfaces: recoveredSurfaces });
    }

    const allSurfaces = recoveredWorkspaces.flatMap(w => w.surfaces);
    const totalSurfaces = allSurfaces.length;
    const withSession = allSurfaces.filter(s => s.resumed).length;

    return ok({
      recovered: true,
      from_manifest: manifest.saved_at,
      workspaces: recoveredWorkspaces.length,
      surfaces: totalSurfaces,
      resumed_with_session: withSession,
      resumed_fresh: totalSurfaces - withSession,
      details: recoveredWorkspaces,
      note: `Recovered ${totalSurfaces} surface(s) across ${recoveredWorkspaces.length} workspace(s). ${withSession} resumed specific CLI conversations, ${totalSurfaces - withSession} started fresh.`,
    });
  }),
);

server.tool(
  'cmux_session_reconcile',
  'Compare saved session manifest against what is actually running in CMUX. Reports drift: surfaces that disappeared, new ones that appeared, CLI state changes.',
  {},
  safe(async () => {
    if (!await isCmuxRunning()) {
      return ok({ error: 'CMUX is not running.' });
    }

    const manifest = loadManifest();

    // Capture current live state
    const live = await captureManifest();
    const liveSurfaces = live.workspaces.flatMap(w =>
      w.surfaces.map(s => ({ workspace: w.name, ...s }))
    );

    if (!manifest) {
      return ok({
        has_manifest: false,
        live_surfaces: liveSurfaces.length,
        note: 'No saved manifest. Call cmux_session_save to create one.',
        live: liveSurfaces,
      });
    }

    const manifestSurfaces = manifest.workspaces.flatMap(w =>
      w.surfaces.map(s => ({ workspace: w.name, ...s }))
    );

    // Compare by surface_ref (unique per surface) for accurate drift detection
    const manifestRefs = new Set(manifestSurfaces.map(s => s.surface_ref));
    const liveRefs = new Set(liveSurfaces.map(s => s.surface_ref));

    const disappeared = manifestSurfaces.filter(ms => !liveRefs.has(ms.surface_ref));
    const appeared = liveSurfaces.filter(ls => !manifestRefs.has(ls.surface_ref));

    const sessionChanges: { workspace: string; cli: string; surface_ref: string; old_session: string | null; new_session: string | null }[] = [];
    for (const ms of manifestSurfaces) {
      const matching = liveSurfaces.find(ls => ls.surface_ref === ms.surface_ref);
      if (matching && ms.session_id && matching.session_id && ms.session_id !== matching.session_id) {
        sessionChanges.push({
          workspace: ms.workspace,
          cli: ms.cli,
          surface_ref: ms.surface_ref,
          old_session: ms.session_id,
          new_session: matching.session_id,
        });
      }
    }

    const inSync = disappeared.length === 0 && appeared.length === 0 && sessionChanges.length === 0;

    return ok({
      has_manifest: true,
      manifest_saved_at: manifest.saved_at,
      in_sync: inSync,
      manifest_surfaces: manifestSurfaces.length,
      live_surfaces: liveSurfaces.length,
      disappeared: disappeared.length > 0 ? disappeared : undefined,
      appeared: appeared.length > 0 ? appeared : undefined,
      session_changes: sessionChanges.length > 0 ? sessionChanges : undefined,
      note: inSync
        ? 'Everything matches. Manifest and live state are in sync.'
        : `Drift detected: ${disappeared.length} disappeared, ${appeared.length} new, ${sessionChanges.length} session changes.`,
    });
  }),
);

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

export async function runServer(): Promise<void> {
  // Initialize persistent socket connection to CMUX
  try {
    await initTransport();
  } catch (e: any) {
    process.stderr.write(`[cmux-agent-mcp] Socket init failed: ${e.message}\n`);
    // Server still starts — CLI-only commands will work, socket commands will fail with clear errors
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
