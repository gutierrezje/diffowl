import type { ReadinessResult } from "../review/readiness.js";

export function renderReadiness(result: ReadinessResult): string {
  const lines = [result.result === "ready" ? "Ready for handoff." : result.result === "error" ? "Readiness could not be determined." : `Not ready: ${result.reason.replaceAll("-", " ")}.`];
  if (result.target !== null) lines.push(`Base ${result.target.base_commit.slice(0, 12)} → HEAD ${result.target.head_commit.slice(0, 12)}`);
  if (result.coverage.checkpoint_review_id !== null) {
    lines.push(`Coverage: ${result.coverage.checkpoint_review_id}; ${result.coverage.repair_review_ids.length} repair review(s).`);
  }
  const count = Object.values(result.blockers).reduce((sum, value) => sum + value, 0);
  if (count > 0) lines.push(`Blocking findings: ${count}. Inspect with diffowl findings list.`);
  if (result.diagnostic !== null) lines.push(result.diagnostic);
  const next = {
    handoff: "Hand off this committed snapshot.",
    "review-branch": "Run a full branch review with diffowl review --base <base-ref>.",
    "review-uncovered-change": "Review the uncovered repair commits or run a full branch review.",
    wait: "Wait for the pending review, then query readiness again.",
    "inspect-failure": "Inspect the failed review execution, retry its target, then query again.",
    "commit-or-restore": "Commit or restore local changes, then query readiness again.",
    "disposition-findings": "Inspect findings and record an explicit fix or dismissal.",
    "repair-dependency": "Correct the reported read failure, then query readiness again.",
  } satisfies Record<ReadinessResult["next_action"], string>;
  lines.push(`Next: ${next[result.next_action]}`);
  return lines.join("\n");
}
