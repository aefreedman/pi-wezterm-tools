import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  getEnvValue,
  getSessionKey,
  parseBoolean,
  parseIntBounded,
  text,
} from "./shared/notifier-utils";
import { runProcess } from "./shared/process-utils";

type WeztermPaneRow = {
  pane_id?: number | string;
  tab_id?: number | string;
  tab_title?: string;
  title?: string;
  is_active?: boolean;
};

type WeztermClientRow = {
  focused_pane_id?: number | string;
};

type NotificationTitle = {
  previousTitle: string;
  notificationText: string;
};

const lastSentAtBySession = new Map<string, number>();
const paneBySession = new Map<string, string>();
const notificationTitlePrefix = "__PI_WTN__|";
let notifyErrorSignature = "";

const macOSWeztermAppExecutable = "/Applications/WezTerm.app/Contents/MacOS/wezterm";

type ExecutableEnvironment = Record<string, string | undefined>;

type WeztermProcessResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnErrorCode?: string;
};

type WeztermProcessRunner = (command: string, args: string[], timeoutMs: number) => Promise<WeztermProcessResult>;

function getEnabled(): boolean {
  const explicit = getEnvValue("PI_WEZTERM_NOTIFY_ENABLED");
  if (explicit !== undefined) return parseBoolean(explicit, true);

  return Boolean(
    process.env.WEZTERM_PANE ||
      process.env.TERM_PROGRAM === "WezTerm" ||
      getEnvValue("PI_WEZTERM_PANE_ID"),
  );
}

function getCooldownMs(): number {
  return parseIntBounded(
    getEnvValue("PI_WEZTERM_NOTIFY_COOLDOWN_MS"),
    8000,
    1000,
    120000,
  );
}

function getCommandTimeoutMs(): number {
  return parseIntBounded(
    getEnvValue("PI_WEZTERM_NOTIFY_TIMEOUT_MS"),
    5000,
    1000,
    30000,
  );
}

function getNotificationText(): string {
  const custom = text(getEnvValue("PI_WEZTERM_NOTIFICATION_TEXT"));
  if (custom) return custom.slice(0, 120);
  return "READY";
}

function resolveWeztermExecutable(environment: ExecutableEnvironment = process.env): string {
  return text(environment.PI_WEZTERM_EXECUTABLE) || "wezterm";
}

function createWeztermCliRunner({
  runProcessImpl = runProcess as WeztermProcessRunner,
  environment = process.env,
  platform = process.platform,
}: {
  runProcessImpl?: WeztermProcessRunner;
  environment?: ExecutableEnvironment;
  platform?: NodeJS.Platform;
} = {}) {
  return async (args: string[]): Promise<WeztermProcessResult> => {
    const executable = resolveWeztermExecutable(environment);
    const result = await runProcessImpl(executable, ["cli", ...args], getCommandTimeoutMs());

    // A standard macOS app install does not always put `wezterm` on PATH.
    // Respect an explicit override, but retry the app bundle after a bare PATH lookup fails.
    if (!text(environment.PI_WEZTERM_EXECUTABLE)
      && platform === "darwin"
      && executable === "wezterm"
      && result.spawnErrorCode === "ENOENT") {
      return await runProcessImpl(macOSWeztermAppExecutable, ["cli", ...args], getCommandTimeoutMs());
    }

    return result;
  };
}

function weztermFailureDetail(result: WeztermProcessResult): string {
  if (result.spawnErrorCode === "ENOENT") {
    return "WezTerm CLI executable was not found (ENOENT). Set PI_WEZTERM_EXECUTABLE to its full path or add wezterm to PATH.";
  }

  return text(result.stderr) || `exit ${result.exitCode}`;
}

function encodeTitlePart(value: string): string {
  return encodeURIComponent(value);
}

function decodeTitlePart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseNotificationTitle(raw: string): NotificationTitle | undefined {
  if (!raw.startsWith(notificationTitlePrefix)) return undefined;

  const rest = raw.slice(notificationTitlePrefix.length);
  const separator = rest.indexOf("|");
  if (separator < 0) return undefined;

  return {
    previousTitle: decodeTitlePart(rest.slice(0, separator)),
    notificationText: decodeTitlePart(rest.slice(separator + 1)),
  };
}

function buildNotificationTitle(previousTitle: string, notificationText: string): string {
  return `${notificationTitlePrefix}${encodeTitlePart(previousTitle)}|${encodeTitlePart(notificationText)}`;
}

