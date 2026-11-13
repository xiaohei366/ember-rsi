import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Ajv, type ValidateFunction } from 'ajv';
import { object } from './config.ts';
import { getJson } from './process.ts';

interface Overview {
  id: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  usage: Record<string, number> | null;
  limits: Record<string, number>;
}
interface Metric {
  name: string;
  definitionRef: string;
  unit: string;
  status: string;
  values: Record<string, number | null>;
}
interface Measurement {
  ref: string;
  candidateRef: string;
  status: string;
  coverage: string;
  comparisonKey: string | null;
  metrics: Metric[];
}
interface Candidate {
  ref: string;
  parentRef: string | null;
  artifactRef: string;
}
interface Reference {
  kind: 'candidate' | 'measurement';
  path: string;
  ref: string;
}
interface FileEntry {
  path: string;
  digest?: string;
}
const ajv = new Ajv();
const text = { type: 'string' };
const nullableText = { type: ['string', 'null'] };
const numbers = { type: 'object', additionalProperties: { type: 'number' } };
const validateOverview = ajv.compile<Overview>({
  type: 'object',
  required: [
    'id',
    'status',
    'startedAt',
    'finishedAt',
    'error',
    'usage',
    'limits',
  ],
  properties: {
    id: text,
    status: text,
    startedAt: nullableText,
    finishedAt: nullableText,
    error: nullableText,
    usage: { anyOf: [numbers, { type: 'null' }] },
    limits: numbers,
  },
});
const validateMeasurement = ajv.compile<Measurement>({
  type: 'object',
  required: [
    'ref',
    'candidateRef',
    'status',
    'coverage',
    'comparisonKey',
    'metrics',
  ],
  properties: {
    ref: text,
    candidateRef: text,
    status: text,
    coverage: text,
    comparisonKey: nullableText,
    metrics: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'definitionRef', 'unit', 'status', 'values'],
        properties: {
          name: text,
          definitionRef: text,
          unit: text,
          status: text,
          values: {
            type: 'object',
            additionalProperties: { type: ['number', 'null'] },
          },
        },
      },
    },
  },
});
const validateCandidate = ajv.compile<Candidate>({
  type: 'object',
  required: ['ref', 'parentRef', 'artifactRef'],
  properties: { ref: text, parentRef: nullableText, artifactRef: text },
});
const validateReferences = ajv.compile<Reference[]>({
  type: 'array',
  items: {
    type: 'object',
    required: ['kind', 'path', 'ref'],
    properties: {
      kind: { enum: ['candidate', 'measurement'] },
      path: text,
      ref: text,
    },
  },
});
const validateFile = ajv.compile<FileEntry>({
  type: 'object',
  required: ['path'],
  properties: { path: text, digest: text },
});

function checked<T>(validate: ValidateFunction<T>, value: unknown): T {
  if (!validate(value))
    throw new Error(
      `Unexpected observation response: ${ajv.errorsText(validate.errors)}`,
    );
  return value;
}

export async function overview(
  base: string,
  id: string,
  signal?: AbortSignal,
): Promise<Overview> {
  return checked(
    validateOverview,
    await getJson(base, `/experiments/${encodeURIComponent(id)}`, signal),
  );
}

async function pages<T>(
  read: (offset: number) => Promise<unknown>,
  validate: ValidateFunction<T>,
): Promise<T[]> {
  const items: T[] = [];
  let offset = 0;
  for (;;) {
    const page = object(await read(offset), 'Observation page');
    if (!Array.isArray(page.items))
      throw new Error('Observation page has no items');
    items.push(...page.items.map((item) => checked(validate, item)));
    if (page.nextOffset === null) return items;
    if (
      typeof page.nextOffset !== 'number' ||
      !Number.isSafeInteger(page.nextOffset) ||
      page.nextOffset <= offset
    )
      throw new Error('Invalid observation pagination');
    offset = page.nextOffset;
  }
}

