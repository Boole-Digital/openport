import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectPm2Errors,
  formatErrorContext,
  formatErrorSummary,
  readPm2MonitorState,
  writePm2MonitorState,
} from "./pm2-monitor.js";

// vi.hoisted runs before vi.mock factories, making execMockFn available.
const { execMockFn } = vi.hoisted(() => {
  const execMockFn =
    vi.fn<
      (
        cmd: string,
        args: string[],
        opts: Record<string, unknown>,
      ) => Promise<{ stdout: string; stderr: string }>
    >();
  return { execMockFn };
});

vi.mock("node:util", async () => {
  const actual = await vi.importActual<typeof import("node:util")>("node:util");
  return {
    ...actual,
    promisify: () => execMockFn,
  };
});

function mockExecReturn(stdout: string, stderr = "") {
  execMockFn.mockResolvedValueOnce({ stdout, stderr });
}

function mockExecReject(err: Error) {
  execMockFn.mockRejectedValueOnce(err);
}

describe("pm2-monitor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("readPm2MonitorState / writePm2MonitorState", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp("/tmp/pm2-monitor-test-");
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("returns default (1h ago) when state file missing", async () => {
      const state = await readPm2MonitorState(tmpDir);
      expect(state.lastCheck).toBeTruthy();
      const ts = new Date(state.lastCheck).getTime();
      const hourAgo = Date.now() - 3600_000;
      // Should be approximately 1 hour ago (within 5s tolerance)
      expect(Math.abs(ts - hourAgo)).toBeLessThan(5000);
    });

    it("round-trips state correctly", async () => {
      const timestamp = "2026-03-05T04:30:00.000Z";
      await writePm2MonitorState(tmpDir, { lastCheck: timestamp });
      const state = await readPm2MonitorState(tmpDir);
      expect(state.lastCheck).toBe(timestamp);
    });

    it("handles corrupt state file", async () => {
      await fs.writeFile(path.join(tmpDir, "pm2-monitor-state.json"), "not json");
      const state = await readPm2MonitorState(tmpDir);
      expect(state.lastCheck).toBeTruthy();
    });
  });

  describe("collectPm2Errors", () => {
    it("returns empty when pm2 jlist fails", async () => {
      mockExecReject(new Error("pm2 not found"));
      const result = await collectPm2Errors({ lastCheck: "2026-03-05T04:00:00Z" });
      expect(result.hasErrors).toBe(false);
      expect(result.processes).toEqual([]);
    });

    it("returns empty when no processes", async () => {
      mockExecReturn("[]");
      const result = await collectPm2Errors({ lastCheck: "2026-03-05T04:00:00Z" });
      expect(result.hasErrors).toBe(false);
    });

    it("collects and deduplicates errors from PM2 logs", async () => {
      // Mock pm2 jlist
      mockExecReturn(
        JSON.stringify([
          { name: "eth-long", pm_id: 0, pm2_env: { status: "online", restart_time: 2 } },
        ]),
      );
      // Mock pm2 logs for eth-long (stderr is where pm2 logs output often goes)
      const logs = [
        "[2026-03-05T05:00:00.000Z] 0|eth-long  | Error: tick execution failed",
        "[2026-03-05T05:01:00.000Z] 0|eth-long  | Error: tick execution failed",
        "[2026-03-05T05:02:00.000Z] 0|eth-long  | Error: tick execution failed",
        "[2026-03-05T05:03:00.000Z] 0|eth-long  | WARN: ECONNREFUSED on price feed",
        "[2026-03-05T03:50:00.000Z] 0|eth-long  | Error: old error before cutoff",
      ].join("\n");
      mockExecReturn("", logs);

      const result = await collectPm2Errors({ lastCheck: "2026-03-05T04:00:00Z" });
      expect(result.hasErrors).toBe(true);
      expect(result.processes).toHaveLength(1);

      const proc = result.processes[0];
      expect(proc.name).toBe("eth-long");
      expect(proc.status).toBe("online");
      expect(proc.restarts).toBe(2);

      // Should have 2 deduplicated error patterns (not 4 raw lines)
      expect(proc.errors).toHaveLength(2);

      // Tick errors should be grouped (3 occurrences)
      const tickError = proc.errors.find((e) => e.pattern.includes("tick execution"));
      expect(tickError).toBeDefined();
      expect(tickError!.count).toBe(3);
      expect(tickError!.latest).toBe("2026-03-05T05:02:00.000Z");

      // ECONNREFUSED (1 occurrence)
      const connError = proc.errors.find((e) => e.pattern.includes("ECONNREFUSED"));
      expect(connError).toBeDefined();
      expect(connError!.count).toBe(1);
    });

    it("filters out lines before cutoff", async () => {
      mockExecReturn(
        JSON.stringify([
          { name: "btc-scalper", pm_id: 1, pm2_env: { status: "online", restart_time: 0 } },
        ]),
      );
      const logs = [
        "[2026-03-05T03:00:00.000Z] 1|btc-scalper | Error: old error",
        "[2026-03-05T03:30:00.000Z] 1|btc-scalper | Error: also old",
      ].join("\n");
      mockExecReturn("", logs);

      const result = await collectPm2Errors({ lastCheck: "2026-03-05T04:00:00Z" });
      expect(result.hasErrors).toBe(false);
    });

    it("tracks latestTimestamp across processes", async () => {
      mockExecReturn(
        JSON.stringify([
          { name: "proc-a", pm_id: 0, pm2_env: { status: "online", restart_time: 0 } },
          { name: "proc-b", pm_id: 1, pm2_env: { status: "online", restart_time: 0 } },
        ]),
      );
      // proc-a logs
      mockExecReturn("", "[2026-03-05T05:00:00.000Z] 0|proc-a | Error: something");
      // proc-b logs
      mockExecReturn("", "[2026-03-05T06:00:00.000Z] 1|proc-b | Error: something else");

      const result = await collectPm2Errors({ lastCheck: "2026-03-05T04:00:00Z" });
      expect(result.latestTimestamp).toBe("2026-03-05T06:00:00.000Z");
    });

    it("includes errored/stopped processes even without error lines", async () => {
      mockExecReturn(
        JSON.stringify([
          { name: "crashed", pm_id: 0, pm2_env: { status: "errored", restart_time: 10 } },
        ]),
      );
      mockExecReturn("", ""); // No log lines

      const result = await collectPm2Errors({ lastCheck: "2026-03-05T04:00:00Z" });
      expect(result.processes).toHaveLength(1);
      expect(result.processes[0].name).toBe("crashed");
      expect(result.processes[0].status).toBe("errored");
    });
  });

  describe("formatErrorSummary", () => {
    it("formats a readable summary", () => {
      const summary = formatErrorSummary({
        hasErrors: true,
        previousCheck: "2026-03-05T04:30:00.000Z",
        latestTimestamp: "2026-03-05T06:40:55.000Z",
        processes: [
          {
            name: "eth-long",
            status: "online",
            restarts: 3,
            errors: [
              {
                pattern: "Error: tick execution failed",
                count: 8,
                latest: "2026-03-05T06:40:55.000Z",
                sample: "Error: tick execution failed",
              },
              {
                pattern: "ECONNREFUSED on price feed",
                count: 2,
                latest: "2026-03-05T06:38:12.000Z",
                sample: "ECONNREFUSED on price feed",
              },
            ],
          },
        ],
      });

      expect(summary).toContain("PM2 Strategy Errors");
      expect(summary).toContain("eth-long");
      expect(summary).toContain("8 times");
      expect(summary).toContain("2 times");
      expect(summary).toContain("ECONNREFUSED");
    });

    it("handles process with no error lines but bad status", () => {
      const summary = formatErrorSummary({
        hasErrors: false,
        previousCheck: "2026-03-05T04:00:00Z",
        latestTimestamp: "2026-03-05T04:00:00Z",
        processes: [
          {
            name: "crashed-proc",
            status: "errored",
            restarts: 15,
            errors: [],
          },
        ],
      });
      expect(summary).toContain("crashed-proc");
      expect(summary).toContain("errored");
    });
  });

  describe("formatErrorContext", () => {
    it("produces compact context for LLM prompt", () => {
      const ctx = formatErrorContext({
        hasErrors: true,
        previousCheck: "2026-03-05T04:00:00Z",
        latestTimestamp: "2026-03-05T06:00:00Z",
        processes: [
          {
            name: "eth-long",
            status: "online",
            restarts: 2,
            errors: [
              {
                pattern: "Error: tick execution failed",
                count: 5,
                latest: "2026-03-05T06:00:00Z",
                sample: "[2026-03-05T06:00:00.000Z] Error: tick execution failed",
              },
            ],
          },
        ],
      });
      expect(ctx).toContain("[eth-long]");
      expect(ctx).toContain("5x");
      expect(ctx).toContain("tick execution");
    });
  });
});