function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/^pi\s*\|\s*/i, "")
    .replace(/\.\.\.$/, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sharedPrefixLen(a: string, b: string): number {
  let i = 0;
  const max = Math.min(a.length, b.length);
  while (i < max && a[i] === b[i]) i += 1;
  return i;
}

function scorePaneTitle(sessionTitle: string, paneTitle: string): number {
  const sessionNorm = normalizeForMatch(sessionTitle);
  const paneNorm = normalizeForMatch(paneTitle);
  if (!sessionNorm || !paneNorm) return 0;

  if (paneNorm.includes(sessionNorm)) return 1000;
  if (sessionNorm.includes(paneNorm) && paneNorm.length >= 10) return 850;

  const prefix = sharedPrefixLen(sessionNorm, paneNorm);
  if (prefix >= 10) return 400 + prefix;

  const firstWords = sessionNorm.split(" ").filter(Boolean).slice(0, 4);
  let wordHits = 0;
  for (const word of firstWords) {
    if (word.length >= 3 && paneNorm.includes(word)) wordHits += 1;
  }
  return wordHits * 60;
}

function parseRows(stdout: string): WeztermPaneRow[] {
  try {
    const rows = JSON.parse(stdout) as WeztermPaneRow[];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function parseClientRows(stdout: string): WeztermClientRow[] {
  try {
    const rows = JSON.parse(stdout) as WeztermClientRow[];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function isPaneFocused(clientRows: WeztermClientRow[], paneID: string): boolean {
  return clientRows.some((row) => text(row.focused_pane_id) === paneID);
}

function hasRecentlyNotified(sessionKey: string): boolean {
  const last = lastSentAtBySession.get(sessionKey);
  return Boolean(last && Date.now() - last < getCooldownMs());
}

function getExplicitPaneID(): string {
  return text(getEnvValue("PI_WEZTERM_PANE_ID"));
}

function getCurrentPaneID(): string {
  return getExplicitPaneID() || text(process.env.WEZTERM_PANE);
}

const runWeztermCli = createWeztermCliRunner();

async function resolveTargetPaneID(
  sessionKey: string,
  sessionTitle: string,
  rows: WeztermPaneRow[],
): Promise<{ paneID: string; strategy: string; score?: number }> {
  const currentPaneID = getCurrentPaneID();
  if (currentPaneID && rows.some((row) => text(row.pane_id) === currentPaneID)) {
    return { paneID: currentPaneID, strategy: getExplicitPaneID() ? "explicit-env" : "WEZTERM_PANE" };
  }

  const cachedPaneID = paneBySession.get(sessionKey);
  if (cachedPaneID && rows.some((row) => text(row.pane_id) === cachedPaneID)) {
    return { paneID: cachedPaneID, strategy: "session-cache" };
  }

  if (sessionTitle) {
    let bestPaneID = "";
    let bestScore = 0;
    for (const row of rows) {
      const paneID = text(row.pane_id);
      const paneTitle = text(row.title);
      const score = scorePaneTitle(sessionTitle, paneTitle);
      if (score > bestScore) {
        bestScore = score;
        bestPaneID = paneID;
      }
    }

    if (bestPaneID && bestScore >= 180) {
      return { paneID: bestPaneID, strategy: "session-title-match", score: bestScore };
    }
  }

  return { paneID: "", strategy: "none" };
}

function logWeztermWarning(message: string, detail: string) {
  const signature = `${message}|${detail}`;
  if (signature === notifyErrorSignature) return;
  notifyErrorSignature = signature;
  console.warn(`[wezterm-tab-flash-notifier] ${message}: ${detail}`);
}

async function flashTab(sessionKey: string, sessionTitle: string): Promise<void> {
  const listed = await runWeztermCli(["list", "--format", "json"]);
  if (listed.timedOut) {
    logWeztermWarning("list timed out", sessionKey);
    return;
  }
  if (listed.exitCode !== 0) {
    logWeztermWarning("list failed", weztermFailureDetail(listed));
    return;
  }

  const rows = parseRows(listed.stdout);
  const resolved = await resolveTargetPaneID(sessionKey, sessionTitle, rows);
  if (!resolved.paneID) return;

  const pane = rows.find((row) => text(row.pane_id) === resolved.paneID);
  if (!pane) return;

  if (pane.is_active === true) return;

  const listedClients = await runWeztermCli(["list-clients", "--format", "json"]);
  if (!listedClients.timedOut && listedClients.exitCode === 0) {
    const clients = parseClientRows(listedClients.stdout);
    if (isPaneFocused(clients, resolved.paneID)) return;
  }

  const tabID = text(pane.tab_id);
  const tabTitle = text(pane.tab_title);
  const existing = parseNotificationTitle(tabTitle);
  const previousTitle = existing?.previousTitle ?? tabTitle;
  const notificationTitle = buildNotificationTitle(previousTitle, getNotificationText());

  const setMarker = await runWeztermCli(["set-tab-title", "--tab-id", tabID, notificationTitle]);
  if (setMarker.timedOut || setMarker.exitCode !== 0) {
    logWeztermWarning("set-tab-title failed", weztermFailureDetail(setMarker));
    return;
  }

  paneBySession.set(sessionKey, resolved.paneID);
}

function deriveSessionTitle(pi: ExtensionAPI, cwd: string): string {
  return pi.getSessionName() || path.basename(cwd);
}

function seedCurrentPane(ctx: { cwd: string; sessionManager: unknown }): void {
  const sessionKey = getSessionKey(ctx as any);
  const paneID = getCurrentPaneID();
  if (paneID) paneBySession.set(sessionKey, paneID);
}

export const __weztermTabFlashNotifierInternals = {
  buildNotificationTitle,
  parseNotificationTitle,
  getNotificationText,
  normalizeForMatch,
  scorePaneTitle,
  resolveWeztermExecutable,
  createWeztermCliRunner,
  macOSWeztermAppExecutable,
  weztermFailureDetail,
};

export default function weztermTabFlashNotifier(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    seedCurrentPane(ctx);
  });

  pi.on("agent_start", async (_event, ctx) => {
    seedCurrentPane(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const key = getSessionKey(ctx);
    lastSentAtBySession.delete(key);
    paneBySession.delete(key);
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!getEnabled()) return;

    const key = getSessionKey(ctx);
    if (hasRecentlyNotified(key)) return;
    lastSentAtBySession.set(key, Date.now());

    await flashTab(key, deriveSessionTitle(pi, ctx.cwd));
  });
}
