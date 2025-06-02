#!/usr/bin/env node

import { parseArgs } from 'node:util';

import { initGlobal, initProject } from './init.js';
import { runServer } from './cmux-mcp.js';

function printHelp(): void {
  console.log(`cmux-swarm — terminal control plane for multi-agent AI workflows via CMUX

Usage:
  cmux-swarm init [options]
  cmux-swarm [server options]
  cmux-swarm help

Commands:
  init      Register cmux-swarm with all AI coding tools
  help      Show this help

When no command is given, the stdio MCP server starts (default behavior).

Examples:
  npx cmux-swarm init              # global setup (all projects)
  npx cmux-swarm init --project    # per-project setup (current dir)
  npx cmux-swarm
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  await runServer();
}

main().catch((err) => {
  console.error('cmux-swarm failed:', err);
  process.exit(1);
});
