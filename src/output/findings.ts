import chalk from "chalk";
import type { FindingDetail, FindingListItem } from "../state/findings-query.js";
import type { FindingSummary } from "../state/findings-summary.js";
import type { PossibleDuplicateDetail } from "../state/possible-duplicates.js";

const ID_WIDTH = 12;
const STATUS_WIDTH = 10;
const SEVERITY_WIDTH = 8;
const SEEN_WIDTH = 4;
const COLUMN_GAP = 2;
const MIN_LOCATION_WIDTH = 10;
const MIN_TITLE_WIDTH = 12;
const MAX_LOCATION_SHARE = 0.4;

export interface FormatFindingListOptions {
  columns?: number;
  color?: boolean;
}

export function shortenFindingId(id: string): string {
  if (id.length <= 16) {
    return id;
  }
  return id.slice(0, 12);
}

export function formatFindingList(
  items: FindingListItem[],
  options: FormatFindingListOptions = {},
): string {
  if (items.length === 0) {
    return "";
  }

  const columns = options.columns ?? process.stdout.columns ?? 100;
  const color = options.color ?? chalk.level > 0;
  const layout = computeListLayout(columns);
  const lines: string[] = [];

  lines.push(
    color ? chalk.bold(`Open findings: ${items.length}`) : `Open findings: ${items.length}`,
  );
  lines.push(
    color
      ? chalk.dim("Durable backlog; absence from later reviews does not auto-fix findings.")
      : "Durable backlog; absence from later reviews does not auto-fix findings.",
  );
  lines.push("");
  lines.push(
    color
      ? chalk.bold(
          [
            padEnd("ID", ID_WIDTH),
            padEnd("Status", STATUS_WIDTH),
            padEnd("Severity", SEVERITY_WIDTH),
            padEnd("Seen", SEEN_WIDTH),
            padEnd("Location", layout.locationWidth),
            "Title",
          ].join(" ".repeat(COLUMN_GAP)),
        )
      : [
          padEnd("ID", ID_WIDTH),
          padEnd("Status", STATUS_WIDTH),
          padEnd("Severity", SEVERITY_WIDTH),
          padEnd("Seen", SEEN_WIDTH),
          padEnd("Location", layout.locationWidth),
          "Title",
        ].join(" ".repeat(COLUMN_GAP)),
  );

  for (const item of items) {
    lines.push(...formatFindingListRow(item, layout));
  }

  lines.push("");
  lines.push(
    color
      ? chalk.dim("Mark resolved: diffowl findings fix <id> --note <text> --verified-by <command>")
      : "Mark resolved: diffowl findings fix <id> --note <text> --verified-by <command>",
  );

  return lines.join("\n");
}

export function formatFindingDetail(detail: FindingDetail): string {
  const lines = [
    `ID: ${detail.finding.id}`,
    `Status: ${detail.finding.status}`,
    `Fingerprint: ${detail.finding.fingerprint}`,
    `Occurrences: ${detail.occurrence_count}`,
    `Created: ${detail.finding.createdAt}`,
    `Updated: ${detail.finding.updatedAt}`,
  ];

  if (detail.observation) {
    lines.push(
      "",
      `Location: ${detail.observation.file}:${detail.observation.line}`,
      `Severity: ${detail.observation.severity}`,
      `Confidence: ${detail.observation.confidence}`,
      `Classification: ${detail.observation.classification}`,
      "",
      detail.observation.title,
      detail.observation.body,
    );
    if (detail.observation.evidence) {
      lines.push("", `Evidence: ${detail.observation.evidence}`);
    }
  }

  if (detail.events.length > 0) {
    lines.push("", "Events:");
    for (const event of detail.events) {
      const reason = event.reason ? ` — ${event.reason}` : "";
      lines.push(`  - ${event.createdAt} ${event.eventType} (${event.actor})${reason}`);
    }
  }

  return lines.join("\n");
}

