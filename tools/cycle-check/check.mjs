import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import madge from 'madge';

/** Raw JSON options avoid Madge 8's double conversion of parsed tsconfig enums. */
export async function checkCycles(directory) {
  const graph = await madge(directory, {
    fileExtensions: ['ts'],
    tsConfig: {
      compilerOptions: {
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
      },
    },
  });
  const files = Object.keys(graph.obj()).length;
  if (files === 0) {
    throw new Error(`No TypeScript source files found in ${directory}`);
  }
  return {
    files,
    cycles: graph.circular(),
    skipped: graph.warnings().skipped,
  };
}

async function main() {
  const directory = process.argv[2]
    ? resolve(process.argv[2])
    : fileURLToPath(new URL('../../src/', import.meta.url));
  const { files, cycles, skipped } = await checkCycles(directory);
  console.log(`Processed ${files} files.`);
  for (const cycle of cycles) {
    console.error(`Circular dependency: ${cycle.join(' -> ')} -> ${cycle[0]}`);
  }
  for (const dependency of skipped) {
    console.error(`Unresolved dependency: ${dependency}`);
  }
  if (cycles.length || skipped.length) {
    process.exitCode = 1;
    return;
  }
  console.log('No circular or unresolved dependencies found.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
