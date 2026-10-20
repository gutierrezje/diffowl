import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
const temporaryRoot = await mkdtemp(join(tmpdir(), "diffowl-package-"));

try {
  const relativeRoot = relative(projectRoot, temporaryRoot);
  assert(
    isAbsolute(relativeRoot) || relativeRoot === ".." || relativeRoot.startsWith(`..${sep}`),
    "Package verification requires a temporary directory outside the checkout",
  );

  const tarball = join(temporaryRoot, "package.tgz");
  await execa("pnpm", ["pack", "--out", tarball], {
    cwd: projectRoot,
    stdio: "inherit",
    timeout: 180_000,
  });

  const installRoot = join(temporaryRoot, "install");
  await mkdir(installRoot);
  await writeFile(
    join(installRoot, "package.json"),
    JSON.stringify({ private: true, packageManager: packageJson.packageManager }),
  );
  await execa("pnpm", ["add", "--prod", "--ignore-workspace", tarball], {
    cwd: installRoot,
    stdio: "inherit",
    timeout: 180_000,
  });

  const executable = join(
    installRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "diffowl.cmd" : "diffowl",
  );
  const options = {
    cwd: installRoot,
    env: { NODE_PATH: "", FORCE_COLOR: "0" },
    timeout: 30_000,
  };
  const version = await execa(executable, ["--version"], options);
  assert.equal(version.stdout, packageJson.version);

  const help = await execa(executable, ["--help"], options);
  assert.match(help.stdout, /^Usage: diffowl \[options\] \[command\]$/m);
  assert.match(help.stdout, /^Local AI code review agent$/m);
  assert.match(help.stdout, /^\s+review \[options\]\s+/m);

  console.log(`Verified packed ${packageJson.name}@${packageJson.version}: --version and --help.`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
