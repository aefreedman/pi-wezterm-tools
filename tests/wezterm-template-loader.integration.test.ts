import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoot = mkdtempSync(path.join(tmpdir(), "pi-wezterm-loader-"));
const bashExecutable = process.env.PI_WEZTERM_TEST_BASH?.trim() || "bash";

function writeTemplate(filePath: string, workspace: string, command?: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tabs = command ? [{ title: "test", panes: [{ command }] }] : [];
  writeFileSync(
    filePath,
    JSON.stringify({ name: workspace, description: `${workspace} template`, version: "1", workspace, tabs }),
    "utf8",
  );
}

try {
  const fixtureRoot = path.join(temporaryRoot, "package fixture");
  const scriptsDir = path.join(fixtureRoot, "scripts", "wezterm");
  const projectDir = path.join(temporaryRoot, "project with spaces");
  const globalDir = path.join(temporaryRoot, "global templates");
  const binDir = path.join(temporaryRoot, "stub bin");
  const captureArgs = path.join(temporaryRoot, "captured-args.bin");
  const captureStdin = path.join(temporaryRoot, "captured-stdin.json");

  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(globalDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  copyFileSync(path.join(repositoryRoot, "scripts", "wezterm", "wezterm-load-template.sh"), path.join(scriptsDir, "wezterm-load-template.sh"));
  copyFileSync(path.join(repositoryRoot, "scripts", "wezterm", "wezterm-template.sh"), path.join(scriptsDir, "wezterm-template.sh"));
  copyFileSync(path.join(repositoryRoot, "scripts", "wezterm", "wezterm-common.sh"), path.join(scriptsDir, "wezterm-common.sh"));

  const launchStub = path.join(scriptsDir, "launch-wezterm.sh");
  writeFileSync(
    launchStub,
    `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\0' "$@" > "$CAPTURE_ARGS"\ncat > "$CAPTURE_STDIN"\n`,
    "utf8",
  );
  chmodSync(launchStub, 0o644);
  assert.equal(statSync(launchStub).mode & 0o111, 0, "launch fixture must deliberately be non-executable");

  const weztermStub = path.join(binDir, "wezterm");
  writeFileSync(weztermStub, "#!/usr/bin/env bash\nexit 0\n", "utf8");
  chmodSync(weztermStub, 0o755);

  const loader = path.join(scriptsDir, "wezterm-load-template.sh");
  const environment = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    PI_WEZTERM_GLOBAL_TEMPLATES_DIR: globalDir,
    CAPTURE_ARGS: captureArgs,
    CAPTURE_STDIN: captureStdin,
  };

  function runLoader(args: string[]) {
    rmSync(captureArgs, { force: true });
    rmSync(captureStdin, { force: true });
    return spawnSync(bashExecutable, [loader, ...args], {
      cwd: projectDir,
      env: environment,
      encoding: "utf8",
    });
  }

  function capturedArguments(): string[] {
    const fields = readFileSync(captureArgs).toString("utf8").split("\0");
    assert.equal(fields.pop(), "", "argument capture should end at a NUL boundary");
    return fields;
  }

  const globalTemplate = path.join(globalDir, "safe-template.json");
  writeTemplate(globalTemplate, "global workspace");

  const globalResult = runLoader([
    "--name",
    "safe-template",
    "--use-mux",
    "--no-check-existing",
    "--on-existing",
    "policy with spaces",
    "--domain-name",
    "domain with spaces",
  ]);
  assert.equal(globalResult.status, 0, globalResult.stderr);
  assert.deepEqual(capturedArguments(), [
    "--config-stdin",
    "--use-mux",
    "--no-check-existing",
    "--on-existing",
    "policy with spaces",
    "--domain-name",
    "domain with spaces",
  ], "nested launch arguments should retain exact boundaries");
  assert.deepEqual(JSON.parse(readFileSync(captureStdin, "utf8")), JSON.parse(readFileSync(globalTemplate, "utf8")));
  assert.match(globalResult.stderr, /Resolved template source: user-global/);
  assert.match(globalResult.stderr, /Resolved template path: .*global templates.*safe-template\.json/);

  const dangerousValue = `safe; touch ${path.join(temporaryRoot, "injection-marker")}`;
  const commandContexts = [
    "printf '%s\\n' {{VALUE}}",
    "printf '%s\\n' '{{VALUE}}'",
    "printf '%s\\n' $'{{VALUE}}'",
    "printf '%s\\n' \"$({{VALUE}})\"",
    `cat <<'EOF'
{{VALUE}}
EOF`,
  ];
  for (const [index, command] of commandContexts.entries()) {
    const templateName = `command-context-${index}`;
    writeTemplate(path.join(globalDir, `${templateName}.json`), templateName, command);
    const result = runLoader(["--name", templateName, "--variables", `VALUE=${dangerousValue}`]);
    assert.equal(result.status, 2, `${command} must require command-variable opt-in: ${result.stderr}`);
    assert.match(result.stderr, /requires --allow-command-variables/);
    assert.equal(existsSync(captureArgs), false, "unapproved command variables must fail before launch");
  }

  const approvedPartialResult = runLoader([
    "--name",
    "command-context-0",
    "--variables",
    `VALUE=${dangerousValue}`,
    "--allow-command-variables",
  ]);
  assert.equal(approvedPartialResult.status, 0, approvedPartialResult.stderr);
  assert.equal(
    JSON.parse(readFileSync(captureStdin, "utf8")).tabs[0].panes[0].command,
    `printf '%s\\n' ${dangerousValue}`,
  );

  writeTemplate(path.join(globalDir, "whole-command.json"), "whole command", "{{RUN_CMD}}");
  const unapprovedCommandResult = runLoader(["--name", "whole-command", "--variables", "RUN_CMD=echo trusted"]);
  assert.equal(unapprovedCommandResult.status, 2, unapprovedCommandResult.stderr);
  assert.match(unapprovedCommandResult.stderr, /requires --allow-command-variables/);
  assert.equal(existsSync(captureArgs), false, "whole-command variables must fail before launch without opt-in");

  const approvedCommandResult = runLoader([
    "--name",
    "whole-command",
    "--variables",
    "RUN_CMD=echo trusted",
    "--allow-command-variables",
  ]);
  assert.equal(approvedCommandResult.status, 0, approvedCommandResult.stderr);
  assert.equal(JSON.parse(readFileSync(captureStdin, "utf8")).tabs[0].panes[0].command, "echo trusted");

  const projectTemplate = path.join(projectDir, ".pi", "wezterm-templates", "safe-template.json");
  writeTemplate(projectTemplate, "project workspace");

  const shadowedResult = runLoader(["--name", "safe-template"]);
  assert.equal(shadowedResult.status, 2, shadowedResult.stderr);
  assert.match(shadowedResult.stderr, /shadows another template source and requires explicit opt-in/);
  assert.equal(existsSync(captureArgs), false, "unapproved project shadowing must not invoke the launcher");

  const approvedResult = runLoader(["--name", "safe-template", "--allow-project-template"]);
  assert.equal(approvedResult.status, 0, approvedResult.stderr);
  assert.match(approvedResult.stderr, /Resolved template source: project-local/);
  assert.match(approvedResult.stderr, /Resolved template path: .*project with spaces.*safe-template\.json/);
  assert.equal(JSON.parse(readFileSync(captureStdin, "utf8")).workspace, "project workspace");

  writeTemplate(path.join(projectDir, ".pi", "wezterm-templates", "local-only.json"), "local only");
  const unapprovedLocalOnlyResult = runLoader(["--name", "local-only"]);
  assert.equal(unapprovedLocalOnlyResult.status, 2, unapprovedLocalOnlyResult.stderr);
  assert.match(unapprovedLocalOnlyResult.stderr, /requires explicit opt-in/);
  assert.equal(existsSync(captureArgs), false, "every project-local template must require explicit opt-in");

  const unsafeNames = ["..", "../safe-template", "folder/name", "folder\\name", "safe..template", "name with spaces", "name;$HOME"];
  for (const unsafeName of unsafeNames) {
    const unsafeResult = runLoader(["--name", unsafeName, "--allow-project-template"]);
    assert.equal(unsafeResult.status, 2, `unsafe template name ${JSON.stringify(unsafeName)} should fail`);
    assert.match(unsafeResult.stderr, /Invalid template name/);
    assert.equal(existsSync(captureArgs), false, "unsafe names must not invoke the launcher");
  }

  const templateManager = path.join(scriptsDir, "wezterm-template.sh");
  for (const unsafeName of unsafeNames) {
    const unsafeResult = spawnSync(bashExecutable, [templateManager, "--action", "info", "--name", unsafeName], {
      cwd: projectDir,
      env: environment,
      encoding: "utf8",
    });
    assert.equal(unsafeResult.status, 2, `template management must reject ${JSON.stringify(unsafeName)}`);
    assert.match(unsafeResult.stderr, /Invalid template name/);
  }

  const indexText = readFileSync(path.join(repositoryRoot, "index.ts"), "utf8");
  assert.match(indexText, /allowProjectTemplate: Type\.Optional\(/, "tool schema should expose explicit project trust");
  assert.match(indexText, /if \(params\.allowProjectTemplate\) args\.push\("--allow-project-template"\)/, "tool should forward explicit project trust");
  assert.match(indexText, /allowCommandVariables: Type\.Optional\(/, "tool schema should expose whole-command variable trust");
  assert.match(indexText, /if \(params\.allowCommandVariables\) args\.push\("--allow-command-variables"\)/, "tool should forward whole-command variable trust");

  console.log("PASS: WezTerm template loader integration test succeeded");
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
