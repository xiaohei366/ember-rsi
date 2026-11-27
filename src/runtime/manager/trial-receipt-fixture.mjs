import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

const [directory, outcome] = process.argv.slice(2);
if (!directory || !['success', 'failure'].includes(outcome)) {
  throw new Error(
    'Usage: node trial-receipt-fixture.mjs <directory> <success|failure>',
  );
}

// The receipt is the durable result of a terminal trial. Each measurement owns its scratch directory.
const scratch = await mkdtemp(join(directory, 'trial-'));
const receipt = join(directory, basename(scratch) + '.json');

async function measure() {
  await writeFile(join(scratch, 'input.txt'), 'trial input\n');
  if (outcome === 'failure') throw new Error('Measurement unavailable');
  return { score: 1 };
}

async function run() {
  let measurement;
  try {
    measurement = await measure();
  } catch (error) {
    await writeFile(
      receipt,
      JSON.stringify({ status: 'failed', error: error.message }),
    );
    return;
  }
  await writeFile(
    receipt,
    JSON.stringify({ status: 'succeeded', measurement }),
  );
  await rm(scratch, { recursive: true, force: true });
}

await run();
