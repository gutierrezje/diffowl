import chalk from "chalk";
import type { FindingDetail, FindingListItem } from "../state/findings-query.js";

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
