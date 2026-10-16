import { execa } from "execa";

export async function getInstalledClaudeVersion(): Promise<string | null> {
  try {
    const { stdout } = await execa(
      process.env["DIFFOWL_CLAUDE_EXECUTABLE"]?.trim() || "claude",
      ["--version"],
      { timeout: 5_000 },
    );
    const trimmed = stdout.trim();
    if (trimmed === "") return null;
    return trimmed.match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0] ?? trimmed;
  } catch {
    return null;
  }
}