function rootCandidate(
  ref: string,
  candidates: Candidate[],
): Candidate | undefined {
  let candidate = candidates.find((entry) => entry.ref === ref);
  const seen = new Set<string>();
  while (candidate?.parentRef) {
    if (seen.has(candidate.ref)) return undefined;
    seen.add(candidate.ref);
    candidate = candidates.find((entry) => entry.ref === candidate!.parentRef);
  }
  return candidate;
}

export function elapsed(
  start: string | null,
  finish: string | null = null,
): number | null {
  const ms = start
    ? (finish ? Date.parse(finish) : Date.now()) - Date.parse(start)
    : NaN;
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

export function duration(ms: number | null): string {
  if (ms === null) return 'unknown';
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m ${seconds % 60}s`;
}

export function usageText(record: Overview): string {
  return ['operations', 'evaluationRuns', 'modelCalls']
    .map(
      (key) =>
        `${key} ${record.usage?.[key] ?? '?'}/${record.limits[key] ?? '—'}`,
    )
    .join(' · ');
}

const cell = (value: unknown): string =>
  String(value)
    .replaceAll('|', '\\|')
    .replace(/[\r\n]+/g, ' ');

/** Only explicitly returned measurements are results; comparisons require identical conditions. */
export function renderSummary(
  record: Overview,
  references: Reference[],
  measurements: Measurement[],
  candidates: Candidate[],
): string {
  const lines = [
    `# ${record.id}`,
    '',
    `Status: **${record.status}** · elapsed: ${duration(elapsed(record.startedAt, record.finishedAt))}`,
    '',
    usageText(record),
    '',
  ];
  if (record.error) lines.push(`Error: ${cell(record.error)}`, '');
  const returned = references.filter((entry) => entry.kind === 'measurement');
  if (!returned.length)
    lines.push(
      'No returned measurements are recorded. No final score is inferred.',
      '',
    );
  else
    lines.push(
      '| Output | Candidate | Measurement | Metric | Value | Comparable baseline | Difference |',
      '| --- | --- | --- | --- | --- | --- | --- |',
    );
  for (const reference of returned) {
    const final = measurements.find((entry) => entry.ref === reference.ref);
    if (!final) {
      lines.push(
        `| ${cell(reference.path)} | — | ${cell(reference.ref)} | unavailable | — | — | — |`,
      );
      continue;
    }
    const root = rootCandidate(final.candidateRef, candidates);
    if (!final.metrics.length)
      lines.push(
        `| ${cell(reference.path)} | ${cell(final.candidateRef)} | ${cell(final.ref)} | no metrics | — | — | — |`,
      );
    for (const metric of final.metrics) {
      const matches =
        root &&
        root.ref !== final.candidateRef &&
        final.status === 'succeeded' &&
        final.coverage === 'complete' &&
        final.comparisonKey &&
        metric.status === 'available'
          ? measurements
              .filter(
                (entry) =>
                  entry.candidateRef === root.ref &&
                  entry.status === 'succeeded' &&
                  entry.coverage === 'complete' &&
                  entry.comparisonKey === final.comparisonKey,
              )
              .flatMap((entry) =>
                entry.metrics.filter(
                  (item) =>
                    item.name === metric.name &&
                    item.definitionRef === metric.definitionRef &&
                    item.unit === metric.unit &&
                    item.status === 'available',
                ),
              )
          : [];
      const entries = Object.entries(metric.values);
      for (const [key, value] of entries.length
        ? entries
        : [['value', null] as const]) {
        const baseline =
          matches.length === 1 ? matches[0].values[key] : undefined;
        const difference =
          typeof value === 'number' && typeof baseline === 'number'
            ? Number((value - baseline).toPrecision(10))
            : undefined;
        lines.push(
          `| ${[reference.path, final.candidateRef, final.ref, `${metric.name}.${key} (${metric.unit}; ${metric.status})`, value ?? 'unknown', baseline ?? '—', difference === undefined ? '—' : `${difference > 0 ? '+' : ''}${difference}`].map(cell).join(' | ')} |`,
        );
      }
    }
  }
  lines.push(
    '',
    'Differences are reported only for a unique baseline with matching comparison key, metric definition, unit and complete successful coverage. Validation and independent test outputs remain separate.',
    '',
    'Returned candidates:',
  );
  for (const ref of references.filter((entry) => entry.kind === 'candidate'))
    lines.push(`- ${cell(ref.path)}: ${cell(ref.ref)}`);
  lines.push(
    '',
    'Inspect trajectories and files: `pnpm ember-rsi dashboard`',
    `Regenerate: \`node examples/launcher/launch.mjs summary ${record.id}\``,
    '',
  );
  return lines.join('\n');
}

