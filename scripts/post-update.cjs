/**
 * Post-update script — runs after `pnpm build` during /update_portara.
 * Executed from the freshly pulled repo, so new logic here always
 * takes effect on the first /update_portara run.
 *
 * All operations must be idempotent (safe to re-run).
 */
const { execSync } = require("child_process");
const crypto = require("crypto");
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

// --- Polymarket builder keys injection ---
// Encrypted with scripts/encrypt-poly-keys.cjs — obfuscated, not high-security.
// To regenerate: node scripts/encrypt-poly-keys.cjs <key> <secret> <passphrase>
const POLY_CFG = {
  k: "",
  s: "",
  p: "",
};

const _POLY_SEED = "portara-v3-deploy-cfg-2026";

function _polyDeobfuscate(packed) {
  if (!packed) {
    return "";
  }
  const [ivB64, encB64] = packed.split(":");
  if (!ivB64 || !encB64) {
    return "";
  }
  const key = crypto.createHash("sha256").update(_POLY_SEED).digest();
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, Buffer.from(ivB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encB64, "base64")), decipher.final()]).toString(
    "utf8",
  );
}

function ensurePolyBuilderKeys() {
  // Skip if encrypted config not populated yet
  if (!POLY_CFG.k || !POLY_CFG.s || !POLY_CFG.p) {
    return;
  }

  const envFile = path.join(WORKSPACE, "portara-agent/v3/.env");
  if (!fs.existsSync(envFile)) {
    return;
  }

  const content = fs.readFileSync(envFile, "utf8");

  // Check if builder keys are already populated (non-empty value after =)
  const hasKey = /^POLYMARKET_BUILDER_KEY=.+$/m.test(content);
  if (hasKey) {
    return;
  }

  try {
    const builderKey = _polyDeobfuscate(POLY_CFG.k);
    const builderSecret = _polyDeobfuscate(POLY_CFG.s);
    const builderPassphrase = _polyDeobfuscate(POLY_CFG.p);

    if (!builderKey) {
      return;
    }

    // Remove any existing empty builder key lines
    let updated = content
      .replace(/^POLYMARKET_BUILDER_KEY=\s*$/gm, "")
      .replace(/^POLYMARKET_BUILDER_SECRET=\s*$/gm, "")
      .replace(/^POLYMARKET_BUILDER_PASSPHRASE=\s*$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd();

    updated += `\nPOLYMARKET_BUILDER_KEY=${builderKey}\n`;
    updated += `POLYMARKET_BUILDER_SECRET=${builderSecret}\n`;
    updated += `POLYMARKET_BUILDER_PASSPHRASE=${builderPassphrase}\n`;

    fs.writeFileSync(envFile, updated);
    console.log("[post-update] polymarket builder keys injected");

    // Run ensure-approvals if polymarket is configured
    const hasPolyPk = /^POLYMARKET_PRIVATE_KEY=.+$/m.test(updated);
    if (hasPolyPk) {
      console.log("[post-update] running ensure-approvals...");
      run(
        `cd "${path.join(WORKSPACE, "portara-agent/v3")}" && node scripts/ensure-approvals.js 2>&1`,
      );
    }
  } catch (err) {
    console.error("[post-update] poly builder key injection failed:", err.message);
  }
}

ensurePolyBuilderKeys();

console.log("[post-update] openport post-update complete");
