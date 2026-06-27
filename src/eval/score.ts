import { computeFindingFingerprint } from "../state/fingerprint.js";
import type { ReviewFinding, ReviewSeverity } from "../review/types.js";
import type { EvalExpectedFinding } from "./case-types.js";
import type { EvalCaseRunResult } from "./runner-types.js";
import type { EvalCase } from "./case-types.js";
import {
  DEFAULT_EVAL_SCORE_OPTIONS,
  type EvalCaseScore,
  type EvalFnMode,
  type EvalMatch,
  type EvalScoreOptions,
  type EvalTrialScore,
  type RepeatedFalsePositive,
} from "./score-types.js";
import type { EvalTrialResult } from "./runner-types.js";

const SEVERITY_RANK: Record<ReviewSeverity, number> = {
  error: 3,
  warning: 2,
  info: 1,
};

export function severityRank(severity: ReviewSeverity): number {
  return SEVERITY_RANK[severity];
}

function resolveScoreOptions(options?: EvalScoreOptions): Required<EvalScoreOptions> {
  return {
    categoryMatch: options?.categoryMatch ?? DEFAULT_EVAL_SCORE_OPTIONS.categoryMatch,
    fnMode: options?.fnMode ?? DEFAULT_EVAL_SCORE_OPTIONS.fnMode,
    repeatedFpThreshold: options?.repeatedFpThreshold ?? DEFAULT_EVAL_SCORE_OPTIONS.repeatedFpThreshold,
  };
}

function categoryMatches(expected: EvalExpectedFinding, reported: ReviewFinding): boolean {
  if (!expected.category) {
    return true;
  }

  const needle = expected.category.toLowerCase();
  const haystack = `${reported.title} ${reported.body}`.toLowerCase();
  return haystack.includes(needle);
}

export function findingMatchesExpected(
  expected: EvalExpectedFinding,
  reported: ReviewFinding,
  options?: EvalScoreOptions,
): boolean {
  if (reported.file !== expected.file) {
    return false;
  }

  const lineDistance = Math.abs(reported.line - expected.line);
  if (lineDistance > expected.line_tolerance) {
    return false;
  }

  if (severityRank(reported.severity) < severityRank(expected.min_severity)) {
    return false;
  }

  const resolved = resolveScoreOptions(options);
  if (resolved.categoryMatch && !categoryMatches(expected, reported)) {
    return false;
  }

  return true;
}

interface MatchCandidate {
  expectedIndex: number;
  reportedIndex: number;
  lineDistance: number;
}

function buildMatchCandidates(
  expected: EvalExpectedFinding[],
  reported: ReviewFinding[],
  options: Required<EvalScoreOptions>,
): MatchCandidate[] {
  const candidates: MatchCandidate[] = [];

  for (let expectedIndex = 0; expectedIndex < expected.length; expectedIndex++) {
    const expectedEntry = expected[expectedIndex];
    if (!expectedEntry) {
      continue;
    }

    for (let reportedIndex = 0; reportedIndex < reported.length; reportedIndex++) {
      const reportedFinding = reported[reportedIndex];
      if (!reportedFinding) {
        continue;
      }

      if (!findingMatchesExpected(expectedEntry, reportedFinding, options)) {
        continue;
      }

      candidates.push({
        expectedIndex,
        reportedIndex,
        lineDistance: Math.abs(reportedFinding.line - expectedEntry.line),
      });
    }
  }

  return candidates;
}

function assignTruePositives(
  candidates: MatchCandidate[],
  reported: ReviewFinding[],
): EvalMatch[] {
  const sorted = [...candidates].sort((left, right) => {
    if (left.lineDistance !== right.lineDistance) {
      return left.lineDistance - right.lineDistance;
    }

    const rightFinding = reported[right.reportedIndex];
    const leftFinding = reported[left.reportedIndex];
    if (!rightFinding || !leftFinding) {
      return 0;
    }

    return severityRank(rightFinding.severity) - severityRank(leftFinding.severity);
  });

  const usedExpected = new Set<number>();
  const usedReported = new Set<number>();
  const matches: EvalMatch[] = [];

  for (const candidate of sorted) {
    if (usedExpected.has(candidate.expectedIndex) || usedReported.has(candidate.reportedIndex)) {
      continue;
    }

    usedExpected.add(candidate.expectedIndex);
    usedReported.add(candidate.reportedIndex);
    matches.push({
      expectedIndex: candidate.expectedIndex,
      reportedIndex: candidate.reportedIndex,
      lineDistance: candidate.lineDistance,
    });
  }

  return matches;
}

