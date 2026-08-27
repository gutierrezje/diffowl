import { access, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { parse, stringify } from "yaml";
import { z, ZodError } from "zod";
import { OpenCodeModelSchema } from "./review/backend-selection.js";
import {
  ReasoningVariantSchema,
  type ReasoningVariant,
} from "./review/reasoning.js";

export const ReviewConfidenceSchema = z.enum(["low", "medium", "high"]);
export const ReviewContextDepthSchema = z.enum(["shallow", "default"]);

export type ReviewConfidence = z.output<typeof ReviewConfidenceSchema>;
export type ReviewContextDepth = z.output<typeof ReviewContextDepthSchema>;

const DEFAULT_CONFIG = {
  server: {
    port: 4096,
    auto_start: true,
  },
  context: {
    depth: ReviewContextDepthSchema.enum.default,
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

const LegacyProjectConfigInputSchema = DiffOwlConfigSchema.extend({
  model: OpenCodeModelSchema.optional(),
  reasoning: z
    .object({
      effort: ReasoningVariantSchema.optional(),
    })
    .strict()
    .optional(),
}).strict();

export type DiffOwlConfig = z.output<typeof DiffOwlConfigSchema>;
export type ConfigDiagnostic = {
  kind: "legacy-reasoning";
  effort: ReasoningVariant;
};
export type LoadedConfig = {
  config: DiffOwlConfig;
  diagnostics: ConfigDiagnostic[];
};

export function parseReviewContextDepth(
  value: Parameters<typeof ReviewContextDepthSchema.parse>[0],
): ReviewContextDepth {
  return ReviewContextDepthSchema.parse(value);
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
    const legacyInput = LegacyProjectConfigInputSchema.parse(input);
    const { model: _legacyModel, reasoning: legacyReasoning, ...projectInput } = legacyInput;
    const config = DiffOwlConfigSchema.parse(projectInput);
    const diagnostics: ConfigDiagnostic[] =
      legacyReasoning?.effort === undefined
        ? []
        : [{ kind: "legacy-reasoning", effort: legacyReasoning.effort }];
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
  const projectConfig = DiffOwlConfigSchema.parse(config);
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