export function changedFiles(
  before: FileEntry[],
  after: FileEntry[],
): string[] {
  const old = new Map(before.map((entry) => [entry.path, entry]));
  const current = new Map(after.map((entry) => [entry.path, entry]));
  return [...new Set([...old.keys(), ...current.keys()])]
    .sort()
    .flatMap((path) => {
      const a = old.get(path),
        b = current.get(path);
      const kind = !a
        ? 'A'
        : !b
          ? 'D'
          : !a.digest || !b.digest
            ? '?'
            : a.digest !== b.digest
              ? 'M'
              : null;
      return kind ? [`${kind} ${path}`] : [];
    });
}

export async function saveSummary(
  base: string,
  id: string,
  directory: string,
  signal?: AbortSignal,
): Promise<string> {
  const path = `/experiments/${encodeURIComponent(id)}`;
  const [record, details, candidates, measurements] = await Promise.all([
    overview(base, id, signal),
    getJson(base, `${path}/details`, signal),
    pages(
      (offset) =>
        getJson(base, `${path}/candidates?offset=${offset}&limit=100`, signal),
      validateCandidate,
    ),
    pages(
      (offset) =>
        getJson(
          base,
          `${path}/measurements?offset=${offset}&limit=100`,
          signal,
        ),
      validateMeasurement,
    ),
  ]);
  const references = checked(
    validateReferences,
    object(details, 'Details').resultReferences,
  );
  let summary = renderSummary(record, references, measurements, candidates);
  const files = new Map<string, Promise<FileEntry[]>>();
  const readFiles = (ref: string): Promise<FileEntry[]> => {
    let pending = files.get(ref);
    if (!pending) {
      pending = pages(async (offset) => {
        const artifact = object(
          await getJson(
            base,
            `${path}/artifacts/${encodeURIComponent(ref)}?offset=${offset}&limit=100`,
            signal,
          ),
          'Artifact',
        );
        if (artifact.kind !== 'file-tree')
          throw new Error('Candidate artifact is not a file tree');
        return artifact.files;
      }, validateFile);
      files.set(ref, pending);
    }
    return pending;
  };
  for (const ref of new Set(
    references
      .filter(
        (entry) =>
          entry.kind === 'candidate' && entry.path.endsWith('/candidateRef'),
      )
      .map((entry) => entry.ref),
  )) {
    const candidate = candidates.find((entry) => entry.ref === ref),
      root = rootCandidate(ref, candidates);
    if (!candidate || !root) continue;
    try {
      const changes =
        root.artifactRef === candidate.artifactRef
          ? []
          : changedFiles(
              await readFiles(root.artifactRef),
              await readFiles(candidate.artifactRef),
            );
      summary += `\n## Files: ${cell(ref)}\n\nCompared with ${cell(root.ref)}; A added, M modified, D deleted, ? digest unavailable.\n\n${changes.length ? changes.map((entry) => `- ${cell(entry)}`).join('\n') : 'No file changes.'}\n`;
    } catch (error) {
      signal?.throwIfAborted();
      summary += `\nFile comparison unavailable: ${cell(error instanceof Error ? error.message : error)}\n`;
    }
  }
  signal?.throwIfAborted();
  await writeFile(join(directory, 'summary.md'), summary, {
    mode: 0o600,
    signal,
  });
  return summary;
}
