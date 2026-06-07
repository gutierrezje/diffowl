import { isAbsolute, join, resolve } from "node:path";
import { getDiffOwlDir } from "../config.js";

export function resolveReviewReportPath(report: string): string {
  if (isAbsolute(report)) return report;

  if (report.includes("/") || report.includes("\\")) {
    return resolve(report);
  }

  return join(getDiffOwlDir(), "reviews", report);
}
