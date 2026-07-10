import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const scriptsRoot = path.join(repositoryRoot, "scripts");
const bashExecutable = process.env.PI_WEZTERM_TEST_BASH?.trim() || "bash";

function findShellFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return findShellFiles(entryPath);
    return entry.isFile() && entry.name.endsWith(".sh") ? [entryPath] : [];
  });
}

const shellFiles = findShellFiles(scriptsRoot);
assert.ok(shellFiles.length > 0, "expected packaged shell scripts");

const commonScript = readFileSync(path.join(scriptsRoot, "wezterm", "wezterm-common.sh"), "utf8");
assert.doesNotMatch(commonScript, /\$\{BASH_REMATCH\[1\],,\}/, "shell helpers must remain compatible with macOS Bash 3.2");
assert.match(commonScript, /tr '\[:upper:\]' '\[:lower:\]'/, "Windows drive letters should use portable lowercase conversion");
assert.match(commonScript, /PI_WEZTERM_EXECUTABLE/, "WezTerm discovery should support an explicit executable override");
assert.match(commonScript, /\/Applications\/WezTerm\.app\/Contents\/MacOS\/wezterm/, "WezTerm discovery should support the standard macOS app bundle");

const launchScript = readFileSync(path.join(scriptsRoot, "wezterm", "launch-wezterm.sh"), "utf8");
assert.match(launchScript, /PI_WEZTERM_PANE_SHELL/, "pane shell selection should support zsh and other configured shells");
assert.match(launchScript, /PI_WEZTERM_RESOLVED_PANE_SHELL/, "pane commands should continue interactively in the resolved shell");

const overrideDirectory = mkdtempSync(path.join(tmpdir(), "pi-wezterm-override-"));
try {
  const overrideExecutable = path.join(overrideDirectory, "custom wezterm");
  writeFileSync(overrideExecutable, "#!/usr/bin/env bash\nprintf 'custom wezterm %s\\n' \"$*\"\n", "utf8");
  chmodSync(overrideExecutable, 0o755);
  const overrideResult = spawnSync(
    bashExecutable,
    ["-c", "source \"$1\" \"\"; ensure_command_on_path wezterm && wezterm --version", "bash", path.join(scriptsRoot, "wezterm", "wezterm-common.sh")],
    { cwd: repositoryRoot, encoding: "utf8", env: { ...process.env, PI_WEZTERM_EXECUTABLE: overrideExecutable } },
  );
  assert.equal(overrideResult.status, 0, overrideResult.stderr);
  assert.equal(overrideResult.stdout.trim(), "custom wezterm --version", "explicit WezTerm overrides should preserve argument boundaries");
} finally {
  rmSync(overrideDirectory, { recursive: true, force: true });
}

for (const shellFile of shellFiles) {
  const syntax = spawnSync(bashExecutable, ["-n", shellFile], { cwd: repositoryRoot, encoding: "utf8" });
  assert.equal(syntax.status, 0, `bash -n failed for ${path.relative(repositoryRoot, shellFile)}:\n${syntax.stderr}`);
  assert.equal(readFileSync(shellFile).includes(13), false, `${path.relative(repositoryRoot, shellFile)} contains CR bytes`);
}

const worktreeCheck = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
  cwd: repositoryRoot,
  encoding: "utf8",
});
if (worktreeCheck.status === 0 && worktreeCheck.stdout.trim() === "true") {
  const attributes = spawnSync("git", ["check-attr", "eol", "--", ...shellFiles], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(attributes.status, 0, attributes.stderr);
  for (const line of attributes.stdout.trim().split(/\r?\n/)) {
    assert.match(line, /: eol: lf$/, `unexpected shell eol attribute: ${line}`);
  }
}

const packDirectory = mkdtempSync(path.join(tmpdir(), "pi-wezterm-pack-"));
try {
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, "npm_execpath is required when package validation runs through npm test");
  const packed = spawnSync(process.execPath, [npmCli, "pack", "--pack-destination", packDirectory], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(
    packed.status,
    0,
    `npm pack failed${packed.error ? `: ${packed.error.message}` : ""}:\n${packed.stdout ?? ""}\n${packed.stderr ?? ""}`,
  );

  const archives = readdirSync(packDirectory).filter((name) => name.endsWith(".tgz"));
  assert.equal(archives.length, 1, `expected one package archive, found: ${archives.join(", ")}`);
  const archiveName = archives[0]!;
  const listed = spawnSync("tar", ["-tf", archiveName], { cwd: packDirectory, encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  const packedShellMembers = listed.stdout.split(/\r?\n/).filter((name) => name.endsWith(".sh"));
  assert.equal(packedShellMembers.length, shellFiles.length, "real package should contain every shell script");

  for (const member of packedShellMembers) {
    const extracted = spawnSync("tar", ["-xOf", archiveName, member], { cwd: packDirectory, encoding: null });
    assert.equal(extracted.status, 0, `failed to inspect ${member}: ${extracted.stderr?.toString() ?? ""}`);
    assert.equal(extracted.stdout.includes(13), false, `${member} contains CR bytes in the real package archive`);
  }
} finally {
  rmSync(packDirectory, { recursive: true, force: true });
}

console.log(`PASS: validated bash syntax and packaged LF bytes for ${shellFiles.length} shell scripts`);
