import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Serverless functions under `api/` are emitted to JavaScript and executed by
 * Node's native ESM loader on Vercel — with no TypeScript-aware resolver. In
 * that environment every *runtime* relative import must carry an explicit file
 * extension (`./foo.js`), or resolution fails at runtime with
 * `ERR_MODULE_NOT_FOUND` and the endpoint 500s.
 *
 * `tests/kinetics-core-esm-specifiers.test.ts` guards the portable engine, but
 * `api/` reaches many other shared modules under `src/lib`. This test walks the
 * full module graph starting from `api/` and asserts that no runtime relative
 * specifier resolving to a TypeScript source is missing its extension. Type-only
 * imports/exports are elided at emit and are intentionally ignored.
 */

const ROOT = process.cwd();
const API_DIR = join(ROOT, 'api');
const RUNTIME_EXTENSION = /\.(?:c|m)?js$|\.json$/;

function collectTsFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectTsFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)
      ? [path]
      : [];
  });
}

/** Resolve a relative specifier to an on-disk TypeScript source, if any. */
function resolveToTsFile(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = specifier.match(/\.(?:c|m)?js$/)
    ? [base.replace(/\.(?:c|m)?js$/, '.ts'), base.replace(/\.(?:c|m)?js$/, '.tsx')]
    : [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile() && /\.tsx?$/.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

type Specifier =
  // A statically-known relative specifier (static import/export, or a dynamic
  // import of a plain string / no-substitution template).
  | { kind: 'static'; text: string; typeOnly: boolean }
  // An interpolated relative dynamic import (`import(`./x/${y}`)`), whose full
  // path is only known at runtime. It can't be resolved or traversed; it is
  // safe only if the static tail already carries a runtime extension.
  | { kind: 'interpolated'; display: string; tailHasExtension: boolean };

/**
 * True when an import/export declaration is fully erased from the emitted
 * JavaScript and therefore carries no runtime module edge. Covers the
 * declaration-level `import type …` / `export type …` forms *and* the inline
 * form where every named specifier is individually `type`-qualified
 * (`import { type A, type B } from '…'`), which TypeScript also elides even
 * though the declaration-level `isTypeOnly` flag is false. A side-effect import
 * (`import '…'`), a default or namespace binding, an empty named list, or
 * `export * from '…'` keeps a runtime edge and is not erased.
 */
function isErasedTypeOnly(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (!clause) return false; // side-effect import — runtime edge
    if (clause.isTypeOnly) return true; // `import type …`
    if (clause.name) return false; // default binding — runtime
    const bindings = clause.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) return false; // namespace or none
    return bindings.elements.length > 0 && bindings.elements.every((e) => e.isTypeOnly);
  }
  if (node.isTypeOnly) return true; // `export type …`
  const clause = node.exportClause;
  if (!clause || !ts.isNamedExports(clause)) return false; // `export * from …` — runtime
  return clause.elements.length > 0 && clause.elements.every((e) => e.isTypeOnly);
}

/** Every relative import/export/dynamic-import specifier in a source file. */
function relativeSpecifiers(file: string): Specifier[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    /\.tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out: Specifier[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text.startsWith('.')
    ) {
      out.push({ kind: 'static', text: node.moduleSpecifier.text, typeOnly: isErasedTypeOnly(node) });
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0]
    ) {
      const arg = node.arguments[0];
      // A dynamic import path can be a plain string or a static template
      // literal (`import(`./x`)`), which TypeScript models as a
      // NoSubstitutionTemplateLiteral — both emit an extensionless runtime
      // specifier and must be checked.
      if (
        (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) &&
        arg.text.startsWith('.')
      ) {
        out.push({ kind: 'static', text: arg.text, typeOnly: false });
      } else if (ts.isTemplateExpression(arg) && arg.head.text.startsWith('.')) {
        // An interpolated relative import (`import(`./h/${k}`)`) — only the
        // literal tail after the last `${…}` is statically known. Node's ESM
        // loader still needs an extension, so require one in that tail.
        const spans = arg.templateSpans;
        const tail = spans[spans.length - 1]?.literal.text ?? '';
        const display = `\`${arg.head.text}${spans
          .map((s) => `\${…}${s.literal.text}`)
          .join('')}\``;
        out.push({
          kind: 'interpolated',
          display,
          tailHasExtension: RUNTIME_EXTENSION.test(tail),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

describe('server-shared Node ESM compatibility', () => {
  it('uses explicit runtime extensions for every relative import reachable from api/', () => {
    const visited = new Set<string>();
    const queue = collectTsFiles(API_DIR);
    queue.forEach((f) => visited.add(f));

    const extensionless: string[] = [];

    while (queue.length > 0) {
      const file = queue.shift() as string;
      for (const spec of relativeSpecifiers(file)) {
        if (spec.kind === 'interpolated') {
          // Can't be resolved or traversed; flagged only when its static tail
          // lacks a runtime extension (the one part we can check).
          if (!spec.tailHasExtension) {
            extensionless.push(`${relative(ROOT, file)}: ${spec.display}`);
          }
          continue;
        }
        // Type-only edges are erased from the emitted server code, so they
        // neither reach a runtime module nor need an extension. Skip them
        // entirely — following them would pull frontend-only modules (whose
        // extensionless browser imports are legitimate) into the scan.
        if (spec.typeOnly) continue;
        const target = resolveToTsFile(file, spec.text);
        if (target && !visited.has(target)) {
          visited.add(target);
          queue.push(target);
        }
        if (target && !RUNTIME_EXTENSION.test(spec.text)) {
          extensionless.push(`${relative(ROOT, file)}: '${spec.text}'`);
        }
      }
    }

    expect(extensionless).toEqual([]);
  });
});
