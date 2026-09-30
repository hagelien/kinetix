import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const CORE_DIR = join(process.cwd(), 'src/lib/kinetics-core');

function productionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' || entry.name === 'fixtures'
        ? []
        : productionTypeScriptFiles(path);
    }
    return extname(entry.name) === '.ts' ? [path] : [];
  });
}

describe('kinetics-core Node ESM compatibility', () => {
  it('uses explicit .js extensions for production relative module specifiers', () => {
    const extensionless: string[] = [];
    const relativeSpecifier = /\b(?:from|import)\s*(?:[^'";]*?\sfrom\s*)?['"](\.{1,2}\/[^'"]+)['"]/g;

    for (const file of productionTypeScriptFiles(CORE_DIR)) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(relativeSpecifier)) {
        const specifier = match[1];
        if (specifier && !/\.(?:c|m)?js$/.test(specifier)) {
          extensionless.push(`${relative(process.cwd(), file)}: ${specifier}`);
        }
      }
    }

    expect(extensionless).toEqual([]);
  });

  it('loads the emitted entry point in Node without a TypeScript resolver', () => {
    const outputDirectory = mkdtempSync(join(tmpdir(), 'kinetics-core-esm-'));

    try {
      writeFileSync(join(outputDirectory, 'package.json'), '{"type":"module"}\n');

      for (const file of productionTypeScriptFiles(CORE_DIR)) {
        const outputFile = join(
          outputDirectory,
          relative(CORE_DIR, file).replace(/\.ts$/, '.js'),
        );
        mkdirSync(dirname(outputFile), { recursive: true });
        const emitted = ts.transpileModule(readFileSync(file, 'utf8'), {
          compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2020,
          },
          fileName: file,
        });
        writeFileSync(outputFile, emitted.outputText);
      }

      execFileSync(process.execPath, [join(outputDirectory, 'index.js')], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });
});