export function renderFindingDetailJson(detail: FindingDetail): string {
  return `${JSON.stringify(detail, null, 2)}\n`;
}

export function renderFindingListJson(items: FindingListItem[]): string {
  return `${JSON.stringify(
    { schema_version: 1, count: items.length, findings: items },
    null,
    2,
  )}\n`;
}

export function formatPossibleDuplicateList(items: PossibleDuplicateDetail[]): string {
  if (items.length === 0) return "No possible duplicate suggestions.";
  const lines = ["Possible duplicate suggestions:"];
  for (const item of items) {
    lines.push(...formatPossibleDuplicateLines(item));
  }
  return lines.join("\n");
}

export function formatPossibleDuplicateDetail(item: PossibleDuplicateDetail): string {
  return formatPossibleDuplicateLines(item).join("\n");
}

export function renderPossibleDuplicateListJson(items: PossibleDuplicateDetail[]): string {
  return `${JSON.stringify(
    {
      schema_version: 1,
      count: items.length,
      duplicates: items.map((item) => ({
        ...possibleDuplicateJson(item),
      })),
    },
    null,
    2,
  )}\n`;
}

export function renderPossibleDuplicateDetailJson(item: PossibleDuplicateDetail): string {
  return `${JSON.stringify({ schema_version: 1, ...possibleDuplicateJson(item) }, null, 2)}\n`;
}

function formatPossibleDuplicateLines(item: PossibleDuplicateDetail): string[] {
  const candidate = formatDuplicateFinding(item.candidateFinding.id, item.candidateFinding.status, item.candidateObservation);
  const matched = formatDuplicateFinding(item.matchedFinding.id, item.matchedFinding.status, item.matchedObservation);
  const lines = [
    `- ${item.id} (${item.status}, lexical score ${item.score.toFixed(2)}, ${item.signals.matchKind})`,
    `  candidate ${candidate}`,
    `    title: ${item.candidateObservation.title}`,
    `    severity: ${item.candidateObservation.severity}`,
    `    evidence: ${item.candidateObservation.evidence ?? "none"}`,
    `  matched  ${matched}`,
    `    title: ${item.matchedObservation.title}`,
    `    severity: ${item.matchedObservation.severity}`,
    `    evidence: ${item.matchedObservation.evidence ?? "none"}`,
    `  Source disposition: ${item.sourceDispositionEvent.eventType} (${item.sourceDispositionEvent.actor})${item.sourceDispositionEvent.reason ? ` — ${item.sourceDispositionEvent.reason}` : ""}`,
  ];
  if (item.status === "suggested") {
    lines.push(
      `  Consequence: Confirming will ${item.suggestedSourceStatus === "dismissed" ? "dismiss" : "defer"} candidate ${item.candidateFinding.id}.`,
      `  Confirm: diffowl findings duplicates confirm ${item.id} --reason <text> --actor user --format json`,
      `  Reject:  diffowl findings duplicates reject ${item.id} --reason <text> --actor user --format json`,
    );
  }
  if (item.status === "expired") {
    lines.push(`  Expired: ${item.expiredReason}`);
  }
  if (item.status === "confirmed" || item.status === "rejected") {
    lines.push(`  Decision: ${item.decidedReason} (${item.decidedActor})`);
  }
  return lines;
}

