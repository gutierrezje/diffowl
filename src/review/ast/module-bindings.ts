import { posix } from "node:path";
import type tsType from "typescript";
import { z } from "zod";
import { loadTypescript } from "./load-typescript.js";

const TS_MODULE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"] as const;
const TS_DECLARATION_EXTENSION_RE = /\.d\.(ts|mts|cts)$/;
const ESM_EXTENSION_REWRITES = new Map<string, readonly string[]>([
  [".js", [".ts", ".tsx"]],
  [".jsx", [".tsx"]],
  [".mjs", [".mts"]],
  [".cjs", [".cts"]],
]);

export const BlobOidSchema = z.string().regex(/^[0-9a-f]{40}$/).brand<"BlobOid">();
const PositiveLineSchema = z.number().int().positive();

export const ExportBindingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("named"), name: z.string(), line: PositiveLineSchema }),
  z.object({
    kind: z.literal("default"),
    name: z.string().optional(),
    line: PositiveLineSchema,
  }),
  z.object({ kind: z.literal("star"), from: z.string(), line: PositiveLineSchema }),
]);

export const ImportClauseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("named"), names: z.array(z.string()) }),
  z.object({ kind: z.literal("default"), local: z.string() }),
  z.object({ kind: z.literal("namespace"), local: z.string() }),
  z.object({ kind: z.literal("side-effect") }),
  z.object({ kind: z.literal("export-star") }),
]);

export const ImportBindingSchema = z.object({
  specifier: z.string(),
  line: PositiveLineSchema,
  clause: ImportClauseSchema,
});

export const ModuleBindingsSchema = z.object({
  oid: BlobOidSchema,
  exports: z.array(ExportBindingSchema),
  imports: z.array(ImportBindingSchema),
});

export type BlobOid = z.output<typeof BlobOidSchema>;
export type ExportBinding = z.output<typeof ExportBindingSchema>;
export type ImportClause = z.output<typeof ImportClauseSchema>;
export type ImportBinding = z.output<typeof ImportBindingSchema>;
export type ModuleBindings = z.output<typeof ModuleBindingsSchema>;

export function asBlobOid(value: string): BlobOid {
  return BlobOidSchema.parse(value);
}

export function isTsModulePath(path: string): boolean {
  if (TS_DECLARATION_EXTENSION_RE.test(path)) return false;
  return TS_MODULE_EXTENSIONS.some((extension) => path.endsWith(extension));
}

export function parseModuleBindings(input: {
  path: string;
  content: string;
  oid: BlobOid;
}): ModuleBindings | undefined {
  const ts = loadTypescript();
  if (!ts) return undefined;

  const sourceFile = ts.createSourceFile(input.path, input.content, ts.ScriptTarget.Latest, true);
  const exports: ExportBinding[] = [];
  const imports: ImportBinding[] = [];

  for (const statement of sourceFile.statements) {
    const line = sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile)).line + 1;

    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      addImportDeclaration(ts, statement, statement.moduleSpecifier.text, line, imports);
      continue;
    }

    if (ts.isExportDeclaration(statement)) {
      addExportDeclaration(ts, statement, line, exports, imports);
      continue;
    }

    if (ts.isExportAssignment(statement)) {
      exports.push({ kind: "default", name: undefined, line });
      continue;
    }

    if (!hasModifier(ts, statement, ts.SyntaxKind.ExportKeyword)) continue;

    if (hasModifier(ts, statement, ts.SyntaxKind.DefaultKeyword)) {
      exports.push({
        kind: "default",
        name: declarationName(ts, statement),
        line,
      });
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          exports.push({ kind: "named", name: declaration.name.text, line });
        }
      }
      continue;
    }

    const name = declarationName(ts, statement);
    if (name) {
      exports.push({ kind: "named", name, line });
    }
  }

  return { oid: input.oid, exports, imports };
}

export function resolveSpecifier(
  from: string,
  specifier: string,
  files: ReadonlySet<string>,
): string | undefined {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return undefined;

  const resolved = posix.normalize(posix.join(posix.dirname(from), specifier));
  const extension = posix.extname(resolved);
  const rewrittenExtensions = ESM_EXTENSION_REWRITES.get(extension);
  const candidates: string[] = [];

  if (rewrittenExtensions) {
    const stem = resolved.slice(0, -extension.length);
    for (const rewrittenExtension of rewrittenExtensions) {
      candidates.push(`${stem}${rewrittenExtension}`);
    }
  }
  candidates.push(resolved);

  if (extension === "") {
    for (const candidateExtension of TS_MODULE_EXTENSIONS) {
      candidates.push(`${resolved}${candidateExtension}`);
    }
    for (const candidateExtension of TS_MODULE_EXTENSIONS) {
      candidates.push(posix.join(resolved, `index${candidateExtension}`));
    }
  }

  return candidates.find((candidate) => files.has(candidate));
}

function addImportDeclaration(
  ts: typeof tsType,
  declaration: tsType.ImportDeclaration,
  specifier: string,
  line: number,
  imports: ImportBinding[],
): void {
  const clause = declaration.importClause;
  if (!clause) {
    imports.push({ specifier, line, clause: { kind: "side-effect" } });
    return;
  }

  if (clause.name) {
    imports.push({
      specifier,
      line,
      clause: { kind: "default", local: clause.name.text },
    });
  }

  if (!clause.namedBindings) return;
  if (ts.isNamespaceImport(clause.namedBindings)) {
    imports.push({
      specifier,
      line,
      clause: { kind: "namespace", local: clause.namedBindings.name.text },
    });
    return;
  }

  imports.push({
    specifier,
    line,
    clause: {
      kind: "named",
      names: clause.namedBindings.elements.map((element) => {
        return element.propertyName?.text ?? element.name.text;
      }),
    },
  });
}

function addExportDeclaration(
  ts: typeof tsType,
  declaration: tsType.ExportDeclaration,
  line: number,
  exports: ExportBinding[],
  imports: ImportBinding[],
): void {
  const specifier = declaration.moduleSpecifier;
  const from = specifier && ts.isStringLiteral(specifier) ? specifier.text : undefined;

  if (!declaration.exportClause && from) {
    exports.push({ kind: "star", from, line });
    imports.push({ specifier: from, line, clause: { kind: "export-star" } });
    return;
  }

  if (declaration.exportClause && ts.isNamedExports(declaration.exportClause)) {
    const names = declaration.exportClause.elements.map(
      (element) => element.propertyName?.text ?? element.name.text,
    );
    for (const element of declaration.exportClause.elements) {
      exports.push({ kind: "named", name: element.name.text, line });
    }
    if (from) {
      imports.push({ specifier: from, line, clause: { kind: "named", names } });
    }
    return;
  }

  if (declaration.exportClause && ts.isNamespaceExport(declaration.exportClause) && from) {
    exports.push({ kind: "named", name: declaration.exportClause.name.text, line });
    imports.push({
      specifier: from,
      line,
      clause: { kind: "namespace", local: declaration.exportClause.name.text },
    });
  }
}

function hasModifier(ts: typeof tsType, node: tsType.Node, kind: tsType.SyntaxKind): boolean {
  return Boolean(
    ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === kind),
  );
}

function declarationName(ts: typeof tsType, node: tsType.Node): string | undefined {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isModuleDeclaration(node)
  ) {
    return node.name && ts.isIdentifier(node.name) ? node.name.text : undefined;
  }
  return undefined;
}
