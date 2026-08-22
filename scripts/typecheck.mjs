import { fileURLToPath } from "node:url";
import { execa, ExecaError } from "execa";

const tsc = fileURLToPath(import.meta.resolve("typescript/bin/tsc"));

try {
  await execa(process.execPath, ["--max-old-space-size=1024", tsc, ...process.argv.slice(2)], {
    stdio: "inherit",
  });
} catch (error) {
  if (error instanceof ExecaError) {
    if (error.exitCode !== undefined) {
      process.exit(error.exitCode);
    }

    if (error.signal !== undefined) {
      process.kill(process.pid, error.signal);
    }
  }

  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
