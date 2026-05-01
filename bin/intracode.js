#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_URL = "https://intracode.sdan.io";
const CONFIG_PATH = path.join(os.homedir(), ".bashroom", "config.json");

function usage() {
  return `bashroom

Human fallback for Bashroom durable bash rooms.

Usage:
  bashroom [--url <url>] <bash command>
  bashroom [--url <url>] -- <bash command>

Examples:
  bashroom 'room create'
  bashroom 'room mounts'
  bashroom 'tree /rooms'
  bashroom 'cat /rooms/my-room/index.md'
  echo '# Notes' | bashroom 'cat > /rooms/my-room/notes.md'

Environment:
  BASHROOM_URL    Worker URL. Defaults to ${DEFAULT_URL}
  BASHROOM_TOKEN  Optional bearer token mount.

State:
  The CLI stores a local MCP-style session id at ${CONFIG_PATH}.
`;
}

function parseArgs(argv) {
  const args = [...argv];
  let baseUrl = process.env.BASHROOM_URL || process.env.INTRACODE_URL || DEFAULT_URL;

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--url") {
      baseUrl = args[index + 1];
      args.splice(index, 2);
      index -= 1;
    }
  }

  if (args[0] === "--") args.shift();
  return { baseUrl: baseUrl.replace(/\/$/, ""), args };
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return { sessions: {} };
  }
}

function writeConfig(config) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function sessionId(baseUrl) {
  const config = readConfig();
  config.sessions ||= {};
  config.sessions[baseUrl] ||= crypto.randomUUID();
  writeConfig(config);
  return config.sessions[baseUrl];
}

function readStdinIfAvailable() {
  if (process.stdin.isTTY) return "";
  return fs.readFileSync(0, "utf8").trimEnd();
}

async function runBash(baseUrl, command, stdin) {
  const headers = {
    "content-type": "application/json",
    "mcp-session-id": sessionId(baseUrl),
  };
  const token = process.env.BASHROOM_TOKEN || process.env.INTRACODE_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;

  const response = await fetch(`${baseUrl}/bash`, {
    method: "POST",
    headers,
    body: JSON.stringify({ command, stdin }),
  });

  const text = await response.text();
  const result = text ? JSON.parse(text) : {};
  if (!response.ok && !result.stderr) throw new Error(result.error || response.statusText || "request failed");
  return result;
}

async function main() {
  const { baseUrl, args } = parseArgs(process.argv.slice(2));

  if (args.length === 0 || args[0] === "--help" || args[0] === "help") {
    console.log(usage());
    return;
  }

  const stdin = readStdinIfAvailable();
  const command = args.join(" ");
  const result = await runBash(baseUrl, command, stdin);

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.stderr.write(`[bashroom] exit=${result.exitCode ?? 0} changed=${result.changed ?? 0}`);
  if (Array.isArray(result.changed_paths) && result.changed_paths.length) {
    process.stderr.write(` ${result.changed_paths.join(" ")}`);
  }
  process.stderr.write("\n");

  process.exitCode = result.exitCode || 0;
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
