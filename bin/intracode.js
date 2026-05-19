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
  bashroom login [handle]
  bashroom rooms
  bashroom room create [room] [--actor <actor>]
  bashroom mcp

Examples:
  bashroom login sdan
  bashroom rooms
  bashroom room create suryad
  bashroom 'room create'
  bashroom 'room mounts'
  bashroom 'tree /rooms'
  bashroom 'cat /rooms/my-room/index.md'
  echo '# Notes' | bashroom 'cat > /rooms/my-room/notes.md'

Wire up a coding agent (token stays on disk, never enters the model):
  claude mcp add --scope user bashroom -- bashroom mcp
  codex mcp add bashroom -- bashroom mcp

Environment:
  BASHROOM_URL    Worker URL. Defaults to ${DEFAULT_URL}
  BASHROOM_TOKEN  Optional bearer token mount.

State:
  The CLI stores account tokens and local MCP-style session ids at ${CONFIG_PATH}.
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
  fs.chmodSync(CONFIG_PATH, 0o600);
}

function sessionId(baseUrl) {
  const config = readConfig();
  config.sessions ||= {};
  config.sessions[baseUrl] ||= crypto.randomUUID();
  writeConfig(config);
  return config.sessions[baseUrl];
}

function account(baseUrl) {
  const config = readConfig();
  return config.accounts?.[baseUrl];
}

function writeAccount(baseUrl, value) {
  const config = readConfig();
  config.accounts ||= {};
  config.accounts[baseUrl] = value;
  writeConfig(config);
}

function readStdinIfAvailable() {
  if (process.stdin.isTTY) return "";
  return fs.readFileSync(0, "utf8").trimEnd();
}

function parseFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

async function api(baseUrl, path, body = {}, token = "") {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;

  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const text = await response.text();
  const result = text ? JSON.parse(text) : {};
  if (!response.ok || result.ok === false) {
    throw new Error(result.error || response.statusText || "request failed");
  }
  return result;
}

async function login(baseUrl, args) {
  const existing = account(baseUrl);
  if (existing?.token) {
    console.log(`logged in as ${existing.handle || existing.user_id || "user"}`);
    return;
  }

  const handle = args[0] || os.userInfo().username || "user";
  const result = await api(baseUrl, "/account/login", { handle });
  writeAccount(baseUrl, { token: result.token, user_id: result.user_id, handle: result.handle });
  console.log(`logged in as ${result.handle}`);
}

async function listRooms(baseUrl) {
  const current = account(baseUrl);
  if (!current?.token) throw new Error("not logged in. Run: bashroom login");

  const result = await api(baseUrl, "/account/rooms", {}, current.token);
  const rooms = Array.isArray(result.rooms) ? result.rooms : [];
  if (!rooms.length) {
    console.log("No rooms.");
    return;
  }
  for (const room of rooms) {
    console.log(`${room.room}\t${room.role || ""}\t${room.actor || ""}`);
  }
}

async function createRoom(baseUrl, args) {
  const current = account(baseUrl);
  if (!current?.token) throw new Error("not logged in. Run: bashroom login");

  const mutableArgs = [...args];
  const actor = parseFlag(mutableArgs, "--actor") || `cli-${os.hostname().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 32)}`;
  const room = mutableArgs[0] || "";
  const result = await api(baseUrl, "/account/room-create", { room, actor }, current.token);
  console.log(`created ${result.wiki}`);
}

async function runBash(baseUrl, command, stdin) {
  const headers = {
    "content-type": "application/json",
    "mcp-session-id": sessionId(baseUrl),
  };
  const token = process.env.BASHROOM_TOKEN || process.env.INTRACODE_TOKEN;
  const current = account(baseUrl);
  if (token || current?.token) headers.authorization = `Bearer ${token || current.token}`;

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

async function runStdioMcp(baseUrl) {
  const [{ McpServer }, { StdioServerTransport }, { z }] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/mcp.js"),
    import("@modelcontextprotocol/sdk/server/stdio.js"),
    import("zod"),
  ]);

  const server = new McpServer({ name: "bashroom", version: "0.2.0" });

  server.tool(
    "bashroom",
    "Run bash against durable Bashroom files. Use `room help` inside bash for create, join, pair, mounts, who, and history.",
    {
      command: z.string().min(1).describe("Bash command to run, for example: room mounts; cat /rooms/my-room/index.md"),
      stdin: z.string().optional().describe("Optional standard input for the command."),
    },
    async ({ command, stdin }) => {
      try {
        const result = await runBash(baseUrl, command, stdin || "");
        return {
          content: [{ type: "text", text: formatMcpResult(result) }],
          isError: (result.exitCode ?? 0) !== 0,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const hint = message.toLowerCase().includes("token") || message.toLowerCase().includes("auth")
          ? "\n\nHint: run `bashroom login` then `bashroom room create` to set up auth."
          : "";
        return {
          content: [{ type: "text", text: `bashroom: ${message}${hint}` }],
          isError: true,
        };
      }
    },
  );

  await server.connect(new StdioServerTransport());
}

function formatMcpResult(result) {
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const body = `${stdout}${stderr}`;
  const paths = Array.isArray(result.changed_paths) && result.changed_paths.length
    ? ` ${result.changed_paths.join(" ")}`
    : "";
  const tail = `[bashroom] exit=${result.exitCode ?? 0} changed=${result.changed ?? 0}${paths}`;
  return body && !body.endsWith("\n") ? `${body}\n${tail}\n` : `${body}${tail}\n`;
}

async function main() {
  const { baseUrl, args } = parseArgs(process.argv.slice(2));

  if (args.length === 0 || args[0] === "--help" || args[0] === "help") {
    console.log(usage());
    return;
  }

  if (args[0] === "login") {
    await login(baseUrl, args.slice(1));
    return;
  }

  if (args[0] === "rooms") {
    await listRooms(baseUrl);
    return;
  }

  if (args[0] === "room" && args[1] === "create") {
    await createRoom(baseUrl, args.slice(2));
    return;
  }

  if (args[0] === "mcp") {
    await runStdioMcp(baseUrl);
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
