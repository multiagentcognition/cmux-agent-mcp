import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export type InitOptions = { projectRoot?: string };
export type InitResult = { mode: 'global' | 'project'; updatedFiles: string[]; projectRoot?: string };

function readJsonFile<T>(filePath: string): T | undefined {
  if (!existsSync(filePath)) return undefined;
  const raw = readFileSync(filePath, 'utf8').trim();
  return raw ? JSON.parse(raw) as T : undefined;
}

function writeJsonIfChanged(filePath: string, nextValue: Record<string, unknown>, existing: Record<string, unknown>, updatedFiles: string[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  if (JSON.stringify(existing) !== JSON.stringify(nextValue)) {
    writeFileSync(filePath, `${JSON.stringify(nextValue, null, 2)}\n`, 'utf8');
    updatedFiles.push(filePath);
  }
}

function globalEntry(): Record<string, unknown> { return { command: 'cmux-swarm', args: [] }; }
function projectEntry(projectRoot: string): Record<string, unknown> { return { command: 'cmux-swarm', args: [], env: { CMUX_PROJECT_ROOT: projectRoot } }; }

function home(): string {
  const sudoUser = process.env['SUDO_USER'];
  if (sudoUser && process.getuid?.() === 0) {
    try { return execSync(`eval echo ~${sudoUser}`, { encoding: 'utf8', timeout: 3000 }).trim(); } catch { /* fall through */ }
  }
  return homedir();
}

function globalVsCodeMcpPath(): string { return join(home(), 'Library', 'Application Support', 'Code', 'User', 'mcp.json'); }
function globalOpenCodePath(): string { return join(process.env['XDG_CONFIG_HOME'] ?? join(home(), '.config'), 'opencode', 'opencode.json'); }

function writeMcpServersFile(filePath: string, entry: Record<string, unknown>, updatedFiles: string[]): void {
  const existing = readJsonFile<Record<string, unknown>>(filePath) ?? {};
  const existingServers = (existing['mcpServers'] ?? {}) as Record<string, unknown>;
  const nextValue = { ...existing, mcpServers: { ...existingServers, 'cmux-swarm': entry } };
  writeJsonIfChanged(filePath, nextValue, existing, updatedFiles);
}

export function initGlobal(): InitResult { return { mode: 'global', updatedFiles: [] }; }
export function initProject(_options: InitOptions = {}): InitResult { return { mode: 'project', updatedFiles: [] }; }
