/**
 * CMUX MCP Server
 *
 * Exposes CMUX's terminal multiplexer as MCP tools.
 * Agents can create workspaces, spawn panes, inject prompts, read output,
 * manage layouts, control the sidebar, send notifications, and automate
 * the built-in browser without knowing the CLI syntax.
 */

import { execFileSync, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({ name: 'cmux-swarm', version: '0.1.0' });

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

export async function runServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