function possibleDuplicateJson(item: PossibleDuplicateDetail) {
  return {
    id: item.id,
    status: item.status,
    score: item.score,
    matcher_version: item.matcherVersion,
    locator_version: item.locatorVersion,
    signals: item.signals,
    suggested_review_id: item.suggestedReviewId,
    candidate_finding_id: item.candidateFindingId,
    matched_finding_id: item.matchedFindingId,
    candidate_observation_id: item.candidateObservationId,
    matched_observation_id: item.matchedObservationId,
    source_disposition_event_id: item.sourceDispositionEventId,
    suggested_source_status: item.suggestedSourceStatus,
    candidate: duplicateFindingJson(item.candidateFinding.id, item.candidateFinding.status, item.candidateObservation),
    matched: duplicateFindingJson(item.matchedFinding.id, item.matchedFinding.status, item.matchedObservation),
    source_disposition_event: duplicateEventJson(item.sourceDispositionEvent),
    inherited_disposition_event_id: item.inheritedDispositionEventId,
    inherited_disposition_event: item.inheritedDispositionEvent
      ? duplicateEventJson(item.inheritedDispositionEvent)
      : null,
    created_at: item.createdAt,
    decided_at: item.decidedAt,
    decided_actor: item.decidedActor,
    decided_reason: item.decidedReason,
    inherited_status: item.inheritedStatus,
    expired_at: item.expiredAt,
    expired_reason: item.expiredReason,
  };
}

function duplicateEventJson(event: PossibleDuplicateDetail["sourceDispositionEvent"]) {
  return {
    id: event.id,
    finding_id: event.findingId,
    review_id: event.reviewId,
    event_type: event.eventType,
    actor: event.actor,
    reason: event.reason,
    commit_ref: event.commitRef,
    verification: event.verification,
    created_at: event.createdAt,
  };
}

function formatDuplicateFinding(
  id: string,
  status: string,
  observation: PossibleDuplicateDetail["candidateObservation"],
): string {
  const location = observation ? `${observation.file}:${observation.line}` : "unknown";
  return `${shortenFindingId(id)} [${status}] ${location}`;
}

function duplicateFindingJson(
  id: string,
  status: string,
  observation: PossibleDuplicateDetail["candidateObservation"],
) {
  return {
    id,
    status,
    observation_id: observation.id,
    location: { file: observation.file, line: observation.line },
    title: observation.title,
    body: observation.body,
    severity: observation.severity,
    confidence: observation.confidence,
    evidence: observation.evidence,
  };
}

/**
 * The published JSON projection of a FindingSummary (D-08). Aggregate-only, exactly like
 * `formatFindingSummaryLine`: counts, one severity label, the inspect command, and a schema
 * version. Nothing else may be added here — no findings array, no top finding, no sample title.
 * The absence is the mitigation for T-01-02, because this document is what an MCP handler or a
 * user's script reads straight into an agent's context (D-10).
 *
 * D-08 is rated one-way, so the field names below are a published contract: renaming one breaks
 * consumers DiffOwl cannot reach in to update. `schema_version` is a literal rather than
 * JSON_OUTPUT_SCHEMA_VERSION from src/output/json.ts, matching `renderFindingListJson` above —
 * the findings namespace versions itself independently of the review namespace, so bumping the
 * review document cannot silently re-advertise this one's version to a consumer doing version
 * negotiation. Approved at plan 01-06's decision checkpoint (option-a).
 */
export function renderFindingSummaryJson(summary: FindingSummary): string {
  return `${JSON.stringify(
    {
      schema_version: 1,
      open_count: summary.openCount,
      regressed_count: summary.regressedCount,
      top_severity: summary.topSeverity,
      inspect_command: summary.inspectCommand,
    },
    null,
    2,
  )}\n`;
}

/**
 * Aggregate-only one-line projection of a FindingSummary (D-10). Reads only `openCount`,
 * `regressedCount`, `topSeverity`, and `inspectCommand` — never a finding title, file path, line
 * number, or body. This is the structural mitigation for T-01-02: whatever this function returns
 * is injected verbatim into a model's context at session start, so no free-text field may ever
 * reach it.
 */
export function formatFindingSummaryLine(summary: FindingSummary): string {
  const parts: string[] = [];
  if (summary.openCount > 0) {
    parts.push(`${summary.openCount} open findings`);
  }
  if (summary.regressedCount > 0) {
    parts.push(`${summary.regressedCount} regressed`);
  }
  const severitySuffix = summary.topSeverity ? `, top severity ${summary.topSeverity}` : "";
  return `DiffOwl: ${parts.join(", ")}${severitySuffix} — run \`${summary.inspectCommand}\`.`;
}

