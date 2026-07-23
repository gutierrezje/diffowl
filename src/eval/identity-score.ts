import { findingMatchesExpected } from "./score.js";
import type { EvalCase, EvalExpectedFinding } from "./case-types.js";
import type { EvalIdentityStepResult, EvalTrialResult } from "./runner-types.js";
import type { ReviewFinding } from "../review/types.js";
import type {
  EvalIdentityAnchorResult,
  EvalIdentityKind,
  EvalIdentityScore,
} from "./score-types.js";

export interface ScoreEvalIdentityInput {
  kind: EvalIdentityKind;
  evalCase: Pick<EvalCase, "id" | "expected" | "steps" | "tags">;
  trial: Pick<EvalTrialResult, "identitySteps" | "error">;
  minDistinct?: number;
}

export function scoreEvalIdentity(input: ScoreEvalIdentityInput): EvalIdentityScore {
  const { kind, evalCase, trial } = input;

  if (trial.error) {
    return aggregateIdentityAnchors(kind, [], `runner error: ${trial.error}`);
  }

  const steps = trial.identitySteps;
  if (!steps || steps.length === 0) {
    return aggregateIdentityAnchors(kind, [], "no identity steps");
  }

  if (kind === "recognize-same") {
    return scoreRecognizeSame(evalCase, steps);
  }

  const minDistinct =
    input.minDistinct ??
    Math.max(2, resolveKeepDistinctExpected(evalCase, steps[steps.length - 1]!).length);
  return scoreKeepDistinct(evalCase, steps, minDistinct);
}

export function tryScoreEvalIdentity(
  evalCase: Pick<EvalCase, "id" | "expected" | "steps" | "tags">,
  run: { trials: Array<Pick<EvalTrialResult, "identitySteps" | "error" | "trial">> },
): EvalIdentityScore | undefined {
  const kind = resolveEvalIdentityKind(evalCase);
  if (!kind) {
    return undefined;
  }

  const trial = run.trials[0];
  if (!trial?.identitySteps?.length) {
    return undefined;
  }

  return scoreEvalIdentity({ kind, evalCase, trial });
}

export function resolveEvalIdentityKind(
  evalCase: Pick<EvalCase, "tags" | "id">,
): EvalIdentityKind | undefined {
  for (const tag of evalCase.tags) {
    if (tag === "identity:recognize-same" || tag === "recognize-same") {
      return "recognize-same";
    }
    if (tag === "identity:keep-distinct" || tag === "keep-distinct") {
      return "keep-distinct";
    }
  }
  return undefined;
}

function scoreRecognizeSame(
  evalCase: ScoreEvalIdentityInput["evalCase"],
  steps: EvalIdentityStepResult[],
): EvalIdentityScore {
  if (steps.length < 2) {
    return aggregateIdentityAnchors("recognize-same", [], "insufficient identity steps");
  }

  const seed = steps[0]!;
  const later = steps[steps.length - 1]!;
  const seedExpected = evalCase.steps[0]?.expected ?? [];
  const laterStepExpected = evalCase.steps[later.step]?.expected ?? [];
  const laterExpected = laterStepExpected.length > 0 ? laterStepExpected : seedExpected;
  const anchorCount = Math.min(seedExpected.length, laterExpected.length);

  if (anchorCount === 0) {
    return aggregateIdentityAnchors("recognize-same", [], "no identity anchors");
  }

  const anchors: EvalIdentityAnchorResult[] = [];

  for (let expectedIndex = 0; expectedIndex < anchorCount; expectedIndex++) {
    const seedEntry = seedExpected[expectedIndex];
    const laterEntry = laterExpected[expectedIndex] ?? seedEntry;
    if (!seedEntry || !laterEntry) {
      continue;
    }

    const seedMatch = firstMatch(seedEntry, seed.findings);
    const laterMatch = firstMatch(laterEntry, later.findings);

    if (seedMatch === undefined || laterMatch === undefined) {
      anchors.push({
        expectedIndex,
        step: later.step,
        status: "na",
        reason: "detection miss",
      });
      continue;
    }

    const seedFingerprint = seed.fingerprints[seedMatch];
    const seedDurableId = seed.durableIds[seedMatch];
    const laterFingerprint = later.fingerprints[laterMatch];
    const laterDurableId = later.durableIds[laterMatch];
    const classification = later.classifications[laterMatch];

    const continuityPass =
      classification === "existing" ||
      classification === "regressed" ||
      (laterDurableId === seedDurableId && laterFingerprint === seedFingerprint);

    const identityBreak =
      classification === "new" &&
      laterDurableId !== undefined &&
      seedDurableId !== undefined &&
      laterDurableId !== seedDurableId;

    anchors.push({
      expectedIndex,
      step: later.step,
      status: continuityPass ? "pass" : "fail",
      reason: continuityPass
        ? undefined
        : identityBreak
          ? "later finding classified as new with different durable id"
          : "identity continuity broken",
      fingerprint: laterFingerprint,
      durableId: laterDurableId,
      classification,
    });
  }

  return aggregateIdentityAnchors("recognize-same", anchors);
}

