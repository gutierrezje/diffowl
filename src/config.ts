import { access, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { parse, stringify } from "yaml";
import { z, ZodError } from "zod";

export type ReviewConfidence = "low" | "medium" | "high";
export type ReviewContextDepth = "shallow" | "default" | "deep";

export interface DiffOwlConfig {
  model: string;
  server: {
    port: number;
    auto_start: boolean;
  };
  context: {
    depth: ReviewContextDepth;
  };
  timeout: number; // seconds
  min_confidence: ReviewConfidence;
  include: string[];
  exclude: string[];
  rules: string[];
}

const DEFAULT_CONFIG: DiffOwlConfig = {
  model: "opencode-go/big-pickle",
  server: {
    port: 4096,
    auto_start: true,
  },
  context: {
    depth: "default",
  },
  timeout: 300, // 5 minutes
  min_confidence: "medium",
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
};

const CONFIG_FILENAME = ".diffowl.yml";

export const ReviewConfidenceSchema = z.enum(["low", "medium", "high"]);
export const ReviewContextDepthSchema = z.enum(["shallow", "default", "deep"]);
export const ModelSchema = z
  .string()
  .trim()
  .min(1, "model must not be empty")
  .regex(/^[^/\s]+\/\S+$/, "model must use provider/model format");

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
    timeout: z.number().int().positive().default(DEFAULT_CONFIG.timeout),
    min_confidence: ReviewConfidenceSchema.default(DEFAULT_CONFIG.min_confidence),
    include: stringArraySchema.default(DEFAULT_CONFIG.include),
    exclude: stringArraySchema.default(DEFAULT_CONFIG.exclude),
    rules: stringArraySchema.default(DEFAULT_CONFIG.rules),
  })
  .strict();

export function parseModel(value: unknown): string {
  return ModelSchema.parse(value);
}

export function parseReviewContextDepth(value: unknown): ReviewContextDepth {
  return ReviewContextDepthSchema.parse(value);
}

function parseConfigInput(value: unknown): DiffOwlConfig {
  return DiffOwlConfigSchema.parse(value ?? {});
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
  const configPath = findConfigPath();
  if (!existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = await readFile(configPath, "utf-8");
    return parseConfigInput(parse(raw));
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
  const content = stringify(DiffOwlConfigSchema.parse(config), { lineWidth: 0 });
  await writeFile(configPath, content, "utf-8");
  return configPath;
}

export function getDiffOwlDir(): string {
  const configPath = findConfigPath();
  const projectRoot = dirname(configPath);
  return join(projectRoot, ".diffowl");
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
