#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  lstatSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const host = "127.0.0.1";
const port = Number.parseInt(process.env.AGENT_CODEX_ROUTER_PORT ?? "17892", 10);
const home = process.env.HOME;
const modulePath = process.env.AGENT_CODEX_ROUTER_MODULE_PATH;
const keyPath = process.env.AGENT_CODEX_ROUTER_KEY_PATH ??
  (home ? join(home, ".codex", "multi-auth", "machine-router-client-key") : null);
if (!home || !modulePath || !keyPath ||
    !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("Codex account-router daemon is missing a managed path or valid port.");
}

function readOrCreateClientKey(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const fd = openSync(path, "wx", 0o600);
    try {
      writeFileSync(fd, `${randomBytes(32).toString("hex")}\n`, "utf8");
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  let keyStat = lstatSync(path, { bigint: false });
  if (!keyStat.isFile() || keyStat.isSymbolicLink() ||
      keyStat.uid !== process.getuid()) {
    throw new Error("Codex account-router client key must be a user-owned regular file.");
  }
  if ((keyStat.mode & 0o777) !== 0o600) {
    chmodSync(path, 0o600);
    keyStat = lstatSync(path, { bigint: false });
  }
  if (!keyStat.isFile() || keyStat.isSymbolicLink() ||
      keyStat.uid !== process.getuid() || (keyStat.mode & 0o777) !== 0o600) {
    throw new Error("Codex account-router client key permissions could not be secured.");
  }
  const key = readFileSync(path, "utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(key)) {
    throw new Error("Codex account-router client key is malformed.");
  }
  return key;
}

const clientApiKey = readOrCreateClientKey(keyPath);
// Retired machine-wide override must never affect per-task speed.
delete process.env.CODEX_MANAGED_SERVICE_TIER;
const proxyModule = await import(pathToFileURL(modulePath).href);
if (typeof proxyModule.startRuntimeRotationProxy !== "function") {
  throw new Error("Managed codex-multi-auth runtime proxy export is unavailable.");
}

const proxy = await proxyModule.startRuntimeRotationProxy({
  host,
  port,
  clientApiKey,
  managedMachineRouter: true,
});

process.stdout.write(`Codex account router ready on ${host}:${proxy.port}\n`);

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  try {
    await proxy.close();
  } finally {
    process.stdout.write(`Codex account router stopped (${signal})\n`);
    process.exit(0);
  }
}

process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));
process.once("SIGHUP", () => void stop("SIGHUP"));
await new Promise(() => undefined);
