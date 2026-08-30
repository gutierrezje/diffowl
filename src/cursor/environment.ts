import { buildReviewProcessEnvironment } from "../review/process-environment.js";

const CURSOR_SAFE_KEYS = new Set([
  "MOCK_CURSOR_CANCEL_MARKER",
  "MOCK_CURSOR_MODE",
  "MOCK_CURSOR_MODEL",
  "MOCK_CURSOR_MUTATION_PATH",
  "MOCK_CURSOR_PROMPT_MARKER",
  "MOCK_CURSOR_REASONING",
  "MOCK_CURSOR_REQUIRED_BOUNDARY",
  "MOCK_CURSOR_USER",
]);

/** Build the deliberately narrow environment allowed across the Cursor process boundary. */
export function buildCursorEnvironment(
  overrides: NodeJS.ProcessEnv = {},
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return buildReviewProcessEnvironment(overrides, inherited, CURSOR_SAFE_KEYS);
}
