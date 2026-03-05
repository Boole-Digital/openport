/**
 * PM2 process error monitoring — reliable, code-level error collection.
 *
 * Replaces the unreliable HEARTBEAT.md approach where the LLM had to
 * execute shell pipelines. This module runs `pm2 jlist` and `pm2 logs`
 * directly, parses timestamps, filters new errors, and deduplicates
 * by normalized pattern.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createSubsystemLogger } from "../logging/subsystem.js";

const exec = promisify(execFile);
const log = createSubsystemLogger("pm2-monitor");

const STATE_FILENAME = "pm2-monitor-state.json";
const DEFAULT_LOG_LINES = 50;
const DEFAULT_ERROR_PATTERNS = [
  "error",
  "warn",
  "crash",
  "fatal",
  "unhandled",
  "econnrefused",
  "etimedout",
  "enomem",
  "reject",
  "kill",
  "oom",
];

// ISO timestamp in PM2 log lines: [2026-03-05T04:30:00.000Z] or similar
const TIMESTAMP_RE = /\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\]/;

export type ErrorEntry = {
  /** Normalized error pattern (for deduplication). */
  pattern: string;
  /** Number of occurrences since last check. */
  count: number;
  /** ISO timestamp of the latest occurrence. */
  latest: string;
  /** One raw sample line (for context). */
  sample: string;
};

export type ProcessErrors = {
  name: string;
  status: string;
  restarts: number;
  errors: ErrorEntry[];
};

export type Pm2MonitorResult = {
  hasErrors: boolean;
  processes: ProcessErrors[];
  /** ISO timestamp of the latest log line processed (for advancing state). */
  latestTimestamp: string;
  /** The cutoff we used (from state file). */
  previousCheck: string;
};

export type Pm2MonitorState = {
  lastCheck: string;
  /** ISO timestamp of the last idle check-in sent. */
  lastIdleCheckIn?: string;
};

// ─── State persistence ───────────────────────────────────────────────

export async function readPm2MonitorState(stateDir: string): Promise<Pm2MonitorState> {
  const statePath = path.join(stateDir, STATE_FILENAME);
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<Pm2MonitorState>;
    if (typeof parsed.lastCheck === "string" && parsed.lastCheck) {
      return {
        lastCheck: parsed.lastCheck,
        lastIdleCheckIn: parsed.lastIdleCheckIn,
      };
    }
  } catch {
    // Missing or corrupt — default to 1 hour ago
  }
  return { lastCheck: new Date(Date.now() - 3600_000).toISOString() };
}

export async function writePm2MonitorState(
  stateDir: string,
  update: Partial<Pm2MonitorState>,
): Promise<void> {
  await fs.mkdir(stateDir, { recursive: true });
  const statePath = path.join(stateDir, STATE_FILENAME);
  // Merge with existing state so we don't clobber other fields
  let existing: Pm2MonitorState = { lastCheck: new Date().toISOString() };
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    existing = { ...existing, ...JSON.parse(raw) };
  } catch {
    // File may not exist yet
  }
  const merged: Pm2MonitorState = { ...existing, ...update };
  await fs.writeFile(statePath, JSON.stringify(merged));
}

// ─── PM2 process list ────────────────────────────────────────────────

type Pm2JlistEntry = {
  name: string;
  pm_id: number;
  pm2_env?: {
    status?: string;
    restart_time?: number;
    pm_uptime?: number;
  };
};

/** Returns true if any PM2 process is currently online. */
export async function hasRunningPm2Processes(): Promise<boolean> {
  const procs = await getPm2Processes();
  return procs.some((p) => p.pm2_env?.status === "online");
}

async function getPm2Processes(): Promise<Pm2JlistEntry[]> {
  try {
    const { stdout } = await exec("pm2", ["jlist"], { timeout: 10_000 });
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed as Pm2JlistEntry[];
  } catch (err) {
    log.warn("pm2 jlist failed", { error: String(err) });
    return [];
  }
}

// ─── PM2 log parsing ─────────────────────────────────────────────────

type RawLogLine = {
  timestamp: string;
  text: string;
};

async function getProcessLogs(processName: string, lines: number): Promise<string[]> {
  try {
    // pm2 logs sends stderr for err logs; capture both
    const { stdout, stderr } = await exec(
      "pm2",
      ["logs", processName, "--lines", String(lines), "--nostream"],
      { timeout: 15_000 },
    );
    const combined = `${stdout}\n${stderr}`;
    return combined.split("\n").filter((line) => line.trim());
  } catch (err) {
    log.warn(`pm2 logs failed for ${processName}`, { error: String(err) });
    return [];
  }
}

function parseLogLine(line: string): RawLogLine | null {
  const match = TIMESTAMP_RE.exec(line);
  if (!match?.[1]) {
    return null;
  }
  return { timestamp: match[1], text: line };
}

function matchesErrorPattern(line: string, patterns: string[]): boolean {
  const lower = line.toLowerCase();
  return patterns.some((p) => lower.includes(p));
}

// ─── Error deduplication ─────────────────────────────────────────────

/**
 * Normalize an error line for deduplication — strip timestamps, hex IDs,
 * large numbers, and PM2 prefixes so errors differing only in volatile
 * parts are grouped together.
 */
