import type { SqliteDatabase } from "./sqlite.js";
import { computeFindingFingerprint, deduplicateFindingCandidates } from "./fingerprint.js";
import { insertFindingEvent } from "./repositories/events.js";
import { getFindingByFingerprint, insertFinding, updateFinding } from "./repositories/findings.js";
import { insertObservation } from "./repositories/observations.js";
import type {
  FindingCandidate,
  FindingStatus,
  ObservationClassification,
  ReconcileReviewFindingsResult,
} from "./types.js";

export function reconcileReviewFindings(
  db: SqliteDatabase,
  reviewId: string,
  candidates: FindingCandidate[],
): ReconcileReviewFindingsResult {
  const observations: ReconcileReviewFindingsResult["observations"] = [];
  const suppressedCounts = { dismissed: 0, deferred: 0 };
  const uniqueCandidates = deduplicateFindingCandidates(candidates);

  for (const [index, candidate] of uniqueCandidates.entries()) {
    const fingerprint = computeFindingFingerprint(candidate);
    if (fingerprint === null) {
      continue;
    }
    const existing = getFindingByFingerprint(db, fingerprint);
    const timestamp = new Date().toISOString();

    let finding = existing;
    let classification: ObservationClassification;
    let suppressed = false;

    if (!finding) {
      finding = insertFinding(db, {
        fingerprint,
        status: "open",
        firstReviewId: reviewId,
        lastReviewId: reviewId,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      classification = "new";
    } else if (finding.status === "open" || finding.status === "regressed") {
      finding = updateFinding(db, finding.id, {
        status: finding.status,
        lastReviewId: reviewId,
        updatedAt: timestamp,
      });
      classification = "existing";
    } else if (finding.status === "deferred" || finding.status === "dismissed") {
      finding = updateFinding(db, finding.id, {
        status: finding.status,
        lastReviewId: reviewId,
        updatedAt: timestamp,
      });
      classification = "existing";
      suppressed = true;
      if (finding.status === "dismissed") {
        suppressedCounts.dismissed++;
      } else {
        suppressedCounts.deferred++;
      }
    } else {
      finding = updateFinding(db, finding.id, {
        status: "regressed",
        lastReviewId: reviewId,
        updatedAt: timestamp,
      });
      classification = "regressed";
      insertFindingEvent(db, {
        findingId: finding.id,
        reviewId,
        eventType: "regressed",
        actor: "agent",
        reason: "Finding reappeared after being marked fixed.",
      });
    }

    insertFindingEvent(db, {
      findingId: finding.id,
      reviewId,
      eventType: "observed",
      actor: "agent",
    });

    const observation = insertObservation(db, {
      reviewId,
      findingId: finding.id,
      file: candidate.file,
      line: candidate.line,
      severity: candidate.severity,
      confidence: candidate.confidence,
      title: candidate.title,
      body: candidate.body,
      evidence: candidate.evidence ?? null,
      ordinal: index + 1,
      classification,
    });

    observations.push({
      observation,
      finding,
      fingerprint,
      suppressed,
    });
  }

  return { observations, suppressedCounts };
}

export function isActionableStatus(status: FindingStatus): boolean {
  return status === "open" || status === "regressed";
}
