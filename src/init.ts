import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InitOptions = {
  projectRoot?: string;
};

export type InitResult = {
  mode: 'global' | 'project';
  updatedFiles: string[];
  projectRoot?: string;
};

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

function readJsonFile<T>(filePath: string): T | undefined {
  if (!existsSync(filePath)) {
    return undefined;
  }
  const raw = readFileSync(filePath, 'utf8').trim();
  return raw ? JSON.parse(raw) as T : undefined;
}

function writeJsonIfChanged(
  filePath: string,
  nextValue: Record<string, unknown>,
  existing: Record<string, unknown>,
  updatedFiles: string[],
): void {
  mkdirSync(dirname(filePath), { recursive: true });
  if (JSON.stringify(existing) !== JSON.stringify(nextValue)) {
    writeFileSync(filePath, `${JSON.stringify(nextValue, null, 2)}\n`, 'utf8');
    updatedFiles.push(filePath);
  }
}

// ---------------------------------------------------------------------------
// Server entry builders
// ---------------------------------------------------------------------------

function globalEntry(): Record<string, unknown> {
  return {
    command: 'cmux-mcp',
    args: [],
  };
}

function projectEntry(projectRoot: string): Record<string, unknown> {
  return {
    command: 'cmux-mcp',
    args: [],
    env: { CMUX_PROJECT_ROOT: projectRoot },
  };
}

// ---------------------------------------------------------------------------
// Global config paths (macOS only)
// ---------------------------------------------------------------------------

function home(): string {
  const sudoUser = process.env['SUDO_USER'];
  if (sudoUser && process.getuid?.() === 0) {
    try {
      return execSync(`eval echo ~${sudoUser}`, { encoding: 'utf8', timeout: 3000 }).trim();
    } catch { /* fall through */ }
  }
  return homedir();
}

function globalVsCodeMcpPath(): string {
  return join(home(), 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
}

function globalOpenCodePath(): string {
  return join(process.env['XDG_CONFIG_HOME'] ?? join(home(), '.config'), 'opencode', 'opencode.json');
}

// ---------------------------------------------------------------------------
// Shared writers
// ---------------------------------------------------------------------------

function writeMcpServersFile(filePath: string, entry: Record<string, unknown>, updatedFiles: string[]): void {
  const existing = readJsonFile<Record<string, unknown>>(filePath) ?? {};
  const existingServers = (existing['mcpServers'] ?? {}) as Record<string, unknown>;
  const nextValue = {
    ...existing,
    mcpServers: { ...existingServers, 'cmux-mcp': entry },
  };
  writeJsonIfChanged(filePath, nextValue, existing, updatedFiles);
}

function writeVsCodeFile(filePath: string, entry: Record<string, unknown>, updatedFiles: string[]): void {
  const existing = readJsonFile<Record<string, unknown>>(filePath) ?? {};
  const existingServers = (existing['servers'] ?? {}) as Record<string, unknown>;
  const nextValue = {
    ...existing,
    servers: {
      ...existingServers,
      'cmux-mcp': { type: 'stdio', ...entry },
    },
  };
  writeJsonIfChanged(filePath, nextValue, existing, updatedFiles);
}

function writeOpenCodeFile(filePath: string, entry: Record<string, unknown>, updatedFiles: string[]): void {
  const existing = readJsonFile<Record<string, unknown>>(filePath) ?? {};
  const existingMcp = (existing['mcp'] ?? {}) as Record<string, unknown>;
  const nextValue = {
    ...existing,
    mcp: {
      ...existingMcp,
      'cmux-mcp': {
        type: 'local',
        command: [String(entry.command), ...((entry.args ?? []) as string[])],
        enabled: true,
        ...(entry.env ? { environment: entry.env as Record<string, string> } : {}),
      },
    },
  };
  writeJsonIfChanged(filePath, nextValue, existing, updatedFiles);
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

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

function preflight(): void {
  if (!isCmuxInstalled()) {
    console.error(`Error: cmux is not installed.

Install cmux first:
  brew tap manaflow-ai/cmux && brew install --cask cmux
  or download from https://cmux.dev`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function initGlobal(): InitResult {
  preflight();

  const entry = globalEntry();
  const updatedFiles: string[] = [];

  // Claude Code — ~/.claude.json
  writeMcpServersFile(join(home(), '.claude.json'), entry, updatedFiles);

  // Cursor — ~/.cursor/mcp.json
  writeMcpServersFile(join(home(), '.cursor', 'mcp.json'), entry, updatedFiles);

  // VS Code — macOS path
  writeVsCodeFile(globalVsCodeMcpPath(), entry, updatedFiles);

  // Gemini CLI — ~/.gemini/settings.json
  writeMcpServersFile(join(home(), '.gemini', 'settings.json'), entry, updatedFiles);

  // OpenCode
  writeOpenCodeFile(globalOpenCodePath(), entry, updatedFiles);

  return { mode: 'global', updatedFiles };
}

export function initProject(options: InitOptions = {}): InitResult {
  preflight();

  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const entry = projectEntry(projectRoot);
  const updatedFiles: string[] = [];

  // .mcp.json — Claude Code, Codex
  writeMcpServersFile(resolve(projectRoot, '.mcp.json'), entry, updatedFiles);

  // .cursor/mcp.json — Cursor
  writeMcpServersFile(resolve(projectRoot, '.cursor', 'mcp.json'), entry, updatedFiles);

  // .vscode/mcp.json — VS Code
  writeVsCodeFile(resolve(projectRoot, '.vscode', 'mcp.json'), entry, updatedFiles);

  // .gemini/settings.json — Gemini CLI
  writeMcpServersFile(resolve(projectRoot, '.gemini', 'settings.json'), entry, updatedFiles);

  // opencode.json — OpenCode
  writeOpenCodeFile(resolve(projectRoot, 'opencode.json'), entry, updatedFiles);

  return { mode: 'project', updatedFiles, projectRoot };
}
