import { join, resolve } from "node:path";

export const projectRoot = resolve(import.meta.dirname, "../../..");
export const helpersRoot = join(projectRoot, "skills", "verify-diffowl", "helpers");
export const binaryPath = join(projectRoot, "dist", "cli.js");
