import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { z } from "zod";
import { removeTempDir } from "./test/helpers.js";

const projectRoot = join(import.meta.dirname, "..");
const temporaryDirectories: string[] = [];
const diagnosticSchema = z.object({ code: z.string(), severity: z.string() });
const reportSchema = z.object({ diagnostics: z.array(diagnosticSchema) });
type Diagnostic = z.infer<typeof diagnosticSchema>;

afterEach(async () => {
  await Promise.all(temporaryDirectories.map((directory) => removeTempDir(directory)));
  temporaryDirectories.length = 0;
});

async function runOxlint(source: string) {
  const directory = await mkdtemp(join(tmpdir(), "diffowl-anti-slop-"));
  temporaryDirectories.push(directory);
  const sourcePath = join(directory, "fixture.ts");
  await writeFile(sourcePath, source, "utf8");

  const result = await execa("pnpm", ["exec", "oxlint", sourcePath, "--format", "json"], {
    cwd: projectRoot,
    reject: false,
  });
  const document = reportSchema.parse(JSON.parse(result.stdout));
  return { diagnostics: document.diagnostics, exitCode: result.exitCode };
}

describe("anti-slop Oxlint policy", () => {
  it("reports a legacy hit as a warning without failing Oxlint", async () => {
    const result = await runOxlint("export const shape = true;\n");

    expect(result.exitCode).toBe(0);
    const diagnostics = result.diagnostics.filter(
      (diagnostic: Diagnostic) => diagnostic.code === "anti-slop(no-shape-in-symbol-names)",
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ severity: "warning" });
  });

  it("keeps a zero-hit policy rule as an error", async () => {
    const result = await runOxlint(
      "function accept(value: object): void {\n  void value;\n}\nvoid accept;\n",
    );

    expect(result.exitCode).toBe(1);
    const diagnostics = result.diagnostics.filter(
      (diagnostic: Diagnostic) => diagnostic.code === "anti-slop(no-object-parameters)",
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ severity: "error" });
  });

  it("allows typeof in explicit type guards but warns on ordinary runtime checks", async () => {
    const result = await runOxlint(
      [
        "function isText(value: string | number): value is string {",
        '  return typeof value === "string";',
        "}",
        'const value = "text";',
        'const ordinaryCheck = typeof value === "string";',
        "void isText;",
        "void ordinaryCheck;",
        "",
      ].join("\n"),
    );

    expect(result.exitCode).toBe(0);
    const diagnostics = result.diagnostics.filter(
      (diagnostic: Diagnostic) => diagnostic.code === "anti-slop(no-runtime-typeof)",
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ severity: "warning" });
  });
});
