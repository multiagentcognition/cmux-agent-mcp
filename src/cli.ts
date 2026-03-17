#!/usr/bin/env node

import { parseArgs } from 'node:util';

import { initGlobal, initProject } from './init.js';
import { runServer } from './cmux-mcp.js';

function printHelp(): void {
  console.log(`cmux-mcp — terminal control plane for multi-agent AI workflows via CMUX

Usage:
  cmux-mcp init [options]
  cmux-mcp [server options]
  cmux-mcp help

Commands:
  init      Register cmux-mcp with all AI coding tools
  help      Show this help

When no command is given, the stdio MCP server starts (default behavior).

Examples:
  npx cmux-mcp init              # global setup (all projects)
  npx cmux-mcp init --project    # per-project setup (current dir)
  npx cmux-mcp
`);
}

function runInitCli(args: string[]): void {
  const parsed = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h' },
      project: { type: 'boolean' },
      root: { type: 'string' },
    },
    allowPositionals: false,
    strict: true,
  });

  if (parsed.values.help) {
    console.log(`Register cmux-mcp with all AI coding tools

Usage:
  cmux-mcp init [options]

Options:
  --project      Per-project mode (write config into project directory)
  --root <path>  Project root directory (implies --project, default: cwd)
  -h, --help     Show help

Default (no flags) registers globally for all projects:
  ~/.claude.json               Claude Code, Codex
  ~/.cursor/mcp.json           Cursor
  VS Code user mcp.json        VS Code (macOS path)
  ~/.gemini/settings.json      Gemini CLI
  ~/.config/opencode/...       OpenCode

With --project, writes per-project config files:
  .mcp.json                    Claude Code, Codex
  .cursor/mcp.json             Cursor
  .vscode/mcp.json             VS Code
  .gemini/settings.json        Gemini CLI
  opencode.json                OpenCode
`);
    return;
  }

  const isProjectMode = parsed.values.project === true || parsed.values.root !== undefined;

  const result = isProjectMode
    ? initProject({ projectRoot: parsed.values.root })
    : initGlobal();

  if (result.updatedFiles.length === 0) {
    console.log(`cmux-mcp already configured — no changes needed.`);
    return;
  }

  const header = result.mode === 'global'
    ? 'cmux-mcp registered globally for all projects'
    : `cmux-mcp configured for ${result.projectRoot}`;

  console.log(`${header}

Updated:
${result.updatedFiles.map((f) => `  ${f}`).join('\n')}
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (command === 'init') {
    runInitCli(args.slice(1));
    return;
  }

  await runServer();
}

main().catch((err) => {
  console.error('cmux-mcp failed:', err);
  process.exit(1);
});