function expectedCountsAsFalseNegative(
  expected: EvalExpectedFinding,
  fnMode: EvalFnMode,
): boolean {
  return fnMode === "strict" || expected.must_detect;
}

export function scoreEvalTrial(
  evalCase: Pick<EvalCase, "id" | "expected">,
  trial: EvalTrialResult,
  options?: EvalScoreOptions,
): EvalTrialScore {
  const resolved = resolveScoreOptions(options);
  const reported = trial.findings;
  const expected = evalCase.expected;
  const candidates = buildMatchCandidates(expected, reported, resolved);
  const truePositives = assignTruePositives(candidates, reported);

  const matchedExpected = new Set(truePositives.map((match) => match.expectedIndex));
  const matchedReported = new Set(truePositives.map((match) => match.reportedIndex));

  const redundancies: ReviewFinding[] = [];
  for (let reportedIndex = 0; reportedIndex < reported.length; reportedIndex++) {
    if (matchedReported.has(reportedIndex)) {
      continue;
    }

    const reportedFinding = reported[reportedIndex];
    if (!reportedFinding) {
      continue;
    }

    const matchesAssignedExpected = expected.some(
      (entry, expectedIndex) =>
        matchedExpected.has(expectedIndex) &&
        findingMatchesExpected(entry, reportedFinding, resolved),
    );
    if (matchesAssignedExpected) {
      redundancies.push(reportedFinding);
    }
  }

  const falsePositives = reported.filter((finding, reportedIndex) => {
    if (!finding || matchedReported.has(reportedIndex)) {
      return false;
    }

    return !expected.some((entry) => findingMatchesExpected(entry, finding, resolved));
  });

  const falseNegatives = expected.filter(
    (entry, expectedIndex) =>
      !matchedExpected.has(expectedIndex) &&
      expectedCountsAsFalseNegative(entry, resolved.fnMode),
  );

  return {
    caseId: evalCase.id,
    trial: trial.trial,
    truePositives,
    falsePositives,
    falseNegatives,
    redundancies,
    counts: {
      tp: truePositives.length,
      fp: falsePositives.length,
      fn: falseNegatives.length,
      redundancy: redundancies.length,
    },
  };
}

function fingerprintFinding(finding: ReviewFinding): string {
  return computeFindingFingerprint(
    finding.evidence === undefined
      ? { file: finding.file, title: finding.title, body: finding.body }
      : {
          file: finding.file,
          title: finding.title,
          body: finding.body,
          evidence: finding.evidence,
        },
  );
}

function detectRepeatedFalsePositives(
  trials: EvalTrialScore[],
  threshold: number,
): RepeatedFalsePositive[] {
  const fingerprintTrials = new Map<string, { count: number; example: ReviewFinding }>();

  for (const trial of trials) {
    const seenInTrial = new Set<string>();

    for (const finding of trial.falsePositives) {
      const fingerprint = fingerprintFinding(finding);
      if (seenInTrial.has(fingerprint)) {
        continue;
      }
      seenInTrial.add(fingerprint);

      const current = fingerprintTrials.get(fingerprint);
      if (current) {
        current.count += 1;
      } else {
        fingerprintTrials.set(fingerprint, { count: 1, example: finding });
      }
    }
  }

  return [...fingerprintTrials.entries()]
    .filter(([, entry]) => entry.count >= threshold)
    .map(([fingerprint, entry]) => ({
      fingerprint,
      trialCount: entry.count,
      example: entry.example,
    }))
    .sort((left, right) => right.trialCount - left.trialCount);
}

export function scoreEvalCase(
  evalCase: Pick<EvalCase, "id" | "category" | "tags" | "expected">,
  run: EvalCaseRunResult,
  options?: EvalScoreOptions,
): EvalCaseScore {
  const resolved = resolveScoreOptions(options);
  const trialScores = run.trials.map((trial) => scoreEvalTrial(evalCase, trial, resolved));

  return {
    caseId: evalCase.id,
    category: evalCase.category,
    tags: evalCase.tags,
    trials: trialScores,
    repeatedFalsePositives: detectRepeatedFalsePositives(
      trialScores,
      resolved.repeatedFpThreshold,
    ),
  };
}
