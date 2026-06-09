#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_URL = "https://bashroom.sdan.io";
const CONFIG_PATH = path.join(os.homedir(), ".bashroom", "config.json");
const MAX_WRITE_BYTES = 5_000_000;
const MAX_MCP_READ_BYTES = 512_000;
const MAX_MCP_TREE_ENTRIES = 1_000;
const MAX_MCP_SEARCH_MATCHES = 200;
const MAX_MCP_SEARCH_FILES = 1_000;
const MAX_MCP_SEARCH_FILE_BYTES = 1_000_000;

function usage() {
  return `bashroom

Human fallback for Bashroom durable bash rooms.

Usage:
  bashroom [--url <url>] <bash command>
  bashroom [--url <url>] -- <bash command>

Account:
  bashroom login                       Device-flow OAuth login.
  bashroom token                       Print your account token (for the /web reader).
  bashroom rooms                       List rooms you can access (with role + actor).

Room admin:
  bashroom create-room [room] [--actor <actor>]
                                       Create a new room (room name optional; auto-slug if omitted).
  bashroom join <invite> [--actor <actor>]
                                       Redeem a pair-code invite.
  bashroom pair <room>                 Mint an invite for an existing room.
  bashroom destroy <room> --yes        Destroy a room and purge its R2 storage.
  bashroom mounts                      List your mounted rooms with actor + scopes.
  bashroom who <room>                  List the actors present in a room.
  bashroom history <room> [--limit N]  Per-room audit log (default 20 most recent).

Data:
  bashroom export [dir] [--room R]     Download rooms to a local directory tree
                                       (default ./bashroom-export). One room with --room.

Shell:
  bashroom <bash command>              Run bash against /rooms (FUSE-mounted R2).
  bashroom mcp                         Start the stdio MCP server (for agent wiring).

Examples:
  bashroom login
  bashroom rooms
  bashroom create-room suryad
  bashroom pair suryad
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
  const force = args.includes("--force") || args.includes("-f");
  const existing = account(baseUrl);
  if (!force && existing?.token) {
    console.log(`already logged in as ${existing.handle || existing.user_id || "user"}`);
    console.log("Use `bashroom login --force` to re-authenticate.");
    return;
  }

  // 1. Mint a device code.
  const start = await api(baseUrl, "/auth/device/start", {});
  const code = String(start.code || "");
  const url = String(start.verification_url || `${baseUrl}/device?code=${encodeURIComponent(code)}`);
  const expiresAt = new Date(String(start.expires_at || ""));
  const interval = Math.max(2, Number(start.interval || 3));

  console.log();
  console.log(`Open: ${url}`);
  console.log(`Code: ${code}`);
  console.log();
  console.log(`Waiting for authorization (expires ${expiresAt.toLocaleTimeString()})…`);

  // 2. Poll until claimed or expired.
  while (true) {
    if (new Date() > expiresAt) {
      throw new Error("device code expired. Run `bashroom login` again.");
    }
    await sleep(interval * 1000);
    let poll;
    try { poll = await api(baseUrl, "/auth/device/poll", { code }); }
    catch (e) {
      if (e.message === "expired") throw new Error("device code expired. Run `bashroom login` again.");
      if (e.message === "unknown_code") throw new Error("device code not recognized.");
      throw e;
    }
    if (poll.status === "approved") {
      writeAccount(baseUrl, { token: poll.token, user_id: poll.user_id, handle: poll.handle });
      console.log();
      console.log(`Signed in as @${poll.handle}`);
      console.log(`Token saved to ${CONFIG_PATH}`);
      return;
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

// Redeem a pair-code invite — `bashroom join <invite> [--actor X]`.
async function joinRoom(baseUrl, args) {
  const current = account(baseUrl);
  if (!current?.token) throw new Error("not logged in. Run: bashroom login");

  const mutableArgs = [...args];
  const actor = parseFlag(mutableArgs, "--actor") || `cli-${os.hostname().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 32)}`;
  const invite = mutableArgs[0] || "";
  if (!invite) throw new Error("usage: bashroom join <invite> [--actor X]");
  const result = await api(baseUrl, "/account/room-join", { invite, actor }, current.token);
  console.log(`joined ${result.wiki}`);
}

// Mint a pair-code invite for an existing room — `bashroom pair <room>`.
// Output matches v1's `room pair` format exactly: 3 lines (URI, code, expiry).
async function pairRoom(baseUrl, args) {
  const current = account(baseUrl);
  if (!current?.token) throw new Error("not logged in. Run: bashroom login");

  const room = args[0] || "";
  if (!room) throw new Error("usage: bashroom pair <room>");
  const result = await api(baseUrl, "/account/room-pair", { wiki: room }, current.token);
  console.log(result.invite);
  console.log(`code ${result.code}`);
  console.log(`expires ${result.expires_at}`);
}

// Destroy a room (drop Registry rows + purge R2 prefix). Hard-requires --yes.
async function destroyRoom(baseUrl, args) {
  const mutableArgs = [...args];
  const yes = mutableArgs.includes("--yes");
  if (yes) mutableArgs.splice(mutableArgs.indexOf("--yes"), 1);
  const room = mutableArgs[0] || "";
  if (!room || !yes) {
    process.stderr.write("usage: bashroom destroy <room> --yes\n");
    process.exit(1);
  }

  const current = account(baseUrl);
  if (!current?.token) throw new Error("not logged in. Run: bashroom login");

  const result = await api(baseUrl, "/account/room-delete", { wiki: room }, current.token);
  console.log(`destroyed ${result.wiki || room}`);
}

// List the user's mounted rooms — `bashroom mounts`.
// Output: one line per mount, tab-separated: <path>\t<actor>\t<scopes_csv>.
async function listMounts(baseUrl) {
  const current = account(baseUrl);
  if (!current?.token) throw new Error("not logged in. Run: bashroom login");

  const result = await api(baseUrl, "/account/room-mounts", {}, current.token);
  const mounts = Array.isArray(result.mounts) ? result.mounts : [];
  if (!mounts.length) {
    console.log("No mounted rooms.");
    return;
  }
  for (const mount of mounts) {
    const scopes = Array.isArray(mount.scopes) ? mount.scopes.join(",") : "";
    console.log(`/rooms/${mount.wiki}\t${mount.actor}\t${scopes}`);
  }
}

// List the actors present in a room — `bashroom who <room>`.
async function whoInRoom(baseUrl, args) {
  const current = account(baseUrl);
  if (!current?.token) throw new Error("not logged in. Run: bashroom login");

  const room = args[0] || "";
  if (!room) throw new Error("usage: bashroom who <room>");
  const result = await api(baseUrl, "/account/room-who", { wiki: room }, current.token);
  const actors = Array.isArray(result.actors) ? result.actors : [];
  for (const actor of actors) console.log(actor);
}

// Per-room audit history — `bashroom history <room> [--limit N]`.
// Line format matches v1: `#<id> <ts> <actor> <kind>[ <path>]: <command-or-body>`.
async function roomHistory(baseUrl, args) {
  const current = account(baseUrl);
  if (!current?.token) throw new Error("not logged in. Run: bashroom login");

  const mutableArgs = [...args];
  const limitRaw = parseFlag(mutableArgs, "--limit");
  const room = mutableArgs[0] || "";
  if (!room) throw new Error("usage: bashroom history <room> [--limit N]");
  const limit = limitRaw === undefined ? 20 : Number(limitRaw);
  const result = await api(baseUrl, "/account/room-history", { room, limit }, current.token);
  const events = Array.isArray(result.events) ? result.events : [];
  if (!events.length) {
    console.log("No history.");
    return;
  }
  for (const event of events) {
    const id = event.id ?? "?";
    const ts = event.ts || "";
    const actor = event.actor || "";
    const kind = event.kind || "";
    const pathPart = event.path ? ` ${event.path}` : "";
    const body = event.command ? event.command : "";
    console.log(`#${id} ${ts} ${actor} ${kind}${pathPart}: ${body}`);
  }
}

