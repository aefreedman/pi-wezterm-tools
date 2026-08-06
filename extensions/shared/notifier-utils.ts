import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ReplyKind = "ready" | "attention" | "error";

export interface ReplyState {
  hadToolError: boolean;
  lastAssistantText: string;
  assistantErrored: boolean;
}

export function createReplyState(): ReplyState {
  return {
    hadToolError: false,
    lastAssistantText: "",
    assistantErrored: false,
  };
}

export function text(value: unknown): string {
  return String(value ?? "").trim();
}

export function getEnvValue(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) return value;
  }
  return undefined;
}

export function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const token = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(token)) return true;
    if (["0", "false", "no", "off"].includes(token)) return false;
  }
  return fallback;
}

export function parseIntBounded(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function parseNumberAutoBounded(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(min, Math.min(max, Math.floor(value)));
  }

  const raw = text(value);
  if (!raw) return fallback;

  const parsed = raw.toLowerCase().startsWith("0x") ? Number.parseInt(raw, 16) : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function parseStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const cleaned = value.map((entry) => text(entry)).filter(Boolean);
  return cleaned.length > 0 ? cleaned : fallback;
}

export function getSessionKey(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): string {
  const sessionFile = (ctx.sessionManager as any)?.getSessionFile?.();
  return text(sessionFile) || ctx.cwd;
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content.map((item) => extractTextFromContent(item)).filter(Boolean).join("\n");
  }

  if (!content || typeof content !== "object") return "";

  const data = content as Record<string, unknown>;
  if (typeof data.text === "string") return data.text;
  if (typeof data.content === "string") return data.content;
  if (data.content !== undefined) return extractTextFromContent(data.content);
  return "";
}

export function updateReplyStateFromMessage(state: ReplyState, message: unknown): ReplyState {
  if (!message || typeof message !== "object") return state;

  const data = message as Record<string, unknown>;
  if (text(data.role) !== "assistant") return state;

  const assistantText = extractTextFromContent(data.content);
  const errorMessage = text(data.errorMessage);
  const stopReason = text(data.stopReason).toLowerCase();

  return {
    hadToolError: state.hadToolError,
    lastAssistantText: assistantText || state.lastAssistantText,
    assistantErrored: state.assistantErrored || Boolean(errorMessage) || stopReason === "error",
  };
}

export function updateReplyStateFromMessages(state: ReplyState, messages: unknown): ReplyState {
  if (!Array.isArray(messages)) return state;
  let next = state;
  for (const message of messages) {
    next = updateReplyStateFromMessage(next, message);
  }
  return next;
}

export function classifyReplyState(state: ReplyState): ReplyKind {
  if (state.assistantErrored || state.hadToolError) return "error";
  if (looksLikeQuestion(state.lastAssistantText)) return "attention";
  return "ready";
}

export function looksLikeQuestion(value: string): boolean {
  const trimmed = text(value);
  if (!trimmed) return false;

  const lines = trimmed
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
  const tail = lines.slice(-2);
  const lastLine = tail.length > 0 ? tail[tail.length - 1] : trimmed;
  if (/[?؟]\s*$/.test(lastLine)) return true;

  const tailText = tail.join("\n").toLowerCase();
  return [
    /\bdo you want\b/,
    /\bwould you like\b/,
    /\bcould you\b/,
    /\bcan you\b/,
    /\bplease provide\b/,
    /\blet me know\b/,
    /\bconfirm\b/,
    /\bpick one\b/,
    /\bchoose one\b/,
    /\bselect one\b/,
    /\bwhich option\b/,
    /\bneed your input\b/,
    /\bwhat (?:should|would|do)\b/,
    /\bshould i\b/,
    /\bshould we\b/,
  ].some((pattern) => pattern.test(tailText));
}
