import { posix } from "node:path";
import type tsType from "typescript";
import { loadTypescript } from "./load-typescript.js";

const TS_MODULE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"] as const;
const ESM_EXTENSION_REWRITES = new Map([
  [".js", ".ts"],
  [".jsx", ".tsx"],
  [".mjs", ".mts"],
  [".cjs", ".cts"],
]);

export type BlobOid = string & { readonly __brand: "BlobOid" };

export type ModuleBindings = {
  oid: BlobOid;
  exports: readonly ExportBinding[];
  imports: readonly ImportBinding[];
};

export type ExportBinding =
  | { kind: "named"; name: string; line: number }
  | { kind: "default"; name: string | undefined; line: number }
  | { kind: "star"; from: string; line: number };

export type ImportBinding = {
  specifier: string;
  line: number;
  clause: ImportClause;
};

export type ImportClause =
  | { kind: "named"; names: readonly string[] }
  | { kind: "default"; local: string }
  | { kind: "namespace"; local: string }
  | { kind: "side-effect" }
  | { kind: "export-star" };

export function asBlobOid(value: string): BlobOid {
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`Invalid git blob oid: ${value}`);
  }
  return value as BlobOid;
}

export function isTsModulePath(path: string): boolean {
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
  const rewrittenExtension = ESM_EXTENSION_REWRITES.get(extension);
  const candidates: string[] = [];

  if (rewrittenExtension) {
    candidates.push(`${resolved.slice(0, -extension.length)}${rewrittenExtension}`);
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
