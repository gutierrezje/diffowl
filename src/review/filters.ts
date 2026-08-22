import type { ReviewConfidence } from "../config.js";
import type { ReviewFinding } from "./types.js";

export function filterFindingsByConfidence(
  findings: ReviewFinding[],
  minConfidence: ReviewConfidence,
) {
  const levels = ["low", "medium", "high"];
  const minIndex = levels.indexOf(minConfidence);

  const kept = findings.filter((finding) => {
    const index = levels.indexOf(finding.confidence.toLowerCase());
    return index >= minIndex;
  });
  return { findings: kept, dropped: findings.length - kept.length };
}

export function filterFindingsByChangedFiles(
  findings: ReviewFinding[],
  changedFiles: Set<string>,
) {
  const kept: ReviewFinding[] = [];
  const suppressed: ReviewFinding[] = [];
  for (const finding of findings) {
    if (changedFiles.has(finding.file)) {
      kept.push(finding);
    } else {
      suppressed.push(finding);
    }
  }
  return { findings: kept, suppressed };
}
