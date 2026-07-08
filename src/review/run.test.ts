import { describe, expect, it, vi } from "vitest";
import { buildDocOnlySkipMarkdown, resolveTargetCommit } from "./run.js";

describe("buildDocOnlySkipMarkdown", () => {
  it("renders the documentation-only skip summary and changed files", () => {
    const markdown = buildDocOnlySkipMarkdown({
      files: [
        { path: "README.md", additions: 4, deletions: 1 },
        { path: "docs/usage.md", additions: 12, deletions: 0 },
      ],
    });

    expect(markdown).toBe(`### Summary
Documentation-only changes detected. No code review performed.

### Changed Files
- README.md (+4/-1)
- docs/usage.md (+12/-0)`);
  });
});

describe("resolveTargetCommit", () => {
  it("resolves refs for each target kind", async () => {
    const resolveCommit = vi.fn(async () => "def456");

    await expect(resolveTargetCommit({ kind: "staged" }, resolveCommit)).resolves.toBeNull();
    expect(resolveCommit).not.toHaveBeenCalled();
    await expect(resolveTargetCommit({ kind: "last-commit" }, resolveCommit)).resolves.toBe(
      "def456",
    );
    expect(resolveCommit).toHaveBeenCalledWith("HEAD");
    await expect(resolveTargetCommit({ kind: "commit", ref: "feature-base" }, resolveCommit))
      .resolves.toBe("def456");
    expect(resolveCommit).toHaveBeenCalledWith("feature-base");
  });
});
