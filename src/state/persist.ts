import { createHash } from "node:crypto";
import type { ReviewFinding, ReviewTiming } from "../review/types.js";
import { closeStateDatabase, openStateDatabase, runInTransaction } from "./db.js";
import { computeFindingFingerprint } from "./fingerprint.js";
import { reconcileReviewFindings } from "./reconcile.js";
import { getReviewById, insertReview, updateReview } from "./repositories/reviews.js";
import { countObservationsByFindingIds } from "./repositories/observations.js";
import type {
  FindingCandidate,
  ReconcileReviewFindingsResult,
  ReviewTargetKind,
  ReviewRecord,
} from "./types.js";

export interface PersistReviewRunInput {
  targetKind: ReviewTargetKind;
  targetRef: string | null;
  targetCommit: string | null;
  diffHash: string;
  model: string;
  reasoning: string;
  depth: string;
  sessionId: string;
  summary: string;
  diagnostics: string[];
  timings: ReviewTiming[];
  findings: ReviewFinding[];
  skippedReason?: string | null;
}

export interface PersistReviewRunResult {
  reviewId: string;
  reconcile: ReconcileReviewFindingsResult;
  actionableFindings: ReviewFinding[];
  lifecycleSuppressedFindings: ReviewFinding[];
  identityDiagnostics: string[];
}

export interface UpdatePersistedReviewInput {
  reportPath?: string | null;
  diagnostics?: string[];
}

