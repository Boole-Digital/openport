import { exec, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ReplyPayload } from "../types.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";
import { isRoutableChannel, routeReply } from "./route-reply.js";

const execAsync = promisify(exec);

const TOKEN_FILE = join(homedir(), ".portara-agent-token");
const AGENT_DIR = join(homedir(), ".openclaw/workspace/portara-agent");
const WORKSPACE_DIR = join(homedir(), ".openclaw/workspace");
const OPENPORT_DIR = join(homedir(), "openport");

async function runScript(
  script: string,
  timeoutMs: number,
): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execAsync(script, {
      shell: "/bin/bash",
      timeout: timeoutMs,
      env: { ...process.env, HOME: homedir() },
    });
    const output = (stdout + (stderr ? `\n${stderr}` : "")).trim();
    return { ok: true, output };
  } catch (err) {
    const error = err as Error & { stdout?: string; stderr?: string };
    const output = [error.stdout, error.stderr, error.message].filter(Boolean).join("\n").trim();
    return { ok: false, output };
  }
}

function updatePortaraAgent(): Promise<{ ok: boolean; output: string }> {
  return runScript(
    `
set -e
if [ ! -f "${TOKEN_FILE}" ]; then
  echo "ERROR: Token file not found at ${TOKEN_FILE}"
  exit 1
fi
GH_TOKEN=$(cat "${TOKEN_FILE}")

cd "${AGENT_DIR}"
git remote set-url origin "https://\${GH_TOKEN}@github.com/Boole-Digital/portara-agent.git"

# Back up user .env files before reset (they are git-tracked and would be overwritten)
cp -f "${AGENT_DIR}/v3/.env" /tmp/_portara_v3_env.bak 2>/dev/null || true
cp -f "${AGENT_DIR}/code-sync/.env" /tmp/_portara_cs_env.bak 2>/dev/null || true

git fetch origin main 2>&1
git reset --hard origin/main 2>&1
git remote set-url origin "https://github.com/Boole-Digital/portara-agent.git"

# Restore user .env files
cp -f /tmp/_portara_v3_env.bak "${AGENT_DIR}/v3/.env" 2>/dev/null || true
cp -f /tmp/_portara_cs_env.bak "${AGENT_DIR}/code-sync/.env" 2>/dev/null || true
rm -f /tmp/_portara_v3_env.bak /tmp/_portara_cs_env.bak

cd "${AGENT_DIR}/v3"
npm install 2>&1

ln -sfn v3/node_modules "${AGENT_DIR}/node_modules"
ln -sfn "${AGENT_DIR}/v3/node_modules" "${WORKSPACE_DIR}/node_modules"

echo "portara-agent updated successfully"
`,
    120_000,
  );
}

function buildOpenport(): Promise<{ ok: boolean; output: string }> {
  return runScript(
    `
set -e
cd "${OPENPORT_DIR}"
git fetch origin main 2>&1
git reset --hard origin/main 2>&1
rm -rf dist node_modules 2>&1
pnpm install 2>&1
pnpm build 2>&1
# Run post-update script from freshly pulled repo (if it exists)
[ -f "${OPENPORT_DIR}/scripts/post-update.cjs" ] && node "${OPENPORT_DIR}/scripts/post-update.cjs" 2>&1 || true
echo "openport build successful"
`,
    600_000,
  );
}

// Spawns a detached script that stops and restarts the gateway.
// Must be detached because `gateway stop` kills the current process.
function spawnGatewayRestart(): void {
  const child = spawn(
    "/bin/bash",
    [
      "-c",
      `
if [ -x /tmp/openclaw-restart.sh ]; then
  exec /tmp/openclaw-restart.sh
fi
sleep 1
cd "${OPENPORT_DIR}"
node openclaw.mjs gateway stop 2>&1 || true
sleep 2
node openclaw.mjs gateway start --force > /tmp/openclaw-restart.log 2>&1
`,
    ],
    {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, HOME: homedir() },
    },
  );
  child.unref();
}

function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `…${text.slice(text.length - max)}`;
}

export const handleUpdatePortaraCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  const body = params.command.commandBodyNormalized;
  if (body !== "/update_portara" && !body.startsWith("/update_portara ")) {
    return null;
  }

  const unauthorized = rejectUnauthorizedCommand(params, "/update_portara");
  if (unauthorized) {
    return unauthorized;
  }

  const originChannel = params.ctx.OriginatingChannel;
  const originTo = params.ctx.OriginatingTo ?? params.command.from ?? params.command.to;

  const sendStatus = async (text: string) => {
    if (originChannel && originTo && isRoutableChannel(originChannel)) {
      await routeReply({
        payload: { text },
        channel: originChannel,
        to: originTo,
        sessionKey: params.sessionKey,
        accountId: params.ctx.AccountId,
        threadId: params.ctx.MessageThreadId,
        cfg: params.cfg,
        mirror: false,
      });
    }
  };

  await sendStatus(
    "\u23F3 Updating your agent \u2014 this takes a few minutes. You'll receive a message when it's done.",
  );

  // Step 1: Update trading tools (portara-agent)
  const agentResult = await updatePortaraAgent();
  if (!agentResult.ok) {
    const reply: ReplyPayload = {
      text: `\u274C Update failed.\n\n${truncate(agentResult.output, 2000)}`,
    };
    return { shouldContinue: false, reply };
  }

  // Step 2: Update agent core (openport — git pull + pnpm install + pnpm build)
  const buildResult = await buildOpenport();
  if (!buildResult.ok) {
    const reply: ReplyPayload = {
      text: `\u274C Update failed.\n\n${truncate(buildResult.output, 2000)}`,
    };
    return { shouldContinue: false, reply };
  }

  // Step 3: Spawn detached restart (gateway stop + start --force)
  // This runs in a detached process so it survives the gateway shutdown.
  spawnGatewayRestart();

  const reply: ReplyPayload = {
    text: "\u2705 Agent updated successfully.",
  };
  return { shouldContinue: false, reply };
};
