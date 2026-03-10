#!/usr/bin/env node
/**
 * One-time helper — encrypts Polymarket builder keys for embedding in post-update.cjs.
 *
 * Usage:
 *   node scripts/encrypt-poly-keys.cjs <builder_key> <builder_secret> <builder_passphrase>
 *
 * Copy the JSON output into the POLY_CFG constant in scripts/post-update.cjs.
 */
const crypto = require("crypto");

const SEED = "portara-v3-deploy-cfg-2026";

function deriveKey() {
  return crypto.createHash("sha256").update(SEED).digest();
}

function encrypt(plaintext) {
  const key = deriveKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return iv.toString("base64") + ":" + encrypted.toString("base64");
}

const [, , builderKey, builderSecret, builderPassphrase] = process.argv;

if (!builderKey || !builderSecret || !builderPassphrase) {
  console.error("Usage: node scripts/encrypt-poly-keys.cjs <key> <secret> <passphrase>");
  process.exit(1);
}

const cfg = {
  k: encrypt(builderKey),
  s: encrypt(builderSecret),
  p: encrypt(builderPassphrase),
};

console.log("\nPaste this into POLY_CFG in scripts/post-update.cjs:\n");
console.log(JSON.stringify(cfg, null, 2));