export function computeDiffHash(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export function deduplicateReviewFindings(findings: ReviewFinding[]): ReviewFinding[] {
  const seen = new Set<string>();
  const deduped: ReviewFinding[] = [];

  for (const finding of findings) {
    const fingerprint = computeFindingFingerprint(toFindingCandidate(finding));
    if (fingerprint === null || seen.has(fingerprint)) {
      continue;
    }
    seen.add(fingerprint);
    deduped.push(finding);
  }

  return deduped;
}

export function toFindingCandidate(finding: ReviewFinding): FindingCandidate {
  const candidate: FindingCandidate = {
    file: finding.file,
    line: finding.line,
    severity: finding.severity,
    confidence: finding.confidence,
    title: finding.title,
    body: finding.body,
  };
  if (finding.evidence !== undefined) {
    candidate.evidence = finding.evidence;
  }
  return candidate;
}

export function formatLifecycleSuppressedSummary(counts: {
  dismissed: number;
  deferred: number;
}): string | null {
  const parts: string[] = [];
  if (counts.dismissed > 0) {
    parts.push(`${counts.dismissed} dismissed`);
  }
  if (counts.deferred > 0) {
    parts.push(`${counts.deferred} deferred`);
  }
  if (parts.length === 0) {
    return null;
  }
  return `Suppressed ${parts.join(" and ")} previously resolved finding(s).`;
}

export function splitFindingsByLifecycleSuppression(
  findings: ReviewFinding[],
  reconcile: ReconcileReviewFindingsResult,
): {
  actionableFindings: ReviewFinding[];
  lifecycleSuppressedFindings: ReviewFinding[];
} {
  const fingerprintedFindings = fingerprintUniqueReviewFindings(findings);
  const findingsByFingerprint = new Map<string, ReviewFinding>();
  for (const { finding, fingerprint } of fingerprintedFindings) {
    findingsByFingerprint.set(fingerprint, finding);
  }

  const actionableFindings: ReviewFinding[] = [];
  const lifecycleSuppressedFindings: ReviewFinding[] = [];
  const matchedFingerprints = new Set<string>();

  for (const observation of reconcile.observations) {
    const finding = findingsByFingerprint.get(observation.fingerprint);
    if (!finding) {
      continue;
    }
    matchedFingerprints.add(observation.fingerprint);
    if (observation.suppressed) {
      lifecycleSuppressedFindings.push(finding);
    } else {
      actionableFindings.push(finding);
    }
  }

  for (const { finding, fingerprint } of fingerprintedFindings) {
    if (!matchedFingerprints.has(fingerprint)) {
      actionableFindings.push(finding);
    }
  }

  return { actionableFindings, lifecycleSuppressedFindings };
}

function fingerprintUniqueReviewFindings(
  findings: ReviewFinding[],
): { finding: ReviewFinding; fingerprint: string }[] {
  const seen = new Set<string>();
  const fingerprinted: { finding: ReviewFinding; fingerprint: string }[] = [];

  for (const finding of findings) {
    const fingerprint = computeFindingFingerprint(toFindingCandidate(finding));
    if (fingerprint === null || seen.has(fingerprint)) {
      continue;
    }
    seen.add(fingerprint);
    fingerprinted.push({ finding, fingerprint });
  }

  return fingerprinted;
}

export function enrichReviewFindingsWithDurableMetadata(
  findings: ReviewFinding[],
  reconcile: ReconcileReviewFindingsResult,
): ReviewFinding[] {
  const observationsByFingerprint = new Map(
    reconcile.observations.map((item) => [item.fingerprint, item]),
  );

  return findings.map((finding) => {
    const fingerprint = computeFindingFingerprint(toFindingCandidate(finding));
    if (fingerprint === null) {
      return finding;
    }
    const observation = observationsByFingerprint.get(fingerprint);
    if (!observation) {
      return finding;
    }

    return {
      ...finding,
      durable: {
        id: observation.finding.id,
        classification: observation.observation.classification,
        status: observation.finding.status,
        lifecycleSuppressed: observation.suppressed,
      },
    };
  });
}

export async function persistReviewRun(
  diffOwlDir: string,
  input: PersistReviewRunInput,
): Promise<PersistReviewRunResult> {
  const state = await openStateDatabase(diffOwlDir);

  try {
    return runInTransaction(state.db, () => {
      const review = insertReview(state.db, {
        targetKind: input.targetKind,
        targetRef: input.targetRef,
        targetCommit: input.targetCommit,
        diffHash: input.diffHash,
        model: input.model,
        reasoning: input.reasoning,
        depth: input.depth,
        sessionId: input.sessionId,
        summary: input.summary,
        diagnostics: input.diagnostics,
        timings: input.timings,
        skippedReason: input.skippedReason ?? null,
      });

      const identifiable: ReviewFinding[] = [];
      const untracked: ReviewFinding[] = [];
      for (const finding of input.findings) {
        if (computeFindingFingerprint(toFindingCandidate(finding)) === null) {
          untracked.push(finding);
        } else {
          identifiable.push(finding);
        }
      }

      const uniqueIdentifiable = deduplicateReviewFindings(identifiable);
      const mergeCount = identifiable.length - uniqueIdentifiable.length;
      const reconcile = reconcileReviewFindings(
        state.db,
        review.id,
        uniqueIdentifiable.map(toFindingCandidate),
      );
      const { actionableFindings, lifecycleSuppressedFindings } =
        splitFindingsByLifecycleSuppression(uniqueIdentifiable, reconcile);

      const identityDiagnostics: string[] = [];
      if (untracked.length > 0) {
        identityDiagnostics.push(
          `${untracked.length} finding(s) quoted no code and were not tracked.`,
        );
      }
      if (mergeCount > 0) {
        identityDiagnostics.push(
          `${mergeCount} reported finding(s) shared a code anchor and were merged into one.`,
        );
      }

      return {
        reviewId: review.id,
        reconcile,
        actionableFindings: [...actionableFindings, ...untracked],
        lifecycleSuppressedFindings,
        identityDiagnostics,
      };
    });
  } finally {
    closeStateDatabase(state);
  }
}

export async function updatePersistedReview(
  diffOwlDir: string,
  reviewId: string,
  input: UpdatePersistedReviewInput,
): Promise<void> {
  const state = await openStateDatabase(diffOwlDir);

  try {
    runInTransaction(state.db, () => {
      updateReview(state.db, reviewId, {
        ...(input.reportPath !== undefined ? { reportPath: input.reportPath } : {}),
        ...(input.diagnostics !== undefined ? { diagnostics: input.diagnostics } : {}),
      });
    });
  } finally {
    closeStateDatabase(state);
  }
}

export async function getPersistedReview(
  diffOwlDir: string,
  reviewId: string,
): Promise<ReviewRecord | undefined> {
  const state = await openStateDatabase(diffOwlDir);
  try {
    return getReviewById(state.db, reviewId);
  } finally {
    closeStateDatabase(state);
  }
}

export async function loadFindingOccurrenceCounts(
  diffOwlDir: string,
  findingIds: string[],
): Promise<Map<string, number>> {
  const state = await openStateDatabase(diffOwlDir);
  try {
    return countObservationsByFindingIds(state.db, findingIds);
  } finally {
    closeStateDatabase(state);
  }
}

export function mapReviewTarget(target: {
  kind: "staged" | "last-commit" | "commit" | "base";
  ref?: string;
}): { targetKind: ReviewTargetKind; targetRef: string | null } {
  switch (target.kind) {
    case "staged":
      return { targetKind: "staged", targetRef: null };
    case "last-commit":
      return { targetKind: "last-commit", targetRef: null };
    case "commit":
      return { targetKind: "commit", targetRef: target.ref ?? null };
    case "base":
      return { targetKind: "base", targetRef: target.ref ?? null };
  }
}