// Authenticated GET against the /web/api/* read surface. Used by export so
// it reuses the same membership-gated endpoints the reader uses.
async function apiGet(baseUrl, path, token) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  const result = text ? JSON.parse(text) : {};
  if (!response.ok || result.ok === false) {
    throw new Error(result.error || response.statusText || "request failed");
  }
  return result;
}

// Download every room (or one with --room) to a local directory tree,
// preserving room/path layout. Files come down via /web/api/raw so binary
// content survives byte-for-byte. This is the offline backup of the R2 data.
async function exportData(baseUrl, args) {
  const current = account(baseUrl);
  if (!current?.token) throw new Error("not logged in. Run: bashroom login");
  const token = current.token;

  const mutableArgs = [...args];
  const onlyRoom = parseFlag(mutableArgs, "--room");
  const destDir = path.resolve(mutableArgs[0] || "bashroom-export");

  const roomsResult = await apiGet(baseUrl, "/web/api/rooms", token);
  let rooms = (Array.isArray(roomsResult.rooms) ? roomsResult.rooms : []).map((r) => r.room);
  if (onlyRoom) rooms = rooms.filter((r) => r === onlyRoom);
  if (!rooms.length) {
    console.log(onlyRoom ? `No room named ${onlyRoom}.` : "No rooms to export.");
    return;
  }

  let fileCount = 0;
  let byteCount = 0;
  for (const room of rooms) {
    const tree = await apiGet(baseUrl, `/web/api/tree?room=${encodeURIComponent(room)}`, token);
    const files = (Array.isArray(tree.files) ? tree.files : [])
      .filter((f) => f.path && !f.path.endsWith("/")); // skip directory markers
    for (const file of files) {
      // Guard against path traversal in stored keys before writing locally.
      const safe = file.path.split("/").filter((seg) => seg && seg !== "." && seg !== "..").join("/");
      if (!safe) continue;
      const outPath = path.join(destDir, room, safe);
      const url = `/web/api/raw?room=${encodeURIComponent(room)}&path=${encodeURIComponent(file.path)}`;
      const response = await fetch(`${baseUrl}${url}`, { headers: { authorization: `Bearer ${token}` } });
      if (!response.ok) {
        process.stderr.write(`skip ${room}/${file.path}: ${response.status}\n`);
        continue;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, bytes);
      fileCount += 1;
      byteCount += bytes.length;
    }
    console.log(`${room}: ${files.length} files`);
  }
  console.log(`\nExported ${fileCount} files (${formatBytes(byteCount)}) to ${destDir}`);
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
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

function accountToken(baseUrl) {
  return process.env.BASHROOM_TOKEN || process.env.INTRACODE_TOKEN || account(baseUrl)?.token || "";
}

function parseMcpSse(text) {
  const dataLines = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6));
  if (!dataLines.length) {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`invalid MCP response: ${text.slice(0, 200)}`);
    }
  }
  return JSON.parse(dataLines.join("\n"));
}