function computeListLayout(columns: number): ListLayout {
  const fixedWidth = fixedPrefixWidth();
  const flexibleWidth = Math.max(
    columns - fixedWidth,
    MIN_LOCATION_WIDTH + COLUMN_GAP + MIN_TITLE_WIDTH,
  );
  let locationWidth = Math.max(
    MIN_LOCATION_WIDTH,
    Math.min(
      Math.floor(flexibleWidth * MAX_LOCATION_SHARE),
      flexibleWidth - COLUMN_GAP - MIN_TITLE_WIDTH,
    ),
  );
  let titleWidth = flexibleWidth - locationWidth - COLUMN_GAP;
  if (titleWidth < MIN_TITLE_WIDTH) {
    titleWidth = MIN_TITLE_WIDTH;
    locationWidth = Math.max(MIN_LOCATION_WIDTH, flexibleWidth - COLUMN_GAP - titleWidth);
  }

  return {
    locationWidth,
    titleWidth,
    titleIndent: fixedWidth + locationWidth + COLUMN_GAP,
  };
}

function formatFindingListRow(item: FindingListItem, layout: ListLayout): string[] {
  const id = shortenFindingId(item.finding.id);
  const status = item.finding.status;
  const severity = item.observation?.severity ?? "unknown";
  const seen = `${item.occurrence_count}x`;
  const location = formatLocation(item);
  const title = normalizeDisplayWhitespace(item.observation?.title ?? "(no observation)");
  const titleLines = wrapText(title, layout.titleWidth);
  const locationCell = truncateEnd(location, layout.locationWidth);

  const prefix = [
    padEnd(id, ID_WIDTH),
    padEnd(status, STATUS_WIDTH),
    padEnd(severity, SEVERITY_WIDTH),
    padEnd(seen, SEEN_WIDTH),
    padEnd(locationCell, layout.locationWidth),
  ].join(" ".repeat(COLUMN_GAP));

  const lines = [`${prefix}${" ".repeat(COLUMN_GAP)}${titleLines[0] ?? ""}`];
  for (let index = 1; index < titleLines.length; index += 1) {
    lines.push(`${" ".repeat(layout.titleIndent)}${titleLines[index]}`);
  }

  return lines;
}

function formatLocation(item: FindingListItem): string {
  if (!item.observation) {
    return "unknown";
  }
  if (!item.observation.file) {
    return "unknown";
  }
  return `${item.observation.file}:${item.observation.line}`;
}

function normalizeDisplayWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function wrapText(text: string, width: number): string[] {
  if (width <= 0) {
    return [text];
  }
  if (text.length <= width) {
    return [text];
  }

  const lines: string[] = [];
  let remaining = text;
  while (remaining.length > width) {
    let breakAt = remaining.lastIndexOf(" ", width);
    if (breakAt <= 0) {
      breakAt = width;
    }
    lines.push(remaining.slice(0, breakAt).trimEnd());
    remaining = remaining.slice(breakAt).trimStart();
  }
  if (remaining.length > 0) {
    lines.push(remaining);
  }
  return lines.length > 0 ? lines : [""];
}

function truncateEnd(text: string, width: number): string {
  if (text.length <= width) {
    return text;
  }
  if (width <= 3) {
    return text.slice(0, width);
  }
  return `${text.slice(0, width - 3)}...`;
}

function padEnd(text: string, width: number): string {
  if (text.length >= width) {
    return text.slice(0, width);
  }
  return `${text}${" ".repeat(width - text.length)}`;
}

function fixedPrefixWidth(): number {
  return (
    ID_WIDTH +
    COLUMN_GAP +
    STATUS_WIDTH +
    COLUMN_GAP +
    SEVERITY_WIDTH +
    COLUMN_GAP +
    SEEN_WIDTH +
    COLUMN_GAP
  );
}

interface ListLayout {
  locationWidth: number;
  titleWidth: number;
  titleIndent: number;
}
