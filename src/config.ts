import { access, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { parse, stringify } from "yaml";

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

function validateTimeout(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  return DEFAULT_CONFIG.timeout;
}

function validateMinConfidence(value: unknown): ReviewConfidence {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  return DEFAULT_CONFIG.min_confidence;
}

function validateContextDepth(value: unknown): ReviewContextDepth {
  if (value === "shallow" || value === "default" || value === "deep") {
    return value;
  }
  return DEFAULT_CONFIG.context.depth;
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
    const parsed = parse(raw) as Partial<DiffOwlConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      server: { ...DEFAULT_CONFIG.server, ...parsed.server },
      context: {
        ...DEFAULT_CONFIG.context,
        ...parsed.context,
        depth: validateContextDepth(parsed.context?.depth),
      },
      timeout: validateTimeout(parsed.timeout),
      min_confidence: validateMinConfidence(parsed.min_confidence),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load ${configPath}: ${message}`);
  }
}

export async function saveConfig(config: DiffOwlConfig): Promise<string> {
  const configPath = findConfigPath();
  const content = stringify(config, { lineWidth: 0 });
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
