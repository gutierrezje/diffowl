import { access, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { parse, stringify } from "yaml";
import { z, ZodError } from "zod";
import { OpenCodeModelSchema, ReasoningVariantSchema } from "./review/backend-selection.js";

export const ReviewConfidenceSchema = z.enum(["low", "medium", "high"]);
export const ReviewContextDepthSchema = z.enum(["shallow", "default"]);
export const DEFAULT_REASONING_EFFORT = "auto" as const;
export const ReasoningEffortSchema = ReasoningVariantSchema;
export const ModelSchema = OpenCodeModelSchema;

export type ReviewConfidence = z.output<typeof ReviewConfidenceSchema>;
export type ReviewContextDepth = z.output<typeof ReviewContextDepthSchema>;
export type ReasoningEffort = z.output<typeof ReasoningEffortSchema>;

const DEFAULT_CONFIG = {
  model: "opencode/big-pickle",
  server: {
    port: 4096,
    auto_start: true,
  },
  context: {
    depth: ReviewContextDepthSchema.enum.default,
  },
  reasoning: {
    effort: DEFAULT_REASONING_EFFORT,
  },
  retention: {
    hook_log_kb: 1024,
  },
  gate: {
    fail_on_findings: false,
  },
  timeout: 300, // 5 minutes
  min_confidence: ReviewConfidenceSchema.enum.medium,
  include: ["**/*"],
  exclude: [
    "**/*.test.*",
    "**/*.spec.*",
    "**/*.lock",
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/.git/**",
  ],
  rules: [],
  skip_doc_only: false,
  verbose: false,
};

const CONFIG_FILENAME = ".diffowl.yml";

const stringArraySchema = z.array(z.string().trim().min(1));

export const DiffOwlConfigSchema = z
  .object({
    model: ModelSchema.default(DEFAULT_CONFIG.model),
    server: z
      .object({
        port: z.number().int().min(1).max(65535).default(DEFAULT_CONFIG.server.port),
        auto_start: z.boolean().default(DEFAULT_CONFIG.server.auto_start),
      })
      .strict()
      .default(DEFAULT_CONFIG.server),
    context: z
      .object({
        depth: ReviewContextDepthSchema.default(DEFAULT_CONFIG.context.depth),
      })
      .strict()
      .default(DEFAULT_CONFIG.context),
    reasoning: z
      .object({
        effort: ReasoningEffortSchema.default(DEFAULT_CONFIG.reasoning.effort),
      })
      .strict()
      .default(DEFAULT_CONFIG.reasoning),
    retention: z
      .object({
        hook_log_kb: z.number().int().nonnegative().default(DEFAULT_CONFIG.retention.hook_log_kb),
      })
      .strict()
      .default(DEFAULT_CONFIG.retention),
    gate: z
      .object({
        fail_on_findings: z.boolean().default(DEFAULT_CONFIG.gate.fail_on_findings),
      })
      .strict()
      .default(DEFAULT_CONFIG.gate),
    timeout: z.number().int().positive().default(DEFAULT_CONFIG.timeout),
    min_confidence: ReviewConfidenceSchema.default(DEFAULT_CONFIG.min_confidence),
    include: stringArraySchema.default(DEFAULT_CONFIG.include),
    exclude: stringArraySchema.default(DEFAULT_CONFIG.exclude),
    rules: stringArraySchema.default(DEFAULT_CONFIG.rules),
    skip_doc_only: z.boolean().default(DEFAULT_CONFIG.skip_doc_only),
    verbose: z.boolean().default(DEFAULT_CONFIG.verbose),
  })
  .strict();

const ProjectConfigSchema = DiffOwlConfigSchema.omit({ model: true, reasoning: true });
const LegacyReasoningInputSchema = z
  .object({
    reasoning: z
      .object({
        effort: ReasoningEffortSchema.default(DEFAULT_REASONING_EFFORT),
      })
      .strict()
      .optional(),
  })
  .passthrough();

export type DiffOwlConfig = z.output<typeof DiffOwlConfigSchema>;
export type ConfigDiagnostic = {
  kind: "legacy-reasoning";
  effort: ReasoningEffort;
};
export type LoadedConfig = {
  config: DiffOwlConfig;
  diagnostics: ConfigDiagnostic[];
};

export function parseModel(value: Parameters<typeof ModelSchema.parse>[0]): string {
  return ModelSchema.parse(value);
}

export function parseReviewContextDepth(
  value: Parameters<typeof ReviewContextDepthSchema.parse>[0],
): ReviewContextDepth {
  return ReviewContextDepthSchema.parse(value);
}

export function parseReasoningEffort(
  value: Parameters<typeof ReasoningEffortSchema.parse>[0],
): ReasoningEffort {
  return ReasoningEffortSchema.parse(value);
}

function formatZodError(err: ZodError): string {
  return err.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "config";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

function findConfigPath(): string {
  // Look in current directory first, then walk up
  let dir = process.cwd();
  while (true) {
    const candidate = join(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return join(process.cwd(), CONFIG_FILENAME);
}

export async function loadConfig(): Promise<DiffOwlConfig> {
  return (await loadConfigWithDiagnostics()).config;
}

export async function loadConfigFromRoot(root: string): Promise<DiffOwlConfig> {
  return (await loadConfigWithDiagnosticsFromRoot(root)).config;
}

export async function loadConfigWithDiagnostics(): Promise<LoadedConfig> {
  return loadConfigWithDiagnosticsFromRoot(dirname(findConfigPath()));
}

export async function loadConfigWithDiagnosticsFromRoot(root: string): Promise<LoadedConfig> {
  const configPath = join(root, CONFIG_FILENAME);
  if (!existsSync(configPath)) {
    return { config: DiffOwlConfigSchema.parse({}), diagnostics: [] };
  }
  try {
    const raw = await readFile(configPath, "utf-8");
    const input = parse(raw) ?? {};
    const config = DiffOwlConfigSchema.parse(input);
    const legacyInput = LegacyReasoningInputSchema.parse(input);
    const diagnostics: ConfigDiagnostic[] =
      legacyInput.reasoning === undefined
        ? []
        : [{ kind: "legacy-reasoning", effort: legacyInput.reasoning.effort }];
    return { config, diagnostics };
  } catch (err) {
    const message =
      err instanceof ZodError
        ? formatZodError(err)
        : err instanceof Error
          ? err.message
          : String(err);
    throw new Error(`Failed to load ${configPath}: ${message}`);
  }
}

export async function saveConfig(config: DiffOwlConfig): Promise<string> {
  const configPath = findConfigPath();
  const { model: _backendModel, reasoning: _legacyReasoning, ...projectConfigInput } = config;
  const projectConfig = ProjectConfigSchema.parse(projectConfigInput);
  const content = stringify(projectConfig, { lineWidth: 0 });
  await writeFile(configPath, content, "utf-8");
  return configPath;
}

export function getDiffOwlDir(): string {
  return join(getProjectRoot(), ".diffowl");
}

export function getProjectRoot(): string {
  return dirname(findConfigPath());
}

export async function ensureDiffOwlDir(): Promise<string> {
  const dir = getDiffOwlDir();
  try {
    await access(dir);
  } catch {
    await mkdir(dir, { recursive: true });
  }
  return dir;
}

export function configExists(): boolean {
  return existsSync(findConfigPath());
}
