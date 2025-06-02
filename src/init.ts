import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

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

export function initGlobal(): InitResult {
  return { mode: 'global', updatedFiles: [] };
}

export function initProject(_options: InitOptions = {}): InitResult {
  return { mode: 'project', updatedFiles: [] };
}
