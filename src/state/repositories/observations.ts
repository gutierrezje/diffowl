import type Database from "better-sqlite3";
import type {
  FindingObservationRecord,
  InsertObservationInput,
} from "../types.js";

const insertObservationStatement = (db: Database.Database) =>
  db.prepare(`
    INSERT INTO finding_observations (
      review_id,
      finding_id,
      file,
      line,
      severity,
      confidence,
      title,
      body,
      evidence,
      ordinal,
      classification
    ) VALUES (
      @reviewId,
      @findingId,
      @file,
      @line,
      @severity,
      @confidence,
      @title,
      @body,
      @evidence,
      @ordinal,
      @classification
    )
  `);

const getObservationStatement = (db: Database.Database) =>
  db.prepare(`
    SELECT
      id,
      review_id AS reviewId,
      finding_id AS findingId,
      file,
      line,
      severity,
      confidence,
      title,
      body,
      evidence,
      ordinal,
      classification
    FROM finding_observations
    WHERE review_id = ? AND finding_id = ?
  `);

type ObservationRow = FindingObservationRecord;

export function insertObservation(
  db: Database.Database,
  input: InsertObservationInput,
): FindingObservationRecord {
  insertObservationStatement(db).run({
    reviewId: input.reviewId,
    findingId: input.findingId,
    file: input.file,
    line: input.line,
    severity: input.severity,
    confidence: input.confidence,
    title: input.title,
    body: input.body,
    evidence: input.evidence ?? null,
    ordinal: input.ordinal,
    classification: input.classification,
  });

  const observation = getObservationStatement(db).get(input.reviewId, input.findingId) as
    | ObservationRow
    | undefined;
  if (!observation) {
    throw new Error(`Failed to load observation for review ${input.reviewId}.`);
  }

  return observation;
}

export function listObservationsForReview(
  db: Database.Database,
  reviewId: string,
): FindingObservationRecord[] {
  return db
    .prepare(`
      SELECT
        id,
        review_id AS reviewId,
        finding_id AS findingId,
        file,
        line,
        severity,
        confidence,
        title,
        body,
        evidence,
        ordinal,
        classification
      FROM finding_observations
      WHERE review_id = ?
      ORDER BY ordinal ASC
    `)
    .all(reviewId) as FindingObservationRecord[];
}
