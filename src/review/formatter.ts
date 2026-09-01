import chalk from "chalk";
import { rename, unlink, writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import type { ReviewFinding, ReviewReport } from "./types.js";
import { getSharedDiffOwlDir } from "../git/state-root.js";
import type { ReviewInputIdentity } from "./provenance.js";

export const REPORT_SCHEMA_VERSION = 2 as const;

type ReviewMetadata = {
  schema_version: typeof REPORT_SCHEMA_VERSION;
  review_id: string;
  session_id: string;
  project_root: string;
  target: {
    kind: ReviewInputIdentity["targetKind"];
    ref: string | null;
    base_commit: string | null;
    merge_base_commit: string | null;
    commit: string | null;
  };
};

function formatFindingHeading(index: number, finding: ReviewFinding): string {
  const ordinal = `Finding ${index + 1}`;
  if (!finding.durable) {
    return `#### ${ordinal}`;
  }

  const classification = formatFindingClassification(finding.durable);
  return `#### ${ordinal} (\`${finding.durable.id}\`) — ${classification}`;
}

function formatFindingClassification(durable: NonNullable<ReviewFinding["durable"]>): string {
  if (durable.lifecycleSuppressed) {
    return `**suppressed (${durable.status})**`;
  }
  return `**${durable.classification}**`;
}

/**
 * Render a structured review into the markdown format we persist.
 */
export function renderMarkdown(report: ReviewReport): string {
  const lines: string[] = [];

  lines.push("### Summary");
  lines.push(report.summary.trim() || "No summary provided.");
  lines.push("");

  lines.push("### Issues Found");

  if (report.findings.length === 0) {
    lines.push("No issues were reported.");
  } else {
    for (const [index, finding] of report.findings.entries()) {
      lines.push(formatFindingHeading(index, finding));
      lines.push(`**[${finding.severity.toUpperCase()}] ${finding.file}:${finding.line}**`);
      lines.push(finding.title.trim());
      lines.push("");
      if (finding.evidence) {
        lines.push(`> **Evidence:** ${formatMarkdownCodeSpan(finding.evidence)}`);
        lines.push("");
      }
      lines.push(finding.body.trim());
      lines.push("");
    }
  }

  if (report.suppressedFindings && report.suppressedFindings.length > 0) {
    lines.push("");
    lines.push("### Suppressed Findings");
    lines.push("These findings were excluded from the actionable review set.");
    lines.push("");
    for (const [index, finding] of report.suppressedFindings.entries()) {
      lines.push(formatFindingHeading(report.findings.length + index, finding));
      lines.push(
        `**[${finding.severity.toUpperCase()}] ${finding.file}:${finding.line}** (${finding.confidence} confidence)`,
      );
      lines.push(finding.title.trim());
      lines.push("");
      if (finding.evidence) {
        lines.push(`> **Evidence:** ${formatMarkdownCodeSpan(finding.evidence)}`);
        lines.push("");
      }
      lines.push(finding.body.trim());
      lines.push("");
    }
  }

  if (report.diagnostics && report.diagnostics.length > 0) {
    lines.push("");
    lines.push("### Diagnostics");
    for (const diagnostic of report.diagnostics) {
      lines.push(`- ${diagnostic}`);
    }
  }

  lines.push("");
  lines.push("### Status");
  lines.push(resolveMarkdownReviewStatus(report.findings));

  return lines.join("\n");
}

function resolveMarkdownReviewStatus(
  findings: ReviewReport["findings"],
): "Open" | "Advisory" | "Resolved" {
  if (findings.length === 0) {
    return "Resolved";
  }
  if (findings.some((finding) => finding.severity === "error" || finding.severity === "warning")) {
    return "Open";
  }
  return "Advisory";
}

/**
 * Format and write the review output as a markdown file
 */
export async function writeMarkdownReport(
  review: string,
  metadata?: ReviewMetadata,
): Promise<string> {
  const dir = join(await getSharedDiffOwlDir(), "reviews");
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  // UUID suffix avoids same-ms collisions when concurrent reviews share a checkout.
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `review-${timestamp}-${randomUUID().slice(0, 8)}.md`;
  const filepath = join(dir, filename);

  const content = `${metadata ? renderReviewFrontmatter(metadata) : ""}# DiffOwl Review
_${new Date().toLocaleString()}_

${review}
`;

  await writeFileAtomic(filepath, content);
  return filepath;
}

async function writeFileAtomic(filepath: string, content: string): Promise<void> {
  const tempPath = `${filepath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, content, "utf-8");
  try {
    await rename(tempPath, filepath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

function renderReviewFrontmatter(metadata: ReviewMetadata): string {
  return `---\n${stringify({ diffowl: metadata }, { lineWidth: 0 })}---\n\n`;
}

/**
 * Print the review header
 */
export function printHeader(): void {
  console.log();
  console.log(chalk.bold("diffowl") + chalk.dim(" reviewing..."));
  console.log(chalk.dim("─".repeat(50)));
  console.log();
}

/**
 * Print the review footer with summary
 */
export function printFooter(report: ReviewReport, reportPath?: string): void {
  console.log();
  console.log(chalk.dim("─".repeat(50)));

  let errors = 0;
  let warnings = 0;
  let infos = 0;

  for (const finding of report.findings) {
    switch (finding.severity) {
      case "error":
        errors++;
        break;
      case "warning":
        warnings++;
        break;
      case "info":
        infos++;
        break;
    }
  }

  const parts: string[] = [];
  if (errors > 0) parts.push(chalk.red(`${errors} error${errors > 1 ? "s" : ""}`));
  if (warnings > 0) parts.push(chalk.yellow(`${warnings} warning${warnings > 1 ? "s" : ""}`));
  if (infos > 0) parts.push(chalk.blue(`${infos} suggestion${infos > 1 ? "s" : ""}`));

  if (parts.length === 0) {
    console.log(chalk.green("✓ No issues found. Clean commit!"));
  } else {
    console.log(`Found ${parts.join(", ")}`);
  }

  if (reportPath) {
    console.log(chalk.dim(`Report saved: ${reportPath}`));
  }
  console.log();
}

export function formatMarkdownCodeSpan(text: string): string {
  const trimmed = text.trim();
  let maxRun = 0;
  let currentRun = 0;
  for (const char of trimmed) {
    if (char === "`") {
      currentRun++;
      if (currentRun > maxRun) {
        maxRun = currentRun;
      }
    } else {
      currentRun = 0;
    }
  }

  const delimiter = "`".repeat(maxRun + 1);
  const pad = trimmed.startsWith("`") || trimmed.endsWith("`") ? " " : "";
  return `${delimiter}${pad}${trimmed}${pad}${delimiter}`;
}

export function formatExcludedCandidateSummary(
  belowConfidence: number,
  outsideChangedFiles: number,
): string {
  const total = belowConfidence + outsideChangedFiles;
  const reasons = [
    belowConfidence > 0 ? `${belowConfidence} below the confidence threshold` : undefined,
    outsideChangedFiles > 0 ? `${outsideChangedFiles} outside changed files` : undefined,
  ].filter((reason): reason is string => reason !== undefined);

  return `${total} candidate${total === 1 ? "" : "s"} excluded from findings: ${reasons.join(" and ")}. Run a new review if you need more model analysis.`;
}
