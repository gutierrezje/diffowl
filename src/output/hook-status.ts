import type { HookStatus, PendingReview } from "../git/hooks.js";

const HOOK_STATUS_SCHEMA_VERSION = 1 as const;

export function renderHookStatusJson(
  hook: HookStatus,
  pending: readonly PendingReview[],
): string {
  const firstAttemptCount = pending.filter((item) => item.attempt === "first-attempt").length;

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
        retry_count: pending.length - firstAttemptCount,
        items: pending.map((item) => ({
          commit: item.sha,
          queued_at: item.queuedAt,
          status:
            item.attempt === "first-attempt" ? "pending-first-attempt" : "pending-retry",
        })),
      },
    },
    null,
    2,
  )}\n`;
}

export function formatPendingReview(item: PendingReview): string {
  const label = item.attempt === "first-attempt" ? "First attempt" : "Retry";
  return `${label}: ${item.sha} (queued ${item.queuedAt})`;
}
