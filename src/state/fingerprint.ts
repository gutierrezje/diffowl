import { createHash } from "node:crypto";
import type { FindingCandidate } from "./types.js";

export const FINGERPRINT_VERSION = 2;

export interface FindingFingerprintInput {
  file: string;
  evidence?: string;
}

export function normalizeFingerprintText(text: string): string {
  return text.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");
}

export function computeFindingFingerprint(input: FindingFingerprintInput): string | null {
  // Quoted evidence is the identity. Prose without a quote is untracked, not hashed.
  if (input.evidence === undefined) {
    return null;
  }
  const evidence = normalizeFingerprintText(input.evidence);
  if (evidence === "") {
    return null;
  }
  const file = normalizeFingerprintText(input.file);
  const payload = `v${FINGERPRINT_VERSION}|${file}|${evidence}`;
  const digest = createHash("sha256").update(payload, "utf8").digest("hex");
  return `v${FINGERPRINT_VERSION}:${digest}`;
}

export function deduplicateFindingCandidates(candidates: FindingCandidate[]): FindingCandidate[] {
  const seen = new Set<string>();
  const deduped: FindingCandidate[] = [];

  for (const candidate of candidates) {
    const fingerprint = computeFindingFingerprint(candidate);
    if (fingerprint === null || seen.has(fingerprint)) {
      continue;
    }
    seen.add(fingerprint);
    deduped.push(candidate);
  }

  return deduped;
}
