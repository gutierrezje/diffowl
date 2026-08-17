import { extname } from "node:path";
import { parseCombinedDiffLine, parseGitDiffLine } from "../git/diff.js";
import type { RenderReviewContextOptions, ReviewContext } from "./context-types.js";

const MAX_DIFF_CHARS = 40_000;
const MAX_AST_SYMBOL_CHARS = 8_000;
const MAX_QUICK_DIFF_CHARS = 12_000;
const MAX_QUICK_SYMBOL_CHARS = 4_000;
const MAX_QUICK_FILE_CHARS = 4_000;

export function renderReviewContext(
  context: ReviewContext,
  options: RenderReviewContextOptions = {},
): string {
  const depth = options.depth ?? context.depth;
  const shallow = depth === "shallow";
  const lines: string[] = [];

  lines.push("## Local Review Context");
  lines.push("");
  lines.push(`Mode: ${context.target.kind}`);
  lines.push(`Review depth: ${depth}`);
  lines.push("");
  lines.push("### Changed Files");
  lines.push(context.diff.summary || "No changed files detected.");
  if (context.skippedFiles.length > 0) {
    lines.push("");
    lines.push("Skipped by include/exclude rules:");
    lines.push(context.skippedFiles.map((file) => `- ${file.path}`).join("\n"));
  }
  if (context.diagnostics.length > 0) {
    lines.push("");
    lines.push("Context diagnostics:");
    lines.push(context.diagnostics.map((diagnostic) => `- ${diagnostic}`).join("\n"));
  }
  lines.push("");
  lines.push("### Diff");
  lines.push(
    fence(
      truncateText(
        filterDiffRaw(
          context.diff.raw,
          new Set(context.changedFiles.map((fileContext) => fileContext.file.path)),
        ),
        shallow ? MAX_QUICK_DIFF_CHARS : MAX_DIFF_CHARS,
      ).text,
      "diff",
    ),
  );
  lines.push("");

  for (const fileContext of context.changedFiles) {
    lines.push(`### File Context: ${fileContext.file.path}`);
    lines.push(
      `Status: ${fileContext.file.status}; additions: ${fileContext.file.additions}; deletions: ${fileContext.file.deletions}`,
    );

    if (fileContext.imports.length > 0) {
      lines.push("");
      lines.push("Imports:");
      lines.push(fileContext.imports.map((line) => `- ${line}`).join("\n"));
    }

    if (fileContext.symbols.length > 0) {
      lines.push("");
      lines.push("Symbols:");
      lines.push(fileContext.symbols.map((symbol) => `- ${symbol}`).join("\n"));
    }

    lines.push("");
    if (fileContext.changedLines.length > 0) {
      lines.push(`Changed lines: ${summarizeLines(fileContext.changedLines)}`);
      lines.push("");
    }

    if (fileContext.astSymbols.length > 0) {
      lines.push("Changed AST symbols:");
      for (const symbol of shallow ? fileContext.astSymbols.slice(0, 5) : fileContext.astSymbols) {
        lines.push(`#### ${symbol.kind} ${symbol.name} (${symbol.startLine}-${symbol.endLine})`);
        lines.push(
          fence(
            truncateText(symbol.text, shallow ? MAX_QUICK_SYMBOL_CHARS : MAX_AST_SYMBOL_CHARS).text,
            languageForPath(fileContext.file.path),
          ),
        );
        if (symbol.truncated) {
          lines.push("_Symbol content truncated._");
        }
        lines.push("");
      }
    }

    if (fileContext.content.status === "skipped") {
      lines.push(`_File content skipped: ${fileContext.content.reason}._`);
    } else {
      switch (fileContext.content.render) {
        case "full":
          lines.push(
            fence(
              shallow
                ? truncateText(fileContext.content.text, MAX_QUICK_FILE_CHARS).text
                : fileContext.content.text,
              languageForPath(fileContext.file.path),
            ),
          );
          if (fileContext.content.truncated) {
            lines.push("_File content truncated._");
          }
          break;
        case "diff-only":
          lines.push(
            "_Full file content omitted because the diff already shows the changed hunks._",
          );
          break;
        case "ast-symbols":
          lines.push("_Full file content omitted because changed AST symbols are shown._");
          break;
      }
    }
    lines.push("");
  }

  if (!shallow && context.relatedFiles.length > 0) {
    lines.push("### Related Test Files");
    for (const related of context.relatedFiles) {
      lines.push(`#### ${related.path}`);
      lines.push(`Reason: ${related.reason}`);
      lines.push(fence(related.content, languageForPath(related.path)));
      if (related.truncated) {
        lines.push("_File content truncated._");
      }
      lines.push("");
    }
  }

  if (!shallow && context.references.length > 0) {
    lines.push("### Import references");
    lines.push("These snippets show TypeScript modules that import a changed file or symbol.");
    for (const reference of context.references) {
      lines.push(`#### Term: ${reference.term}`);
      for (const match of reference.matches) {
        lines.push(`- ${match.path}:${match.line}: ${match.text}`);
        if (match.snippet) {
          lines.push(fence(match.snippet, languageForPath(match.path)));
        }
      }
      lines.push("");
    }
  }

  return lines.join("\n").trim();
}

function filterDiffRaw(rawDiff: string, includedPaths: Set<string>): string {
  if (includedPaths.size === 0) {
    return "No included file diffs.";
  }

  const lines: string[] = [];
  let includeCurrentFile = false;

  for (const line of rawDiff.split(/\r?\n/).map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l))) {
    const gitDiffPaths = parseGitDiffLine(line);
    if (gitDiffPaths) {
      includeCurrentFile = includedPaths.has(gitDiffPaths.pathB);
    } else {
      const combinedPath = parseCombinedDiffLine(line);
      if (combinedPath) {
        includeCurrentFile = includedPaths.has(combinedPath);
      }
    }

    if (includeCurrentFile) {
      lines.push(line);
    }
  }

  return lines.join("\n");
}

function summarizeLines(lines: number[]): string {
  const sortedLines = [...new Set(lines)].sort((a, b) => a - b);
  const firstLine = sortedLines[0];
  if (firstLine === undefined) {
    return "";
  }

  const ranges: string[] = [];
  let start = firstLine;
  let previous = firstLine;

  for (const line of sortedLines.slice(1)) {
    if (line === previous + 1) {
      previous = line;
      continue;
    }

    ranges.push(formatLineRange(start, previous));
    start = line;
    previous = line;
  }

  ranges.push(formatLineRange(start, previous));
  return ranges.join(", ");
}

function formatLineRange(start: number, end: number): string {
  return start === end ? String(start) : `${start}-${end}`;
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return {
    text: `${text.slice(0, maxChars)}\n... [truncated ${text.length - maxChars} chars]`,
    truncated: true,
  };
}

function fence(content: string, language = ""): string {
  return `\`\`\`${language}\n${content.replaceAll("```", "'''")}\n\`\`\``;
}

function languageForPath(path: string): string {
  const ext = extname(path).slice(1);
  if (ext === "ts" || ext === "tsx") return "ts";
  if (ext === "js" || ext === "jsx") return "js";
  if (ext === "json") return "json";
  if (ext === "md") return "md";
  if (ext === "yml" || ext === "yaml") return "yaml";
  return "";
}
