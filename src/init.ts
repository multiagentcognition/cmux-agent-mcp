import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

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
    command: 'cmux-swarm',
    args: [],
  };
}

function projectEntry(projectRoot: string): Record<string, unknown> {
  return {
    command: 'cmux-swarm',
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

export function initGlobal(): InitResult {
  return { mode: 'global', updatedFiles: [] };
}

export function initProject(_options: InitOptions = {}): InitResult {
  return { mode: 'project', updatedFiles: [] };
}