async function createRemoteMcpClient(baseUrl) {
  const token = accountToken(baseUrl);
  if (!token) throw new Error("not logged in. Run: bashroom login");
  let remoteSessionId = "";
  let nextId = 1;

  async function post(body) {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    };
    if (remoteSessionId) headers["mcp-session-id"] = remoteSessionId;
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(text || response.statusText || "MCP request failed");
    remoteSessionId = response.headers.get("mcp-session-id") || remoteSessionId;
    const message = parseMcpSse(text);
    if (message.error) throw new Error(message.error.message || "MCP error");
    return message.result;
  }

  await post({
    jsonrpc: "2.0",
    id: nextId++,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "bashroom-cli", version: "2.0.0" },
    },
  });

  return {
    async callTool(name, args) {
      return post({
        jsonrpc: "2.0",
        id: nextId++,
        method: "tools/call",
        params: { name, arguments: args },
      });
    },
  };
}

async function runStdioMcp(baseUrl) {
  const [{ McpServer }, { StdioServerTransport }, { z }] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/mcp.js"),
    import("@modelcontextprotocol/sdk/server/stdio.js"),
    import("zod"),
  ]);

  const server = new McpServer({ name: "bashroom", version: "0.2.0" });
  let remotePromise;
  function remoteClient() {
    remotePromise ||= createRemoteMcpClient(baseUrl);
    return remotePromise;
  }

  async function forwardTool(name, args) {
    try {
      const remote = await remoteClient();
      const result = await remote.callTool(name, args);
      return {
        content: result.content || [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: Boolean(result.isError),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `bashroom: ${message}` }],
        isError: true,
      };
    }
  }

  server.tool(
    "bashroom",
    "Run bash against durable Bashroom files. Use `bashroom create-room`, `bashroom rooms`, `bashroom mounts`, `bashroom who`, or `bashroom history` inside bash for room control.",
    {
      command: z.string().min(1).describe("Bash command to run, for example: bashroom mounts; cat /rooms/my-room/index.md"),
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
          ? "\n\nHint: run `bashroom login` then `bashroom create-room` to set up auth."
          : "";
        return {
          content: [{ type: "text", text: `bashroom: ${message}${hint}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "bashroom_write",
    "Write a file to /rooms directly, bypassing bash quoting. Use this instead of `echo ... > file` or heredoc when content contains quotes, backticks, $variables, or arbitrary bytes. The path must be inside /rooms/<room>/.",
    {
      path: z.string().min(1).max(1024).describe("Absolute path under /rooms, e.g. /rooms/my-room/notes/today.md"),
      content: z.string().max(MAX_WRITE_BYTES).describe("File content. UTF-8 by default; pass base64-encoded bytes with encoding='base64' for binary."),
      encoding: z.enum(["utf-8", "base64"]).optional().describe("'utf-8' (default) treats content as text; 'base64' decodes content as binary before writing."),
    },
    async (args) => forwardTool("bashroom_write", { ...args, encoding: args.encoding ?? "utf-8" }),
  );

  server.tool(
    "bashroom_tree",
    "List rooms or files directly from R2 without starting bash. Use path='/rooms' to list rooms, or path='/rooms/<room>/<prefix>' to list bounded file metadata.",
    {
      path: z.string().default("/rooms").describe("Absolute path: /rooms to list rooms, or /rooms/<room>/<optional-prefix> to list files."),
      max_entries: z.number().int().min(1).max(MAX_MCP_TREE_ENTRIES).optional().describe(`Maximum files to return, up to ${MAX_MCP_TREE_ENTRIES}.`),
    },
    async (args) => forwardTool("bashroom_tree", { ...args, path: args.path || "/rooms" }),
  );

  server.tool(
    "bashroom_read",
    "Read a bounded text range directly from R2 without starting bash. Use this instead of `cat` when you want predictable context size.",
    {
      path: z.string().min(1).describe("Absolute file path under /rooms/<room>/, e.g. /rooms/bashroom/ARCHITECTURAL.md."),
      offset: z.number().int().min(0).optional().describe("Byte offset to start reading from. Defaults to 0."),
      max_bytes: z.number().int().min(1).max(MAX_MCP_READ_BYTES).optional().describe(`Maximum bytes to return, up to ${MAX_MCP_READ_BYTES}.`),
    },
    async (args) => forwardTool("bashroom_read", args),
  );

  server.tool(
    "bashroom_search",
    "Bounded literal text search over R2-backed room files without starting bash. Use bashroom for advanced rg/regex workflows.",
    {
      path: z.string().min(1).describe("Absolute room or prefix path under /rooms/<room>/, e.g. /rooms/bashroom/notes."),
      query: z.string().min(1).max(256).describe("Literal text to search for."),
      case_sensitive: z.boolean().optional().describe("Defaults to false."),
      max_matches: z.number().int().min(1).max(MAX_MCP_SEARCH_MATCHES).optional().describe(`Maximum matches to return, up to ${MAX_MCP_SEARCH_MATCHES}.`),
      max_files: z.number().int().min(1).max(MAX_MCP_SEARCH_FILES).optional().describe(`Maximum files to scan, up to ${MAX_MCP_SEARCH_FILES}.`),
      max_bytes_per_file: z.number().int().min(1).max(MAX_MCP_SEARCH_FILE_BYTES).optional().describe(`Maximum bytes to scan per file, up to ${MAX_MCP_SEARCH_FILE_BYTES}.`),
    },
    async (args) => forwardTool("bashroom_search", args),
  );

  server.tool(
    "bashroom_stat",
    "Return R2 metadata for one file without reading its body: size, modified time, etag, version, content type, and custom metadata.",
    {
      path: z.string().min(1).describe("Absolute file path under /rooms/<room>/, e.g. /rooms/bashroom/index.md."),
    },
    async (args) => forwardTool("bashroom_stat", args),
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

  // Prints just the account token to stdout. Used by the /web login screen
  // ("paste your token") so users don't have to grep the config file
  // themselves. Single-line output, no JSON wrapping, no trailing newline
  // beyond what console.log adds — safe to pipe into other commands.
  if (args[0] === "token") {
    const current = account(baseUrl);
    if (!current?.token) {
      console.error("not logged in. Run: bashroom login");
      process.exit(1);
    }
    console.log(current.token);
    return;
  }

  if (args[0] === "rooms") {
    await listRooms(baseUrl);
    return;
  }

  if (args[0] === "create-room") {
    await createRoom(baseUrl, args.slice(1));
    return;
  }

  if (args[0] === "join") {
    await joinRoom(baseUrl, args.slice(1));
    return;
  }

  if (args[0] === "pair") {
    await pairRoom(baseUrl, args.slice(1));
    return;
  }

  if (args[0] === "destroy") {
    await destroyRoom(baseUrl, args.slice(1));
    return;
  }

  if (args[0] === "mounts") {
    await listMounts(baseUrl);
    return;
  }

  if (args[0] === "who") {
    await whoInRoom(baseUrl, args.slice(1));
    return;
  }

  if (args[0] === "history") {
    await roomHistory(baseUrl, args.slice(1));
    return;
  }

  if (args[0] === "export") {
    await exportData(baseUrl, args.slice(1));
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