function normalizeErrorPattern(line: string): string {
  return (
    line
      // Strip PM2 prefix: "0|process-name  | "
      .replace(/^\d+\|[^|]+\|\s*/, "")
      // Strip bracketed timestamps
      .replace(/\[\d{4}-\d{2}-\d{2}T[\d:.]+Z?\]/g, "")
      // Strip inline ISO timestamps
      .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "<TS>")
      // Strip hex IDs (8+ hex chars)
      .replace(/\b[0-9a-f]{8,}\b/gi, "<ID>")
      // Strip large numbers (5+ digits)
      .replace(/\b\d{5,}\b/g, "<N>")
      // Collapse whitespace
      .replace(/\s+/g, " ")
      .trim()
  );
}

function deduplicateErrors(lines: RawLogLine[]): ErrorEntry[] {
  const groups = new Map<string, { count: number; latest: string; sample: string }>();

  for (const line of lines) {
    const pattern = normalizeErrorPattern(line.text);
    if (!pattern) {
      continue;
    }
    const existing = groups.get(pattern);
    if (existing) {
      existing.count++;
      if (line.timestamp > existing.latest) {
        existing.latest = line.timestamp;
        existing.sample = line.text;
      }
    } else {
      groups.set(pattern, {
        count: 1,
        latest: line.timestamp,
        sample: line.text,
      });
    }
  }

  return [...groups.entries()].map(([pattern, data]) => ({
    pattern,
    count: data.count,
    latest: data.latest,
    sample: data.sample,
  }));
}

// ─── Main collection ─────────────────────────────────────────────────

export async function collectPm2Errors(opts: {
  lastCheck: string;
  logLines?: number;
  errorPatterns?: string[];
}): Promise<Pm2MonitorResult> {
  const cutoff = opts.lastCheck;
  const logLines = opts.logLines ?? DEFAULT_LOG_LINES;
  const patterns = opts.errorPatterns?.map((p) => p.toLowerCase()) ?? DEFAULT_ERROR_PATTERNS;

  const processes = await getPm2Processes();
  if (processes.length === 0) {
    return { hasErrors: false, processes: [], latestTimestamp: cutoff, previousCheck: cutoff };
  }

  let globalLatest = cutoff;
  const results: ProcessErrors[] = [];

  for (const proc of processes) {
    const name = proc.name;
    const status = proc.pm2_env?.status ?? "unknown";
    const restarts = proc.pm2_env?.restart_time ?? 0;
    const rawLines = await getProcessLogs(name, logLines);

    // Parse and filter
    const errorLines: RawLogLine[] = [];
    for (const raw of rawLines) {
      const parsed = parseLogLine(raw);
      if (!parsed) {
        continue;
      }
      // Track latest timestamp across all processes
      if (parsed.timestamp > globalLatest) {
        globalLatest = parsed.timestamp;
      }
      // Only new lines after cutoff
      if (parsed.timestamp <= cutoff) {
        continue;
      }
      // Only error-matching lines
      if (!matchesErrorPattern(parsed.text, patterns)) {
        continue;
      }
      errorLines.push(parsed);
    }

    const errors = deduplicateErrors(errorLines);
    if (errors.length > 0 || status === "errored" || status === "stopped") {
      results.push({ name, status, restarts, errors });
    }
  }

  const hasErrors = results.some((p) => p.errors.length > 0);
  return { hasErrors, processes: results, latestTimestamp: globalLatest, previousCheck: cutoff };
}

// ─── Formatting ──────────────────────────────────────────────────────

function formatTime(iso: string): string {
  // Extract just the time portion for compact display
  const match = /T([\d:.]+)Z?$/.exec(iso);
  return match?.[1] ?? iso;
}

export function formatErrorSummary(result: Pm2MonitorResult): string {
  const lines: string[] = [];
  lines.push(`PM2 Strategy Errors (since ${formatTime(result.previousCheck)})`);
  lines.push("");

  for (const proc of result.processes) {
    const statusLabel =
      proc.status === "online"
        ? `online, ${proc.restarts} restarts`
        : `${proc.status}, ${proc.restarts} restarts`;
    lines.push(`${proc.name} (${statusLabel})`);

    if (proc.errors.length === 0) {
      lines.push(`- Process ${proc.status} (no new error lines)`);
    } else {
      for (const err of proc.errors) {
        const countLabel = err.count > 1 ? `${err.count} times` : "1 time";
        lines.push(`- ${err.pattern}: ${countLabel} (latest: ${formatTime(err.latest)})`);
      }
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

/**
 * Build a compact error context string for the fix-proposal LLM prompt.
 * Shorter than the user-facing summary — just error patterns and counts.
 */
export function formatErrorContext(result: Pm2MonitorResult): string {
  const parts: string[] = [];
  for (const proc of result.processes) {
    if (proc.errors.length === 0) {
      continue;
    }
    parts.push(`[${proc.name}] (status: ${proc.status}, restarts: ${proc.restarts})`);
    for (const err of proc.errors) {
      parts.push(`  - ${err.pattern} (${err.count}x, sample: ${err.sample.slice(0, 200)})`);
    }
  }
  return parts.join("\n");
}
