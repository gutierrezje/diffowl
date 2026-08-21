import { execa } from "execa";

type VersionCommand = (
  command: string,
  args: string[],
  options: { timeout: number },
) => PromiseLike<{ stdout: string }>;

const executeVersionCommand: VersionCommand = (command, args, options) =>
  execa(command, args, options);

export async function getInstalledCodexVersion(
  execute: VersionCommand = executeVersionCommand,
): Promise<string | null> {
  try {
    const { stdout } = await execute("codex", ["--version"], { timeout: 5_000 });
    const trimmed = stdout.trim();
    if (trimmed === "") return null;
    return trimmed.match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0] ?? trimmed;
  } catch {
    return null;
  }
}