function scoreKeepDistinct(
  evalCase: ScoreEvalIdentityInput["evalCase"],
  steps: EvalIdentityStepResult[],
  minDistinct: number,
): EvalIdentityScore {
  const last = steps[steps.length - 1]!;
  const expected = resolveKeepDistinctExpected(evalCase, last);
  const anchors: EvalIdentityAnchorResult[] = [];
  const hits: Array<{ fingerprint: string; durableId: string }> = [];

  for (let expectedIndex = 0; expectedIndex < expected.length; expectedIndex++) {
    const expectedEntry = expected[expectedIndex];
    if (!expectedEntry) {
      continue;
    }

    const matchIndex = firstMatch(expectedEntry, last.findings);
    if (matchIndex === undefined) {
      anchors.push({
        expectedIndex,
        step: last.step,
        status: "na",
        reason: "detection miss",
      });
      continue;
    }

    const fingerprint = last.fingerprints[matchIndex];
    const durableId = last.durableIds[matchIndex];
    const classification = last.classifications[matchIndex];

    if (fingerprint === undefined || durableId === undefined) {
      anchors.push({
        expectedIndex,
        step: last.step,
        status: "na",
        reason: "detection miss",
      });
      continue;
    }

    hits.push({ fingerprint, durableId });
    anchors.push({
      expectedIndex,
      step: last.step,
      status: "pass",
      fingerprint,
      durableId,
      classification,
    });
  }

  if (anchors.length === 0) {
    return aggregateIdentityAnchors("keep-distinct", [], "no identity anchors");
  }

  if (hits.length < minDistinct) {
    return aggregateIdentityAnchors(
      "keep-distinct",
      anchors,
      "insufficient detected anchors",
    );
  }

  const duplicateFingerprint = hasDuplicate(hits.map((hit) => hit.fingerprint));
  const duplicateDurableId = hasDuplicate(hits.map((hit) => hit.durableId));

  if (duplicateFingerprint || duplicateDurableId) {
    for (const anchor of anchors) {
      if (anchor.status !== "pass") {
        continue;
      }
      anchor.status = "fail";
      anchor.reason = duplicateFingerprint
        ? "duplicate fingerprint among detected anchors"
        : "duplicate durable id among detected anchors";
    }
    return aggregateIdentityAnchors("keep-distinct", anchors);
  }

  return aggregateIdentityAnchors("keep-distinct", anchors);
}

function resolveKeepDistinctExpected(
  evalCase: ScoreEvalIdentityInput["evalCase"],
  step: EvalIdentityStepResult,
): EvalExpectedFinding[] {
  const stepExpected = evalCase.steps[step.step]?.expected ?? [];
  return stepExpected.length > 0 ? stepExpected : evalCase.expected;
}

function firstMatch(
  expected: EvalExpectedFinding,
  findings: ReviewFinding[],
): number | undefined {
  for (let index = 0; index < findings.length; index++) {
    const finding = findings[index];
    if (finding && findingMatchesExpected(expected, finding)) {
      return index;
    }
  }
  return undefined;
}

function hasDuplicate(values: string[]): boolean {
  return new Set(values).size !== values.length;
}

function aggregateIdentityAnchors(
  kind: EvalIdentityKind,
  anchors: EvalIdentityAnchorResult[],
  wholeNaReason?: string,
): EvalIdentityScore {
  if (wholeNaReason) {
    return {
      kind,
      passed: true,
      naReason: wholeNaReason,
      detail: {
        summary: wholeNaReason,
        anchors,
      },
    };
  }

  if (anchors.length === 0) {
    return {
      kind,
      passed: true,
      naReason: "no identity anchors",
      detail: {
        summary: "no identity anchors",
        anchors,
      },
    };
  }

  if (anchors.every((anchor) => anchor.status === "na")) {
    const naReason = anchors[0]?.reason ?? "all anchors undetected";
    return {
      kind,
      passed: true,
      naReason,
      detail: {
        summary: naReason,
        anchors,
      },
    };
  }

  if (anchors.some((anchor) => anchor.status === "fail")) {
    const failCount = anchors.filter((anchor) => anchor.status === "fail").length;
    return {
      kind,
      passed: false,
      detail: {
        summary: `${failCount} anchor(s) failed identity check`,
        anchors,
      },
    };
  }

  const passCount = anchors.filter((anchor) => anchor.status === "pass").length;
  return {
    kind,
    passed: true,
    detail: {
      summary: `${passCount} anchor(s) passed identity check`,
      anchors,
    },
  };
}
