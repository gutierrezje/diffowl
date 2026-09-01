import { describe, expect, it } from "vitest";
import {
  createReviewExecutionTelemetry,
  finishPersistedReviewExecutionTelemetry,
  getSlowestReviewExecutionPhase,
  ReviewExecutionTelemetrySchema,
  type ReviewExecutionTelemetryClock,
} from "./execution-telemetry.js";

function createClock(startedAt = "2026-09-01T20:00:00.000Z") {
  const baseMs = Date.parse(startedAt);
  let elapsedMs = 0;
  const clock: ReviewExecutionTelemetryClock = {
    read: () => ({
      elapsedMs,
      wallTime: new Date(baseMs + elapsedMs).toISOString(),
    }),
  };
  return {
    clock,
    advance(ms: number) {
      elapsedMs += ms;
    },
  };
}

describe("review execution telemetry", () => {
  it("records ordered phase durations, provider activity, queue wait, and repair attempts", () => {
    const time = createClock();
    const telemetry = createReviewExecutionTelemetry({
      clock: time.clock,
      stallIntervalMs: 1_000,
    });

    telemetry.record({ type: "phase", phase: "context-build" });
    time.advance(200);
    telemetry.record({ type: "phase", phase: "protocol-check" });
    time.advance(100);
    telemetry.record({ type: "phase", phase: "turn-start", attempt: 1 });
    time.advance(50);
    telemetry.record({ type: "phase", phase: "provider-work", attempt: 1 });
    time.advance(150);
    telemetry.record({ type: "activity", activity: "provider" });
    time.advance(200);
    telemetry.record({ type: "phase", phase: "tool-activity", attempt: 1 });
    telemetry.record({ type: "activity", activity: "tool" });
    time.advance(100);
    telemetry.record({ type: "phase", phase: "provider-work", attempt: 1 });
    time.advance(300);
    telemetry.record({ type: "activity", activity: "provider" });
    telemetry.record({ type: "phase", phase: "validation-repair", attempt: 1 });
    telemetry.record({ type: "validation", outcome: "retry" });
    time.advance(50);
    telemetry.record({ type: "phase", phase: "persistence" });
    time.advance(400);
    telemetry.record({ type: "phase", phase: "completion" });
    telemetry.record({ type: "terminal", outcome: "completed" });

    const snapshot = telemetry.snapshot();
    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      stallIntervalMs: 1_000,
      startedAt: "2026-09-01T20:00:00.000Z",
      updatedAt: "2026-09-01T20:00:01.550Z",
      completedAt: "2026-09-01T20:00:01.550Z",
      activePhase: "completion",
      terminal: {
        outcome: "completed",
        phase: "completion",
        at: "2026-09-01T20:00:01.550Z",
      },
      activity: {
        status: "active",
        count: 3,
        toolCount: 1,
        firstAt: "2026-09-01T20:00:00.500Z",
        lastAt: "2026-09-01T20:00:01.100Z",
        ageMs: 450,
      },
      provider: {
        queueWaitMs: 200,
        executionMs: 600,
      },
      validation: {
        attempts: 1,
        repairs: 1,
      },
    });
    expect(snapshot.transitions).toEqual([
      expect.objectContaining({ sequence: 1, phase: "context-build", durationMs: 200 }),
      expect.objectContaining({ sequence: 2, phase: "protocol-check", durationMs: 100 }),
      expect.objectContaining({ sequence: 3, phase: "turn-start", durationMs: 50, attempt: 1 }),
      expect.objectContaining({ sequence: 4, phase: "provider-work", durationMs: 350, attempt: 1 }),
      expect.objectContaining({ sequence: 5, phase: "tool-activity", durationMs: 100, attempt: 1 }),
      expect.objectContaining({ sequence: 6, phase: "provider-work", durationMs: 300, attempt: 1 }),
      expect.objectContaining({ sequence: 7, phase: "validation-repair", durationMs: 50, attempt: 1 }),
      expect.objectContaining({ sequence: 8, phase: "persistence", durationMs: 400 }),
      expect.objectContaining({ sequence: 9, phase: "completion", durationMs: 0 }),
    ]);
  });

  it("distinguishes a silent turn from active and stalled provider work", () => {
    const silentTime = createClock();
    const silent = createReviewExecutionTelemetry({
      clock: silentTime.clock,
      stallIntervalMs: 1_000,
    });
    silent.record({ type: "phase", phase: "turn-start", attempt: 1 });
    silentTime.advance(1_500);
    silent.record({ type: "terminal", outcome: "timed-out" });

    expect(silent.snapshot()).toMatchObject({
      terminal: { outcome: "timed-out", phase: "turn-start" },
      activity: { status: "silent", count: 0, ageMs: 1_500 },
      provider: { queueWaitMs: 1_500, executionMs: 0 },
    });

    const activeTime = createClock();
    const active = createReviewExecutionTelemetry({
      clock: activeTime.clock,
      stallIntervalMs: 1_000,
    });
    active.record({ type: "phase", phase: "turn-start", attempt: 1 });
    activeTime.advance(400);
    active.record({ type: "activity", activity: "provider" });
    activeTime.advance(500);
    active.record({ type: "terminal", outcome: "timed-out" });
    expect(active.snapshot()).toMatchObject({
      activity: { status: "active", count: 1, ageMs: 500 },
      provider: { queueWaitMs: 400, executionMs: 500 },
    });

    const stalledTime = createClock();
    const stalled = createReviewExecutionTelemetry({
      clock: stalledTime.clock,
      stallIntervalMs: 1_000,
    });
    stalled.record({ type: "phase", phase: "turn-start", attempt: 1 });
    stalledTime.advance(100);
    stalled.record({ type: "activity", activity: "provider" });
    stalledTime.advance(1_100);
    stalled.record({ type: "terminal", outcome: "timed-out" });
    expect(stalled.snapshot()).toMatchObject({
      activity: { status: "stalled", count: 1, ageMs: 1_100 },
      provider: { queueWaitMs: 100, executionMs: 1_100 },
    });
  });

  it("counts a later attempt's pre-activity crash as queue wait", () => {
    const time = createClock();
    const telemetry = createReviewExecutionTelemetry({ clock: time.clock });

    telemetry.record({ type: "phase", phase: "turn-start", attempt: 1 });
    time.advance(100);
    telemetry.record({ type: "activity", activity: "provider" });
    time.advance(200);
    telemetry.record({ type: "phase", phase: "validation-repair", attempt: 1 });
    time.advance(50);
    telemetry.record({ type: "phase", phase: "turn-start", attempt: 2 });
    telemetry.record({ type: "phase", phase: "provider-work", attempt: 2 });

    const finished = finishPersistedReviewExecutionTelemetry(
      telemetry.snapshot(),
      "interrupted",
      "2026-09-01T20:00:00.850Z",
    );

    expect(finished.provider).toEqual({
      queueWaitMs: 600,
      executionMs: 200,
      window: { kind: "closed" },
    });
  });

  it("parses legacy persisted telemetry without a provider window", () => {
    const telemetry = createReviewExecutionTelemetry().snapshot();

    const parsed = ReviewExecutionTelemetrySchema.parse({
      ...telemetry,
      provider: {
        queueWaitMs: telemetry.provider.queueWaitMs,
        executionMs: telemetry.provider.executionMs,
      },
    });

    expect(parsed.provider.window).toEqual({ kind: "closed" });
  });

  it("totals repeated phase spans when selecting the slowest phase", () => {
    const time = createClock();
    const telemetry = createReviewExecutionTelemetry({ clock: time.clock });
    telemetry.record({ type: "phase", phase: "provider-work", attempt: 1 });
    time.advance(300);
    telemetry.record({ type: "phase", phase: "tool-activity", attempt: 1 });
    time.advance(50);
    telemetry.record({ type: "phase", phase: "provider-work", attempt: 1 });
    time.advance(300);
    telemetry.record({ type: "phase", phase: "persistence" });
    time.advance(400);
    telemetry.record({ type: "terminal", outcome: "completed" });

    expect(getSlowestReviewExecutionPhase(telemetry.snapshot())).toEqual({
      phase: "provider-work",
      durationMs: 600,
    });
  });
});
