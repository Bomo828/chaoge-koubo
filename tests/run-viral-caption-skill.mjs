import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = mkdtempSync(join(tmpdir(), "merchant-caption-skill-"));

function run(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) process.exitCode = result.status || 1;
  return result.status === 0;
}

try {
  const compiled = run([
    "node_modules/typescript/bin/tsc",
    "tests/viral-caption-skill.test.ts",
    "--outDir", output,
    "--rootDir", ".",
    "--module", "commonjs",
    "--moduleResolution", "node",
    "--target", "ES2023",
    "--lib", "ES2023,DOM",
    "--esModuleInterop",
    "--skipLibCheck",
    "--types", "node",
    "--pretty", "false",
  ]);
  if (compiled) run([join(output, "tests/viral-caption-skill.test.js")]);
} finally {
  rmSync(output, { recursive: true, force: true });
}
