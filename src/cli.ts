#!/usr/bin/env node

// CLI entry point — will route to init or MCP server.

async function main(): Promise<void> {
  console.log('cmux-swarm: CLI placeholder');
}

main().catch((err) => {
  console.error('cmux-swarm failed:', err);
  process.exit(1);
});
