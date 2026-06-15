import { createHash } from "node:crypto";
import type { FindingCandidate } from "./types.js";

export const FINGERPRINT_VERSION = 1;

export interface FindingFingerprintInput {
  file: string;
  title: string;
  body: string;
  evidence?: string;
}

export function normalizeFingerprintText(text: string): string {
  return text.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");
}

export function computeFindingFingerprint(input: FindingFingerprintInput): string {
  const file = normalizeFingerprintText(input.file);
  const title = normalizeFingerprintText(input.title);
  const identitySource = input.evidence?.trim() ? input.evidence : input.body;
  const identity = normalizeFingerprintText(identitySource);
  const payload = `v${FINGERPRINT_VERSION}|${file}|${title}|${identity}`;
  const digest = createHash("sha256").update(payload, "utf8").digest("hex");
  return `v${FINGERPRINT_VERSION}:${digest}`;
}

export function deduplicateFindingCandidates(candidates: FindingCandidate[]): FindingCandidate[] {
  const seen = new Set<string>();
  const deduped: FindingCandidate[] = [];

  for (const candidate of candidates) {
    const fingerprint = computeFindingFingerprint(candidate);
    if (seen.has(fingerprint)) {
      continue;
    }
    seen.add(fingerprint);
    deduped.push(candidate);
  }

  return deduped;
}
