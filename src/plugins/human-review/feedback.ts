import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { showReview, submitFeedback } from './service.js';

/** Plugin-owned command; it does not add commands to the RSI CLI. */
export async function runFeedbackCommand(args: string[]): Promise<unknown> {
  const [action, directory, inputFile, ...extra] = args;
  if (action === 'show' && directory && !inputFile)
    return showReview(directory);
  if (action === 'submit' && directory && inputFile && !extra.length)
    return submitFeedback(
      directory,
      JSON.parse(await readFile(resolve(inputFile), 'utf8')),
    );
  throw new Error(
    'Usage: feedback.js show <request-directory> | submit <request-directory> <feedback.json>',
  );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  runFeedbackCommand(process.argv.slice(2)).then(
    (result) => console.log(JSON.stringify(result, null, 2)),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
