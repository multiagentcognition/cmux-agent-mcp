#!/usr/bin/env node

import { initGlobal } from './init.js';

try {
  const result = initGlobal();
  if (result.updatedFiles.length > 0) {
    console.log(`cmux-swarm: registered globally\n${result.updatedFiles.map((f) => `  ${f}`).join('\n')}`);
  }
} catch {
  // Non-fatal — don't break the install
}
