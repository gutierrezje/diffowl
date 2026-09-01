import { z } from "zod";
import {
  ReviewExecutionTerminalOutcomeSchema,
  type ReviewExecutionTerminalOutcome,
} from "./provenance.js";

export const REVIEW_EXECUTION_TELEMETRY_SCHEMA_VERSION = 1 as const;
export const REVIEW_EXECUTION_STALL_INTERVAL_MS = 30_000;

export const ReviewExecutionPhaseSchema = z.enum([
  "context-build",
  "protocol-check",
  "turn-start",
  "provider-work",
  "tool-activity",
  "validation-repair",
  "persistence",
  "completion",
]);

const ReviewExecutionTransitionSchema = z
  .object({
    sequence: z.number().int().positive(),
    phase: ReviewExecutionPhaseSchema,
    attempt: z.number().int().positive().nullable(),
    startedAt: z.string(),
    elapsedMs: z.number().nonnegative(),
    durationMs: z.number().nonnegative(),
  })
  .strict();

export const ReviewExecutionTelemetrySchema = z
  .object({
    schemaVersion: z.literal(REVIEW_EXECUTION_TELEMETRY_SCHEMA_VERSION),
    stallIntervalMs: z.number().positive(),
    startedAt: z.string(),
    updatedAt: z.string(),
    completedAt: z.string().nullable(),
    activePhase: ReviewExecutionPhaseSchema.nullable(),
    terminal: z
      .object({
        outcome: ReviewExecutionTerminalOutcomeSchema,
        phase: ReviewExecutionPhaseSchema.nullable(),
        at: z.string(),
      })
      .strict()
      .nullable(),
    transitions: ReviewExecutionTransitionSchema.array(),
    activity: z
      .object({
        status: z.enum(["silent", "active", "stalled"]),
        count: z.number().int().nonnegative(),
        toolCount: z.number().int().nonnegative(),
        firstAt: z.string().nullable(),
        lastAt: z.string().nullable(),
        ageMs: z.number().nonnegative(),
      })
      .strict(),
    provider: z
      .object({
        queueWaitMs: z.number().nonnegative(),
        executionMs: z.number().nonnegative(),
      })
      .strict(),
    validation: z
      .object({
        attempts: z.number().int().nonnegative(),
        repairs: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export type ReviewExecutionPhase = z.output<typeof ReviewExecutionPhaseSchema>;
export type ReviewExecutionTelemetry = z.output<typeof ReviewExecutionTelemetrySchema>;

export type ReviewExecutionTelemetryEvent =
  | { type: "phase"; phase: ReviewExecutionPhase; attempt?: number }
  | { type: "activity"; activity: "provider" | "tool" }
  | { type: "validation"; outcome: "accepted" | "retry" | "failed" }
  | { type: "terminal"; outcome: ReviewExecutionTerminalOutcome };

export interface ReviewExecutionTelemetryClock {
  read(): { wallTime: string; elapsedMs: number };
}

export interface ReviewExecutionTelemetryTracker {
  record(event: ReviewExecutionTelemetryEvent): void;
  snapshot(): ReviewExecutionTelemetry;
}

export function finishPersistedReviewExecutionTelemetry(
  telemetry: ReviewExecutionTelemetry,
  outcome: ReviewExecutionTerminalOutcome,
  completedAt = new Date().toISOString(),
): ReviewExecutionTelemetry {
  const terminalElapsedMs = Math.max(
    telemetry.transitions.at(-1)?.elapsedMs ?? 0,
    Date.parse(completedAt) - Date.parse(telemetry.startedAt),
  );
  const elapsedSinceUpdateMs = Math.max(
    0,
    terminalElapsedMs - (Date.parse(telemetry.updatedAt) - Date.parse(telemetry.startedAt)),
  );
  const transitions = telemetry.transitions.map((transition, index) =>
    index === telemetry.transitions.length - 1
      ? { ...transition, durationMs: transition.durationMs + elapsedSinceUpdateMs }
      : transition,
  );
  const activityReference = telemetry.activity.lastAt ??
    [...telemetry.transitions]
      .reverse()
      .find((transition) => transition.phase === "turn-start")?.startedAt ??
    telemetry.startedAt;
  const activityAgeMs = Math.max(0, Date.parse(completedAt) - Date.parse(activityReference));
  const activeProviderWindow =
    telemetry.activePhase === "turn-start" ||
    telemetry.activePhase === "provider-work" ||
    telemetry.activePhase === "tool-activity";
  const provider = {
    queueWaitMs:
      telemetry.provider.queueWaitMs +
      (activeProviderWindow && telemetry.activity.lastAt === null ? elapsedSinceUpdateMs : 0),
    executionMs:
      telemetry.provider.executionMs +
      (activeProviderWindow && telemetry.activity.lastAt !== null ? elapsedSinceUpdateMs : 0),
  };
  return ReviewExecutionTelemetrySchema.parse({
    ...telemetry,
    updatedAt: completedAt,
    completedAt,
    transitions,
    terminal: {
      outcome,
      phase: telemetry.activePhase,
      at: completedAt,
    },
    activity: {
      ...telemetry.activity,
      status:
        telemetry.activity.lastAt === null
          ? "silent"
          : activityAgeMs >= telemetry.stallIntervalMs
            ? "stalled"
            : "active",
      ageMs: activityAgeMs,
    },
    provider,
  });
}

interface MutableTransition {
  sequence: number;
  phase: ReviewExecutionPhase;
  attempt: number | null;
  startedAt: string;
  elapsedMs: number;
  durationMs: number;
}

export function createReviewExecutionTelemetry(
  options: {
    clock?: ReviewExecutionTelemetryClock;
    stallIntervalMs?: number;
  } = {},
): ReviewExecutionTelemetryTracker {
  const clock = options.clock ?? createMonotonicClock();
  const stallIntervalMs = options.stallIntervalMs ?? REVIEW_EXECUTION_STALL_INTERVAL_MS;
  if (!Number.isFinite(stallIntervalMs) || stallIntervalMs <= 0) {
    throw new RangeError("stallIntervalMs must be positive");
  }
  const started = normalizeReading(clock.read(), 0);
  let latest = started;
  let activePhase: ReviewExecutionPhase | null = null;
  let terminal: ReviewExecutionTelemetry["terminal"] = null;
  const transitions: MutableTransition[] = [];
  let activityCount = 0;
  let toolActivityCount = 0;
  let firstActivity: ReturnType<ReviewExecutionTelemetryClock["read"]> | null = null;
  let lastActivity: ReturnType<ReviewExecutionTelemetryClock["read"]> | null = null;
  let queueStartedElapsedMs: number | null = null;
  let providerWorkStartedElapsedMs: number | null = null;
  let queueWaitMs = 0;
  let executionMs = 0;
  let validationAttempts = 0;
  let repairAttempts = 0;

  const read = (): ReturnType<ReviewExecutionTelemetryClock["read"]> => {
    latest = normalizeReading(clock.read(), latest.elapsedMs);
    return latest;
  };

  const closeProviderWindow = (elapsedMs: number): void => {
    if (queueStartedElapsedMs !== null) {
      queueWaitMs += elapsedMs - queueStartedElapsedMs;
      queueStartedElapsedMs = null;
    }
    if (providerWorkStartedElapsedMs !== null) {
      executionMs += elapsedMs - providerWorkStartedElapsedMs;
      providerWorkStartedElapsedMs = null;
    }
  };

  const recordPhase = (
    phase: ReviewExecutionPhase,
    attempt: number | undefined,
    reading: ReturnType<ReviewExecutionTelemetryClock["read"]>,
  ): void => {
    const normalizedAttempt = attempt ?? null;
    const previous = transitions.at(-1);
    if (previous?.phase === phase && previous.attempt === normalizedAttempt) {
      return;
    }
    if (previous !== undefined) {
      previous.durationMs = reading.elapsedMs - previous.elapsedMs;
    }
    if (phase === "turn-start") {
      closeProviderWindow(reading.elapsedMs);
      queueStartedElapsedMs = reading.elapsedMs;
    } else if (
      phase === "validation-repair" ||
      phase === "persistence" ||
      phase === "completion"
    ) {
      closeProviderWindow(reading.elapsedMs);
    }
    transitions.push({
      sequence: transitions.length + 1,
      phase,
      attempt: normalizedAttempt,
      startedAt: reading.wallTime,
      elapsedMs: reading.elapsedMs,
      durationMs: 0,
    });
    activePhase = phase;
  };

  const recordActivity = (
    activity: "provider" | "tool",
    reading: ReturnType<ReviewExecutionTelemetryClock["read"]>,
  ): void => {
    activityCount += 1;
    if (activity === "tool") toolActivityCount += 1;
    firstActivity ??= reading;
    lastActivity = reading;
    if (queueStartedElapsedMs !== null) {
      queueWaitMs += reading.elapsedMs - queueStartedElapsedMs;
      queueStartedElapsedMs = null;
    }
    providerWorkStartedElapsedMs ??= reading.elapsedMs;
  };

  return {
    record(event) {
      if (terminal !== null) {
        throw new Error("Review execution telemetry is already terminal.");
      }
      const reading = read();
      switch (event.type) {
        case "phase":
          recordPhase(event.phase, event.attempt, reading);
          return;
        case "activity":
          recordActivity(event.activity, reading);
          return;
        case "validation":
          validationAttempts += 1;
          if (event.outcome === "retry") repairAttempts += 1;
          return;
        case "terminal": {
          closeProviderWindow(reading.elapsedMs);
          const current = transitions.at(-1);
          if (current !== undefined) {
            current.durationMs = reading.elapsedMs - current.elapsedMs;
          }
          terminal = {
            outcome: event.outcome,
            phase: activePhase,
            at: reading.wallTime,
          };
          return;
        }
        default: {
          const _exhaustive: never = event;
          return _exhaustive;
        }
      }
    },
    snapshot() {
      const reading = terminal === null ? read() : latest;
      const snapshotTransitions = transitions.map((transition, index) => {
        const isActive = terminal === null && index === transitions.length - 1;
        return {
          ...transition,
          durationMs: isActive ? reading.elapsedMs - transition.elapsedMs : transition.durationMs,
        };
      });
      const activityReference = lastActivity?.elapsedMs ?? queueStartedElapsedMs ?? started.elapsedMs;
      const activityAgeMs = Math.max(0, reading.elapsedMs - activityReference);
      const activityStatus =
        lastActivity === null
          ? "silent"
          : activityAgeMs >= stallIntervalMs
            ? "stalled"
            : "active";
      const pendingQueueWaitMs =
        queueStartedElapsedMs === null ? 0 : reading.elapsedMs - queueStartedElapsedMs;
      const pendingExecutionMs =
        providerWorkStartedElapsedMs === null
          ? 0
          : reading.elapsedMs - providerWorkStartedElapsedMs;
      return ReviewExecutionTelemetrySchema.parse({
        schemaVersion: REVIEW_EXECUTION_TELEMETRY_SCHEMA_VERSION,
        stallIntervalMs,
        startedAt: started.wallTime,
        updatedAt: reading.wallTime,
        completedAt: terminal?.at ?? null,
        activePhase,
        terminal,
        transitions: snapshotTransitions,
        activity: {
          status: activityStatus,
          count: activityCount,
          toolCount: toolActivityCount,
          firstAt: firstActivity?.wallTime ?? null,
          lastAt: lastActivity?.wallTime ?? null,
          ageMs: activityAgeMs,
        },
        provider: {
          queueWaitMs: queueWaitMs + pendingQueueWaitMs,
          executionMs: executionMs + pendingExecutionMs,
        },
        validation: {
          attempts: validationAttempts,
          repairs: repairAttempts,
        },
      });
    },
  };
}

function createMonotonicClock(): ReviewExecutionTelemetryClock {
  const startedAtMs = Date.now();
  const startedElapsedMs = performance.now();
  return {
    read: () => {
      const elapsedMs = Math.max(0, Math.round(performance.now() - startedElapsedMs));
      return {
        elapsedMs,
        wallTime: new Date(startedAtMs + elapsedMs).toISOString(),
      };
    },
  };
}

function normalizeReading(
  reading: ReturnType<ReviewExecutionTelemetryClock["read"]>,
  minimumElapsedMs: number,
): ReturnType<ReviewExecutionTelemetryClock["read"]> {
  if (!Number.isFinite(reading.elapsedMs) || reading.elapsedMs < 0) {
    throw new RangeError("Telemetry clock elapsedMs must be non-negative.");
  }
  const elapsedMs = Math.max(minimumElapsedMs, reading.elapsedMs);
  return {
    elapsedMs,
    wallTime: new Date(Date.parse(reading.wallTime) + (elapsedMs - reading.elapsedMs)).toISOString(),
  };
}
