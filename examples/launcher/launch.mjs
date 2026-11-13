#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { main } from './lib/main.ts';

process.exitCode = await main(
  fileURLToPath(new URL('../../', import.meta.url)),
  process.argv.slice(2),
);
