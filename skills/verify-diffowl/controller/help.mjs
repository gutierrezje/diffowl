export const surfaceCommands = [
  "capabilities",
  "doctor",
  "new-run",
  "info",
  "receipt",
  "snapshot",
  "console",
  "network-summary",
  "wait-settle",
  "cancel",
  "cleanup",
];

export function topLevelHelp() {
  return `Usage:
  control-diffowl <surface> <command> [options]
  control-diffowl run <surface> <feature-id> [options]

Surfaces:
  cli | codex | opencode

Commands:
  capabilities     Discover features and operations for one surface
  doctor           Observe source, artifact, runtime, authentication, and process identity
  new-run          Build DiffOwl and create an isolated run (stdout: scratch path)
  info             Summarize one recorded run
  receipt          Read the shared machine-readable evidence receipt
  snapshot         Capture durable review, database, process, and Git state
  console          Stream recorded process and action output as JSON Lines
  network-summary  Inspect only the run-owned server and reserved port
  wait-settle      Wait a bounded interval for review and child processes to settle
  cancel           Interrupt only a process recorded as owned by the run
  cleanup          Tear down owned processes and the disposable repository
  run              Execute a mapped feature and write its receipt

Examples:
  control-diffowl cli capabilities --json
  control-diffowl cli new-run cli-version-help
  control-diffowl run codex codex-review-staged --model gpt-5.6-sol
  control-diffowl opencode cleanup --run <run-id> --dry-run --json

Prerequisites:
  Node >=22.14, pnpm dependencies, Git, and provider authentication for live surfaces.

Side effects:
  new-run builds the checkout and creates a disposable Git repository. Live runs may spend
  model usage. Persistent mutations remain inside that repository. Evidence is retained.

Authority:
  The controller never changes provider authentication or operates on production targets.

Output:
  Inspectable commands accept --json. Streams emit JSON Lines. new-run keeps scalar stdout
  unless --json is requested. Human diagnostics go to stderr.

Recovery:
  Run control-diffowl <surface> cleanup --run <run-id>. If cleanup refuses ownership,
  inspect receipt and snapshot output before taking any manual action.`;
}

