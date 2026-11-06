import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const name = 'development';
export const inject = ['systemPrompt'];

export function apply(ctx) {
  const skillRoot = fileURLToPath(
    new URL('./skills/ember-rsi/', import.meta.url),
  );
  ctx.systemPrompt.section({
    name: 'rsi:development',
    order: 3300,
    interpolate: false,
    text: `${readFileSync(new URL('./prompts/development.md', import.meta.url), 'utf8')}\n\nThe authoritative skill files are at ${skillRoot}. Read its references and fixed assets there when needed.`,
  });
}
