import { readFile } from 'node:fs/promises';
import type { NaturalLanguageCase } from './types.js';

/**
 * Loads the same human-readable Markdown used by the acceptance plan. The runner deliberately does not
 * turn sentences into selectors; the model receives the sentences and acts against a live observation.
 */
export async function loadCases(path: string): Promise<NaturalLanguageCase[]> {
  const markdown = await readFile(path, 'utf8');
  const blocks = markdown
    .split(/(?=^#{2,3}\s+)/m)
    .filter((block) => /^#{2,3}\s+/m.test(block));
  const cases: NaturalLanguageCase[] = [];
  for (const [blockIndex, block] of blocks.entries()) {
    const heading =
      block.match(/^#{2,3}\s+(.+)$/m)?.[1]?.trim() ??
      `section-${blockIndex + 1}`;
    const numberedItems = numberedCases(block);
    const sources =
      numberedItems.length > 0
        ? numberedItems.map((item) => ({
            id: item.id,
            title: `${item.id} ${item.body}`,
            body: item.body,
          }))
        : [
            {
              id:
                heading.match(/^(\d+(?:\.\d+)*(?:[a-z])?)/i)?.[1] ??
                `section-${blockIndex + 1}`,
              title: heading,
              body: block,
            },
          ];
    for (const source of sources) {
      const sourceBlock =
        numberedItems.length > 0 ? `${heading}\n\n${source.body}` : block;
      cases.push(parseCase(sourceBlock, source.id, source.title, cases.length));
    }
  }
  const duplicateIds = cases
    .map((item) => item.id)
    .filter((id, index, ids) => id.match(/^\d/) && ids.indexOf(id) !== index);
  if (duplicateIds.length > 0) {
    throw new Error(
      `Duplicate numbered E2E case ids: ${[...new Set(duplicateIds)].join(', ')}`,
    );
  }
  return cases;
}

function numberedCases(block: string): Array<{ id: string; body: string }> {
  const lines = block.split('\n');
  const cases: Array<{ id: string; body: string }> = [];
  let current: { id: string; body: string } | undefined;
  for (const line of lines) {
    const match = line.match(
      /^\s*-\s*(?:\*\*)?(\d+(?:\.\d+)*(?:[a-z])?)(?:\*\*)?\s+(.+)$/i,
    );
    if (match) {
      current = { id: match[1], body: match[2].trim() };
      cases.push(current);
      continue;
    }
    if (current && /^\s{2,}\S/.test(line)) {
      current.body += ` ${line.trim()}`;
    } else if (line.trim()) {
      current = undefined;
    }
  }
  return cases;
}

function parseCase(
  block: string,
  id: string,
  title: string,
  index: number,
): NaturalLanguageCase {
  const lines = block.split('\n');
  const list = (headingPattern: RegExp): string[] => {
    const start = lines.findIndex((line) => headingPattern.test(line));
    if (start < 0) return [];
    const items: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (/^\s*[-*]\s+/.test(line)) {
        items.push(line.replace(/^\s*[-*]\s+/, '').trim());
        continue;
      }
      if (line.trim()) break;
    }
    return items;
  };
  const paragraph = block
    .replace(/^#{2,3}.*$/m, '')
    .replace(/\n\s*[-*].*$/gm, '')
    .trim();
  return {
    id: id || `case-${index + 1}`,
    title,
    goal: paragraph.slice(0, 2_000),
    preconditions: list(/^\s*preconditions\s*:?$/i),
    actions: list(/^\s*(?:actions|steps)\s*:?$/i),
    expectations: list(/^\s*(?:expectations|expected)\s*:?$/i),
    source: block,
  };
}
