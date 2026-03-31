/**
 * Post-update script — runs after `pnpm build` during /update_portara.
 * Executed from the freshly pulled repo, so new logic here always
 * takes effect on the first /update_portara run.
 *
 * All operations must be idempotent (safe to re-run).
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const HOME = process.env.HOME || "/root";
const WORKSPACE = path.join(HOME, ".openclaw/workspace");

function run(cmd) {
  try {
    execSync(cmd, { stdio: "pipe", shell: "/bin/bash", env: { ...process.env, HOME } });
  } catch {
    // non-fatal
  }
}

// --- Heartbeat + PM2 monitor config ---

run(
  "openclaw config get agents.defaults.heartbeat.every >/dev/null 2>&1 || openclaw config set agents.defaults.heartbeat.every 30m",
);
run(
  "openclaw config get agents.defaults.heartbeat.model >/dev/null 2>&1 || openclaw config set agents.defaults.heartbeat.model openrouter/openrouter/auto",
);
run(
  `openclaw config get agents.defaults.heartbeat.pm2Monitor >/dev/null 2>&1 || openclaw config set agents.defaults.heartbeat.pm2Monitor '{"enabled": true, "logLines": 50, "idleHours": 8}'`,
);

// Ensure HEARTBEAT.md exists
const hbFile = path.join(WORKSPACE, "HEARTBEAT.md");
if (!fs.existsSync(hbFile) || !fs.readFileSync(hbFile, "utf8").includes("HEARTBEAT_OK")) {
  fs.writeFileSync(
    hbFile,
    `# Heartbeat

PM2 error monitoring and idle check-ins are handled automatically in code.
If nothing needs attention, reply HEARTBEAT_OK.
`,
  );
  console.log("[post-update] HEARTBEAT.md created");
}

// --- Ensure AGENTS.md has backtest-prompt reference ---
const agentsFile = path.join(WORKSPACE, "AGENTS.md");
const backtestRef =
  "- **If the task involves backtesting →** read `portara-agent/backtest/backtest-prompt.md` before starting";
if (fs.existsSync(agentsFile)) {
  const lines = fs.readFileSync(agentsFile, "utf8").split("\n");
  if (!lines.some((l) => l.includes("backtest-prompt"))) {
    const idx = lines.findIndex((l) => l.includes("interface-prompt"));
    if (idx !== -1) {
      lines.splice(idx + 1, 0, backtestRef);
    } else {
      // No interface-prompt anchor — insert after "## Reference Prompts" header
      const hdrIdx = lines.findIndex((l) => l.includes("Reference Prompts"));
      if (hdrIdx !== -1) {
        lines.splice(hdrIdx + 1, 0, backtestRef);
      }
    }
    fs.writeFileSync(agentsFile, lines.join("\n"));
    console.log("[post-update] AGENTS.md patched with backtest-prompt reference");
  }
}

// --- Write restart script that uses the local fork binary ---
// spawnGatewayRestart() in old running code may still reference the global
// `openclaw` binary. This writes a restart script using the local entry point
// so that the next gateway restart always uses the freshly built fork.
const OPENPORT_DIR = path.join(HOME, "openport");
const restartScript = `#!/bin/bash
sleep 1
cd "${OPENPORT_DIR}"
node openclaw.mjs gateway stop 2>&1 || true
sleep 2
node openclaw.mjs gateway start --force > /tmp/openclaw-restart.log 2>&1
`;
fs.writeFileSync("/tmp/openclaw-restart.sh", restartScript, { mode: 0o755 });
console.log("[post-update] restart script written to /tmp/openclaw-restart.sh");

console.log("[post-update] openport post-update complete");