const helpByCommand = {
  capabilities: {
    usage: "<surface> capabilities [--json]",
    purpose: "List mapped feature IDs and supported controller commands.",
    prerequisites: "None beyond a readable checkout.",
    sideEffects: "None.",
    authority: "Read-only.",
    output: "Human text or one structured JSON object.",
    recovery: "No recovery required.",
  },
  doctor: {
    usage: "<surface> doctor [--run <run-id>] [--model <id>] [--json]",
    purpose:
      "Observe the effective source, artifact, repository, runtime, auth, and process identity.",
    prerequisites: "Build output for checkout-only inspection; a run ID for scratch identity.",
    sideEffects: "None.",
    authority: "Read-only; authentication output is reduced to a non-secret label.",
    output: "Human checks or one structured JSON object.",
    recovery: "Rebuild on artifact mismatch; clean the named run on owned-process mismatch.",
  },
  "new-run": {
    usage:
      "<surface> new-run <feature-id> [--run-id <id>] [--model <id>] [--reasoning <value>] [--dry-run] [--json]",
    purpose: "Build the checkout, bind its identity, and create one disposable Git target.",
    prerequisites: "The feature ID must appear in the selected surface capabilities.",
    sideEffects:
      "Builds dist/cli.js, creates a temporary repository, and retains evidence; --dry-run only describes this work.",
    authority:
      "Writes only build output, verification evidence, and the new disposable repository.",
    output: "Scratch path on scalar stdout, or one structured JSON object with --json.",
    recovery: "Use the returned run ID with the selected surface cleanup command.",
  },
  info: {
    usage: "<surface> info --run <run-id> [--json]",
    purpose: "Summarize the recorded feature, verdict, scratch, evidence, and cleanup state.",
    prerequisites: "A run created by new-run or run.",
    sideEffects: "None.",
    authority: "Read-only access to recorded run metadata.",
    output: "Human summary or one structured JSON object.",
    recovery: "Use the run's receipt and evidence path when the scratch is already absent.",
  },
  receipt: {
    usage: "<surface> receipt --run <run-id> [--json]",
    purpose: "Read the shared machine-readable verification receipt.",
    prerequisites: "A recorded run ID.",
    sideEffects: "None.",
    authority: "Read-only.",
    output: "The receipt document; --json emits one compact JSON object.",
    recovery: "Use info to resolve the evidence directory if the run ID is uncertain.",
  },
  snapshot: {
    usage: "<surface> snapshot --run <run-id> [--label <safe-name>] [--json]",
    purpose: "Capture Git, SQLite, immutable reports, and owned-process state together.",
    prerequisites: "The recorded scratch still exists.",
    sideEffects: "Writes one snapshot artifact under the run evidence directory.",
    authority: "Reads the disposable target and writes only its evidence.",
    output: "Snapshot path on scalar stdout, or one structured JSON object.",
    recovery: "Create a new run if cleanup already removed the scratch.",
  },
  console: {
    usage: "<surface> console --run <run-id> [--follow]",
    purpose: "Emit recorded action stdout, stderr, and hook-log lines as JSON Lines.",
    prerequisites: "A recorded run ID.",
    sideEffects: "None.",
    authority:
      "Reads only redaction-safe recorded logs; provider bodies and environments are excluded.",
    output: "One JSON object per line. --follow ends at the current durable stream boundary.",
    recovery: "Inspect action artifacts directly when a source line names an incomplete command.",
  },
  "network-summary": {
    usage: "<surface> network-summary --run <run-id> [--json]",
    purpose:
      "Inspect the reserved port and recorded server PID without scanning or killing by name.",
    prerequisites: "A recorded run ID.",
    sideEffects: "None.",
    authority: "Read-only inspection of the run's reserved localhost port and PID.",
    output: "Human summary or one structured JSON object.",
    recovery: "Use cleanup only when the reported listener belongs to the recorded PID.",
  },
  "wait-settle": {
    usage:
      "<surface> wait-settle --run <run-id> [--timeout-ms <1..60000>] [--interval-ms <10..5000>] [--json]",
    purpose: "Wait for owned children, the owned listener, reports, and database state to settle.",
    prerequisites: "A recorded run whose scratch still exists.",
    sideEffects: "None.",
    authority: "Read-only bounded polling.",
    output: "A structured settled or timed-out lifecycle result.",
    recovery: "Use console and network-summary, then cancel only the same run if needed.",
  },
  cancel: {
    usage: "<surface> cancel --run <run-id> [--dry-run] [--json]",
    purpose: "Send SIGINT only to a live process group whose identity is recorded by the run.",
    prerequisites: "An active feature command launched through control-diffowl.",
    sideEffects: "Interrupts the recorded feature command; --dry-run only reports candidates.",
    authority: "PID plus expected-command ownership must agree before any signal is sent.",
    output: "Human summary or one structured JSON object.",
    recovery: "Use wait-settle after cancellation; retain evidence if process identity disagrees.",
  },
  cleanup: {
    usage: "<surface> cleanup --run <run-id> [--dry-run] [--json]",
    purpose: "Stop recorded children and remove only the recorded disposable repository.",
    prerequisites: "A recorded run ID; evidence may outlive the scratch.",
    sideEffects: "Stops owned processes and removes the scratch unless --dry-run is set.",
    authority: "PID, command, scratch basename, and evidence-root ownership checks all apply.",
    output: "Human summary or one structured cleanup result. Evidence is retained.",
    recovery: "On refusal, inspect snapshot and process identity; never widen the deletion target.",
  },
  run: {
    usage:
      "run <surface> <feature-id> [--run <run-id>] [--model <id>] [--reasoning <value>] [--dry-run] [--json]",
    purpose: "Execute one mapped journey against an exact disposable target.",
    prerequisites:
      "The feature appears in capabilities; live surfaces require existing authentication.",
    sideEffects:
      "May create disposable Git state and spend provider usage; --dry-run only describes the journey.",
    authority: "Mutations are constrained to the named run; production targets are disabled.",
    output: "Receipt path by default or one structured JSON object with the verdict.",
    recovery: "Inspect the receipt, then use the matching surface cleanup command.",
  },
};

const genericHelp = {
  usage: "<surface> <command> [options]",
  purpose: "Operate on one recorded DiffOwl verification run.",
  prerequisites: "Use capabilities for feature support and new-run for an isolated target.",
  sideEffects: "Command-specific; use --dry-run for persistent or destructive operations.",
  authority: "Limited to resources recorded as owned by the named run.",
  output: "Human text or one structured JSON object; stream commands use JSON Lines.",
  recovery: "Inspect info and receipt, then retry cleanup with the same run ID.",
};

export function leafHelp(surface, command) {
  const help = helpByCommand[command] ?? genericHelp;
  return `Usage: control-diffowl ${help.usage.replace("<surface>", surface)}

${help.purpose}

Prerequisites:
  ${help.prerequisites}

Side effects:
  ${help.sideEffects}

Authority:
  ${help.authority}

Output:
  ${help.output}

Recovery:
  ${help.recovery}`;
}
