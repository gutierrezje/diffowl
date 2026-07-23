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
  evalCase: Pick<EvalCase, "id" | "expected" | "steps" | "tags" | "identity">;
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
    Math.max(2, resolveStepExpected(evalCase, steps[steps.length - 1]!.step).length);
  return scoreKeepDistinct(evalCase, steps, minDistinct);
}

export function tryScoreEvalIdentity(
  evalCase: Pick<EvalCase, "id" | "expected" | "steps" | "tags" | "identity">,
  run: { trials: Array<Pick<EvalTrialResult, "identitySteps" | "error" | "trial">> },
): EvalIdentityScore | undefined {
  const kind = resolveEvalIdentityKind(evalCase);
  if (!kind) {
    return undefined;
  }

  // Prefer the first trial that actually produced identity steps. Trial 0 may
  // be a transport error while later trials completed the multi-step path.
  const trial = run.trials.find((candidate) => (candidate.identitySteps?.length ?? 0) > 0);
  if (!trial) {
    return undefined;
  }

  return scoreEvalIdentity({
    kind,
    evalCase,
    trial,
    ...(evalCase.identity?.min_distinct !== undefined
      ? { minDistinct: evalCase.identity.min_distinct }
      : {}),
  });
}

export function resolveEvalIdentityKind(
  evalCase: Pick<EvalCase, "tags" | "id" | "identity">,
): EvalIdentityKind | undefined {
  if (evalCase.identity) {
    return evalCase.identity.kind;
  }

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
  const seedExpected = resolveStepExpected(evalCase, seed.step);
  // Later prefers its own step expected, then seed's resolved expected.
  // Do not jump to top-level expected while seed has step-specific anchors.
  const laterStepExpected = evalCase.steps[later.step]?.expected ?? [];
  const laterExpected =
    laterStepExpected.length > 0 ? laterStepExpected : seedExpected;
  const anchorCount = Math.min(seedExpected.length, laterExpected.length);

  if (anchorCount === 0) {
    return aggregateIdentityAnchors("recognize-same", [], "no identity anchors");
  }

  const anchors: EvalIdentityAnchorResult[] = [];
  const usedSeedIndices = new Set<number>();
  const usedLaterIndices = new Set<number>();

  for (let expectedIndex = 0; expectedIndex < anchorCount; expectedIndex++) {
    const seedEntry = seedExpected[expectedIndex];
    const laterEntry = laterExpected[expectedIndex] ?? seedEntry;
    if (!seedEntry || !laterEntry) {
      continue;
    }

    const seedMatch = firstMatch(seedEntry, seed.findings, usedSeedIndices);
    const laterMatch = firstMatch(laterEntry, later.findings, usedLaterIndices);

    if (seedMatch === undefined || laterMatch === undefined) {
      anchors.push({
        expectedIndex,
        step: later.step,
        status: "na",
        reason: "detection miss",
      });
      continue;
    }

    usedSeedIndices.add(seedMatch);
    usedLaterIndices.add(laterMatch);

    const seedObservation = observationAt(seed, seedMatch);
    const laterObservation = observationAt(later, laterMatch);
    if (!seedObservation || !laterObservation) {
      anchors.push({
        expectedIndex,
        step: later.step,
        status: "na",
        reason: "detection miss",
      });
      continue;
    }

    const { durableId: seedDurableId } = seedObservation;
    const {
      fingerprint: laterFingerprint,
      durableId: laterDurableId,
      classification,
    } = laterObservation;

    // Classification alone is not continuity: `existing` means "seen before in
    // the DB", not "same as this seed anchor". Durable id is the identity key.
    const continuityPass = laterDurableId === seedDurableId;

    anchors.push({
      expectedIndex,
      step: later.step,
      status: continuityPass ? "pass" : "fail",
      reason: continuityPass
        ? undefined
        : "later finding has different durable id from seed",
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
  const expected = resolveStepExpected(evalCase, last.step);
  const anchors: EvalIdentityAnchorResult[] = [];
  const hits: Array<{ fingerprint: string; durableId: string }> = [];
  const usedIndices = new Set<number>();

  for (let expectedIndex = 0; expectedIndex < expected.length; expectedIndex++) {
    const expectedEntry = expected[expectedIndex];
    if (!expectedEntry) {
      continue;
    }

    const matchIndex = firstMatch(expectedEntry, last.findings, usedIndices);
    if (matchIndex === undefined) {
      anchors.push({
        expectedIndex,
        step: last.step,
        status: "na",
        reason: "detection miss",
      });
      continue;
    }

    const observation = observationAt(last, matchIndex);
    if (!observation) {
      anchors.push({
        expectedIndex,
        step: last.step,
        status: "na",
        reason: "detection miss",
      });
      continue;
    }

    const { fingerprint, durableId, classification } = observation;

    usedIndices.add(matchIndex);
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
    const reason = duplicateFingerprint
      ? "duplicate fingerprint among detected anchors"
      : "duplicate durable id among detected anchors";
    const failedAnchors = anchors.map((anchor) =>
      anchor.status === "pass" ? { ...anchor, status: "fail" as const, reason } : anchor,
    );
    return aggregateIdentityAnchors("keep-distinct", failedAnchors);
  }

  return aggregateIdentityAnchors("keep-distinct", anchors);
}

function resolveStepExpected(
  evalCase: ScoreEvalIdentityInput["evalCase"],
  stepIndex: number,
): EvalExpectedFinding[] {
  const stepExpected = evalCase.steps[stepIndex]?.expected ?? [];
  return stepExpected.length > 0 ? stepExpected : evalCase.expected;
}

function observationAt(
  step: EvalIdentityStepResult,
  findingIndex: number,
):
  | {
      fingerprint: string;
      durableId: string;
      classification: "new" | "existing" | "regressed";
    }
  | undefined {
  const finding = step.findings[findingIndex];
  if (!finding) {
    return undefined;
  }

  // Prefer durable metadata on the finding. Parallel arrays can diverge when
  // built from fingerprint-deduped reconcile observations.
  if (finding.durable) {
    let fingerprint = step.fingerprints[findingIndex];
    if (!fingerprint || step.durableIds[findingIndex] !== finding.durable.id) {
      const byDurableId = step.durableIds.indexOf(finding.durable.id);
      fingerprint = byDurableId >= 0 ? step.fingerprints[byDurableId] : undefined;
    }
    if (!fingerprint) {
      return undefined;
    }
    return {
      fingerprint,
      durableId: finding.durable.id,
      classification: finding.durable.classification,
    };
  }

  const fingerprint = step.fingerprints[findingIndex];
  const durableId = step.durableIds[findingIndex];
  const classification = step.classifications[findingIndex];
  if (!fingerprint || !durableId || !classification) {
    return undefined;
  }
  return { fingerprint, durableId, classification };
}

function firstMatch(
  expected: EvalExpectedFinding,
  findings: ReviewFinding[],
  usedIndices?: Set<number>,
): number | undefined {
  for (let index = 0; index < findings.length; index++) {
    if (usedIndices?.has(index)) {
      continue;
    }
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

/** Detection misses are n/a (`passed: true` + `naReason`), never identity failures. */
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
