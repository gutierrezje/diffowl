import type { HookStatus, PendingReview } from "../git/hooks.js";

const HOOK_STATUS_SCHEMA_VERSION = 1 as const;

export function renderHookStatusJson(
  hook: HookStatus,
  pending: readonly PendingReview[],
): string {
  const queued = pending.filter((item) => item.state === "pending");
  const firstAttemptCount = queued.filter((item) => item.attempt === "first-attempt").length;

  return `${JSON.stringify(
    {
      schema_version: HOOK_STATUS_SCHEMA_VERSION,
      hook: {
        installed: hook.installed,
        stale: hook.stale,
        reason: hook.reason ?? null,
      },
      queue: {
        pending_count: pending.length,
        first_attempt_count: firstAttemptCount,
        retry_count: queued.length - firstAttemptCount,
        in_progress_count: pending.length - queued.length,
        items: pending.map((item) => ({
          commit: item.sha,
          queued_at: item.queuedAt,
          status: item.state === "in-progress"
            ? "in-progress"
            : item.attempt === "first-attempt"
              ? "pending-first-attempt"
              : "pending-retry",
        })),
      },
    },
    null,
    2,
  )}\n`;
}

export function formatPendingReview(item: PendingReview): string {
  if (item.state === "in-progress") {
    return `In progress: ${item.sha} (queued ${item.queuedAt})`;
  }
  const label = item.attempt === "first-attempt" ? "First attempt" : "Retry";
  return `${label}: ${item.sha} (queued ${item.queuedAt})`;
}
