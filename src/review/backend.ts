/**
 * SPIKE(pi-backend): review backend selection.
 *
 * DiffOwl's committed backend is OpenCode; "pi" exists to measure the pi
 * coding agent SDK against it (see plans/024-pi-backend-spike.md). Selection
 * is per-invocation (flag or DIFFOWL_BACKEND env var), never persisted to
 * .diffowl.yml, so the spike leaves no config-surface residue.
 */
import { z } from "zod";
import type { DiffOwlConfig } from "../config.js";
import { runReview, type ReviewOptions, type ReviewResult } from "../opencode/client.js";
import { ensureServer, getInstalledOpencodeVersion, isServerRunning } from "../opencode/server.js";
import { runReviewWithPi } from "../pi/backend.js";
import { getInstalledPiVersion } from "../pi/session.js";

export const ReviewBackendNameSchema = z.enum(["opencode", "pi"]);

export type ReviewBackendName = z.output<typeof ReviewBackendNameSchema>;

export interface ReviewBackend {
  name: ReviewBackendName;
  /** One-time preparation before reviews run (e.g. server startup). */
  prepare(config: DiffOwlConfig): Promise<void>;
  runReview(options: ReviewOptions): Promise<ReviewResult>;
  version(): Promise<string | null>;
}

const opencodeBackend: ReviewBackend = {
  name: "opencode",
  async prepare(config) {
    if (config.server.auto_start) {
      await ensureServer(config.server.port);
      return;
    }
    if (await isServerRunning(config.server.port)) {
      return;
    }
    throw new Error(
      `OpenCode server is not running on port ${config.server.port}. Start it with \`diffowl server start\` or set server.auto_start: true.`,
    );
  },
  runReview,
  version: getInstalledOpencodeVersion,
};

const piBackend: ReviewBackend = {
  name: "pi",
  async prepare() {
    // pi runs in-process: no server lifecycle. Auth/model problems surface
    // as descriptive errors from the first review instead.
  },
  runReview: (options) => runReviewWithPi(options),
  version: getInstalledPiVersion,
};

const backends: Record<ReviewBackendName, ReviewBackend> = {
  opencode: opencodeBackend,
  pi: piBackend,
};

export function parseReviewBackendName(value: unknown): ReviewBackendName {
  const parsed = ReviewBackendNameSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Unknown review backend "${String(value)}". Expected one of: ${ReviewBackendNameSchema.options.join(", ")}.`,
    );
  }
  return parsed.data;
}

/**
 * Resolve the backend from an explicit name, then DIFFOWL_BACKEND, then the
 * OpenCode default. Invalid values fail loudly rather than silently reviewing
 * with the wrong harness.
 */
export function resolveReviewBackend(explicit?: string): ReviewBackend {
  const fromEnv = process.env["DIFFOWL_BACKEND"]?.trim();
  const name = explicit?.trim() || fromEnv || "opencode";
  return backends[parseReviewBackendName(name)];
}
