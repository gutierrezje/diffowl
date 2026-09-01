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

const ReviewExecutionProviderWindowSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("closed") }).strict(),
  z
    .object({
      kind: z.literal("queued"),
      attempt: z.number().int().positive(),
      startedAt: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("active"),
      attempt: z.number().int().positive(),
      startedAt: z.string(),
    })
    .strict(),
]);

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
        window: ReviewExecutionProviderWindowSchema.default({ kind: "closed" }),
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

export function getSlowestReviewExecutionPhase(
  telemetry: ReviewExecutionTelemetry,
): { phase: ReviewExecutionPhase; durationMs: number } | null {
  const durationByPhase = new Map<ReviewExecutionPhase, number>();
  for (const transition of telemetry.transitions) {
    durationByPhase.set(
      transition.phase,
      (durationByPhase.get(transition.phase) ?? 0) + transition.durationMs,
    );
  }
  let slowest: { phase: ReviewExecutionPhase; durationMs: number } | null = null;
  for (const [phase, durationMs] of durationByPhase) {
    if (slowest === null || durationMs > slowest.durationMs) {
      slowest = { phase, durationMs };
    }
  }
  return slowest;
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
  const provider = {
    queueWaitMs:
      telemetry.provider.queueWaitMs +
      (telemetry.provider.window.kind === "queued" ? elapsedSinceUpdateMs : 0),
    executionMs:
      telemetry.provider.executionMs +
      (telemetry.provider.window.kind === "active" ? elapsedSinceUpdateMs : 0),
    window: { kind: "closed" } as const,
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

type TelemetryClockReading = ReturnType<ReviewExecutionTelemetryClock["read"]>;

type MutableProviderWindow =
  | { kind: "closed" }
  | { kind: "queued"; attempt: number; started: TelemetryClockReading }
  | { kind: "active"; attempt: number; started: TelemetryClockReading };

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
  let firstActivity: TelemetryClockReading | null = null;
  let lastActivity: TelemetryClockReading | null = null;
  let providerWindow: MutableProviderWindow = { kind: "closed" };
  let queueWaitMs = 0;
  let executionMs = 0;
  let validationAttempts = 0;
  let repairAttempts = 0;

  const read = (): TelemetryClockReading => {
    latest = normalizeReading(clock.read(), latest.elapsedMs);
    return latest;
  };

  const closeProviderWindow = (elapsedMs: number): void => {
    switch (providerWindow.kind) {
      case "queued":
        queueWaitMs += elapsedMs - providerWindow.started.elapsedMs;
        break;
      case "active":
        executionMs += elapsedMs - providerWindow.started.elapsedMs;
        break;
      case "closed":
        break;
      default: {
        const _exhaustive: never = providerWindow;
        return _exhaustive;
      }
    }
    providerWindow = { kind: "closed" };
  };

  const recordPhase = (
    phase: ReviewExecutionPhase,
    attempt: number | undefined,
    reading: TelemetryClockReading,
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
      if (attempt === undefined) {
        throw new Error("turn-start telemetry requires an attempt number.");
      }
      closeProviderWindow(reading.elapsedMs);
      providerWindow = { kind: "queued", attempt, started: reading };
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
    reading: TelemetryClockReading,
  ): void => {
    activityCount += 1;
    if (activity === "tool") toolActivityCount += 1;
    firstActivity ??= reading;
    lastActivity = reading;
    if (providerWindow.kind === "queued") {
      queueWaitMs += reading.elapsedMs - providerWindow.started.elapsedMs;
      providerWindow = {
        kind: "active",
        attempt: providerWindow.attempt,
        started: reading,
      };
    }
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
      const activityReference =
        lastActivity?.elapsedMs ??
        (providerWindow.kind === "queued" ? providerWindow.started.elapsedMs : started.elapsedMs);
      const activityAgeMs = Math.max(0, reading.elapsedMs - activityReference);
      const activityStatus =
        lastActivity === null
          ? "silent"
          : activityAgeMs >= stallIntervalMs
            ? "stalled"
            : "active";
      const pendingQueueWaitMs =
        providerWindow.kind === "queued" ? reading.elapsedMs - providerWindow.started.elapsedMs : 0;
      const pendingExecutionMs =
        providerWindow.kind === "active" ? reading.elapsedMs - providerWindow.started.elapsedMs : 0;
      const persistedProviderWindow =
        providerWindow.kind === "closed"
          ? providerWindow
          : {
              kind: providerWindow.kind,
              attempt: providerWindow.attempt,
              startedAt: providerWindow.started.wallTime,
            };
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
          window: persistedProviderWindow,
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
