import { describe, expect, it } from "vitest";
import {
  formatFindingList,
  renderFindingListJson,
  renderFindingSummaryJson,
  shortenFindingId,
} from "./findings.js";
import type { FindingListItem } from "../state/findings-query.js";
import type { FindingSummary } from "../state/findings-summary.js";
import type { FindingObservationRecord, FindingRecord } from "../state/types.js";

const baseFinding: FindingRecord = {
  id: "fnd_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  fingerprint: "v1:test",
  status: "open",
  firstReviewId: "rev_test",
  lastReviewId: "rev_test",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const baseObservation: FindingObservationRecord = {
  id: 1,
  reviewId: "rev_test",
  findingId: baseFinding.id,
  file: "src/auth.ts",
  line: 12,
  severity: "warning",
  confidence: "high",
  title: "Missing null check",
  body: "The handler does not validate the payload.",
  evidence: null,
  symbolKey: null,
  ordinal: 1,
  classification: "new",
};

function listItem(
  overrides: {
    finding?: Partial<FindingRecord>;
    observation?: Partial<FindingObservationRecord> | null;
    occurrence_count?: number;
  } = {},
): FindingListItem {
  const observation =
    overrides.observation === null
      ? null
      : {
          ...baseObservation,
          ...overrides.observation,
          findingId: overrides.finding?.id ?? baseFinding.id,
        };
  return {
    finding: { ...baseFinding, ...overrides.finding },
    observation,
    occurrence_count: overrides.occurrence_count ?? 1,
  };
}

describe("shortenFindingId", () => {
  it("returns copyable prefixes without unicode ellipsis", () => {
    expect(shortenFindingId(baseFinding.id)).toBe("fnd_aaaaaaaa");
    expect(shortenFindingId(baseFinding.id)).not.toContain("…");
  });
});

describe("formatFindingList", () => {
  it("returns an empty string for an empty list", () => {
    expect(formatFindingList([], { columns: 100, color: false })).toBe("");
  });

  it("renders count, durable backlog subheader, columns, and row data", () => {
    const output = formatFindingList(
      [
        listItem({ occurrence_count: 3, finding: { status: "regressed" } }),
        listItem({
          finding: {
            id: "fnd_bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee",
            status: "open",
          },
          observation: {
            file: "src/other.ts",
            line: 4,
            severity: "error",
            title: "Unhandled rejection",
          },
          occurrence_count: 1,
        }),
      ],
      { columns: 120, color: false },
    );

    expect(output).toContain("Open findings: 2");
    expect(output).toContain(
      "Durable backlog; absence from later reviews does not auto-fix findings.",
    );
    expect(output).toContain("ID");
    expect(output).toContain("Status");
    expect(output).toContain("Severity");
    expect(output).toContain("Seen");
    expect(output).toContain("Location");
    expect(output).toContain("Title");
    expect(output).toContain("fnd_aaaaaaaa");
    expect(output).toContain("regressed");
    expect(output).toContain("warning");
    expect(output).toContain("3x");
    expect(output).toContain("src/auth.ts:12");
    expect(output).toContain("Missing null check");
    expect(output).toContain("fnd_bbbbbbbb");
    expect(output).toContain("error");
    expect(output).toContain("1x");
    expect(output).toContain("src/other.ts:4");
    expect(output).toContain("Unhandled rejection");
    expect(output).toContain(
      "Mark resolved: diffowl findings fix <id> --note <text> --verified-by <command>",
    );
  });

  it("wraps long titles onto indented continuation lines with spaces preserved", () => {
    const title = "resolution fails when payload is empty and retry is disabled";
    const output = formatFindingList([listItem({ observation: { title } })], {
      columns: 72,
      color: false,
    });

    const lines = output.split("\n");
    const titleLineIndex = lines.findIndex((line) => line.includes("fnd_aaaaaaaa"));
    expect(titleLineIndex).toBeGreaterThanOrEqual(0);
    const continuationLine = lines[titleLineIndex + 1];
    expect(continuationLine).toBeDefined();
    expect(continuationLine?.trimStart()).not.toBe(continuationLine);
    expect(continuationLine).not.toMatch(/^fnd_/);
    expect(output).toContain("resolution fails");
    expect(output).toContain("retry");
    expect(output).toContain("is disabled");
    expect(output).not.toContain("resolutionfails");
    expect(output).not.toContain("emptyand");
    expect(output).not.toContain("retryis");
  });

  it("does not concatenate words at narrow terminal widths", () => {
    const title = "alpha beta gamma delta epsilon zeta eta theta iota";
    const output = formatFindingList([listItem({ observation: { title } })], {
      columns: 40,
      color: false,
    });

    expect(output).toContain("alpha beta");
    expect(output).not.toMatch(/alphabeta|betagamma|gammadelta/);
  });

  it("renders unknown fields safely when observation metadata is missing", () => {
    const output = formatFindingList([listItem({ observation: null, occurrence_count: 2 })], {
      columns: 100,
      color: false,
    });

    expect(output).toContain("fnd_aaaaaaaa");
    expect(output).toContain("open");
    expect(output).toContain("unknown");
    expect(output).toContain("2x");
    expect(output).toContain("(no observation)");
  });
});

describe("renderFindingListJson", () => {
  it("renders an empty envelope with a trailing newline", () => {
    const output = renderFindingListJson([]);
    expect(output.endsWith("\n")).toBe(true);
    expect(JSON.parse(output)).toEqual({
      schema_version: 1,
      count: 0,
      findings: [],
    });
  });

  it("round-trips finding records and occurrence counts", () => {
    const items = [
      listItem({ occurrence_count: 3 }),
      listItem({
        finding: { id: "fnd_bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee" },
        observation: { file: "src/other.ts", line: 4, title: "Unhandled rejection" },
        occurrence_count: 1,
      }),
    ];
    const previousColumns = process.stdout.columns;
    process.stdout.columns = 40;
    try {
      const output = renderFindingListJson(items);
      expect(JSON.parse(output)).toEqual({
        schema_version: 1,
        count: 2,
        findings: items,
      });
    } finally {
      process.stdout.columns = previousColumns;
    }
  });
});

describe("renderFindingSummaryJson", () => {
  const populatedSummary: FindingSummary = {
    openCount: 3,
    regressedCount: 1,
    topSeverity: "error",
    inspectCommand: "diffowl findings list",
  };

  const emptySummary: FindingSummary = {
    openCount: 0,
    regressedCount: 0,
    topSeverity: null,
    inspectCommand: "diffowl findings list",
  };

  it("renders the approved document with a trailing newline", () => {
    const output = renderFindingSummaryJson(populatedSummary);

    expect(output.endsWith("\n")).toBe(true);
    expect(JSON.parse(output)).toEqual({
      schema_version: 1,
      open_count: 3,
      regressed_count: 1,
      top_severity: "error",
      inspect_command: "diffowl findings list",
    });
  });

  it("publishes exactly the approved field set and nothing else", () => {
    // D-08 is rated one-way: this document is the contract MCP handlers and user scripts read, so
    // an added key is as much a change to it as a renamed one. Asserted as a whole-key-set equality
    // rather than per-field so a future field cannot be introduced without editing this line.
    expect(Object.keys(JSON.parse(renderFindingSummaryJson(populatedSummary))).sort()).toEqual([
      "inspect_command",
      "open_count",
      "regressed_count",
      "schema_version",
      "top_severity",
    ]);
  });

  it("renders zero counts and a null top severity for an empty summary, not an empty string", () => {
    const output = renderFindingSummaryJson(emptySummary);

    // The fail-silent contract from plan 01-05 is asymmetric on purpose: only the text projection
    // goes literally silent. A consumer parsing stdout needs parseable JSON.
    expect(output).not.toBe("");
    expect(JSON.parse(output)).toEqual({
      schema_version: 1,
      open_count: 0,
      regressed_count: 0,
      top_severity: null,
      inspect_command: "diffowl findings list",
    });
  });

  it("pretty-prints like the other renderers in the findings namespace", () => {
    // renderReviewJsonDocument is compact; renderFindingListJson and renderFindingDetailJson are
    // two-space indented. This function extends the findings namespace, so it follows that one.
    expect(renderFindingSummaryJson(populatedSummary)).toContain('\n  "open_count": 3');
  });
});
