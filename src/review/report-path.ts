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
    .filter((path) => basename(path) !== "latest.md")
    .sort((a, b) => basename(b).localeCompare(basename(a)));
}

export function canSelectReviewInteractively(
  inputIsTTY: boolean | undefined,
  outputIsTTY: boolean | undefined,
): boolean {
  return inputIsTTY === true && outputIsTTY === true;
}

export function selectReviewReportPath(paths: string[], answer: string): string | undefined {
  const selection = Number.parseInt(answer.trim(), 10);
  if (!Number.isInteger(selection) || selection < 1 || selection > paths.length) return undefined;
  return paths[selection - 1];
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  let paths: string[];
  try {
    paths = (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }

  const reports = await Promise.all(
    paths.map(async (path) => {
      try {
        return parseReviewMetadata(await readFile(path, "utf-8")) ? path : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  return reports.filter((path): path is string => path !== undefined);
}
