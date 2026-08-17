import { describe, expect, it } from "vitest";
import {
  asBlobOid,
  isTsModulePath,
  parseModuleBindings,
  resolveSpecifier,
} from "./module-bindings.js";

const oid = asBlobOid("a".repeat(40));

describe("isTsModulePath", () => {
  it("includes TypeScript modules and excludes declaration files", () => {
    expect(isTsModulePath("src/example.ts")).toBe(true);
    expect(isTsModulePath("src/example.tsx")).toBe(true);
    expect(isTsModulePath("src/example.mts")).toBe(true);
    expect(isTsModulePath("src/example.cts")).toBe(true);
    expect(isTsModulePath("src/types.d.ts")).toBe(false);
    expect(isTsModulePath("src/types.d.mts")).toBe(false);
    expect(isTsModulePath("src/types.d.cts")).toBe(false);
    expect(isTsModulePath("src/example.js")).toBe(false);
  });
});

describe("parseModuleBindings", () => {
  it("records TypeScript import and export syntax", () => {
    const bindings = parseModuleBindings({
      path: "src/example.ts",
      oid,
      content: [
        "import value from './default.js';",
        "import { User, type Username as Login } from './named.js';",
        "import * as models from './models.js';",
        "import type { Config } from './config.js';",
        "export * from './shared.js';",
        "export { User as Account } from './account.js';",
        "export function calculateTotal() { return 1; }",
        "export default function createTotal() { return 1; }",
      ].join("\n"),
    });

    expect(bindings?.imports).toEqual([
      { specifier: "./default.js", line: 1, clause: { kind: "default", local: "value" } },
      {
        specifier: "./named.js",
        line: 2,
        clause: { kind: "named", names: ["User", "Username"] },
      },
      {
        specifier: "./models.js",
        line: 3,
        clause: { kind: "namespace", local: "models" },
      },
      {
        specifier: "./config.js",
        line: 4,
        clause: { kind: "named", names: ["Config"] },
      },
      { specifier: "./shared.js", line: 5, clause: { kind: "export-star" } },
      {
        specifier: "./account.js",
        line: 6,
        clause: { kind: "named", names: ["User"] },
      },
    ]);
    expect(bindings?.exports).toEqual([
      { kind: "star", from: "./shared.js", line: 5 },
      { kind: "named", name: "Account", line: 6 },
      { kind: "named", name: "calculateTotal", line: 7 },
      { kind: "default", name: "createTotal", line: 8 },
    ]);
  });
});

describe("resolveSpecifier", () => {
  it("resolves relative ESM output extensions to TypeScript source", () => {
    expect(resolveSpecifier("src/consumer.ts", "./example.js", new Set(["src/example.ts"]))).toBe(
      "src/example.ts",
    );
    expect(resolveSpecifier("src/consumer.ts", "./button.js", new Set(["src/button.tsx"]))).toBe(
      "src/button.tsx",
    );
    expect(
      resolveSpecifier(
        "src/consumer.ts",
        "./button.js",
        new Set(["src/button.ts", "src/button.tsx"]),
      ),
    ).toBe("src/button.ts");
  });

  it("resolves extension and index candidates against exact paths", () => {
    const files = new Set(["src/User.ts", "src/Username.ts", "src/models/index.ts"]);

    expect(resolveSpecifier("src/consumer.ts", "./User", files)).toBe("src/User.ts");
    expect(resolveSpecifier("src/consumer.ts", "./Username", files)).toBe("src/Username.ts");
    expect(resolveSpecifier("src/consumer.ts", "./models", files)).toBe("src/models/index.ts");
    expect(resolveSpecifier("src/consumer.ts", "package", files)).toBeUndefined();
  });

  it("does not resolve ambient .d.ts modules that are outside the graph", () => {
    const files = new Set(["src/types.d.ts"]);
    expect(resolveSpecifier("src/consumer.ts", "./types", files)).toBeUndefined();
  });
});
