import { readFile, readdir } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { getDiffOwlDir } from "../config.js";
import { parseReviewMetadata } from "./formatter.js";

export function resolveReviewReportPath(report: string): string {
  if (isAbsolute(report)) return report;

  if (report.includes("/") || report.includes("\\")) {
    return resolve(report);
  }

  return join(getDiffOwlDir(), "reviews", report);
}

export async function listReviewReportPaths(): Promise<string[]> {
  const reviews = join(getDiffOwlDir(), "reviews");
  const entries = await Promise.all([
    listMarkdownFiles(reviews),
    listMarkdownFiles(join(reviews, "resolved")),
  ]);

  return entries
    .flat()
    .filter((path) => !path.endsWith("/latest.md"))
    .sort((a, b) => basename(b).localeCompare(basename(a)));
}

export function selectReviewReportPath(paths: string[], answer: string): string | undefined {
  const selection = Number.parseInt(answer.trim(), 10);
  if (!Number.isInteger(selection) || selection < 1 || selection > paths.length) return undefined;
  return paths[selection - 1];
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  try {
    const paths = (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => join(dir, entry.name));
    const reports = await Promise.all(
      paths.map(async (path) => ({
        path,
        metadata: parseReviewMetadata(await readFile(path, "utf-8")),
      })),
    );
    return reports.filter((report) => report.metadata !== undefined).map((report) => report.path);
  } catch {
    return [];
  }
}
