#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_URL = "https://bashroom.sdan.io";
const CONFIG_PATH = path.join(os.homedir(), ".bashroom", "config.json");
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
  bashroom destroy <room> --yes        Destroy a room and purge its R2 storage.
  bashroom mounts                      List your mounted rooms with actor + scopes.
  bashroom who <room>                  List the actors present in a room.
  bashroom history <room> [--limit N]  Per-room activity log (not file versions).

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
  The CLI stores account tokens at ${CONFIG_PATH}.
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

async function runStdioMcp(baseUrl) {
  const token = accountToken(baseUrl);
  if (!token) throw new Error("not logged in. Run: bashroom login");

  const [
    { Client },
    { StreamableHTTPClientTransport },
    { Server },
    { StdioServerTransport },
    { ListToolsRequestSchema, CallToolRequestSchema },
  ] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
    import("@modelcontextprotocol/sdk/server/index.js"),
    import("@modelcontextprotocol/sdk/server/stdio.js"),
    import("@modelcontextprotocol/sdk/types.js"),
  ]);

  const remoteTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const remote = new Client({ name: "bashroom-cli", version: "2.0.1" }, { capabilities: {} });
  await remote.connect(remoteTransport);

  // The hosted Worker owns tool names, descriptions, schemas, and behavior.
  // Stdio is deliberately a transparent transport adapter so those contracts
  // cannot drift in two independently maintained implementations. It proxies
  // only tool RPCs today; prompts, resources, and server notifications are not
  // advertised or forwarded until the hosted Worker actually exposes them.
  const server = new Server(
    { name: "bashroom", version: "2.0.1" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, (request) => remote.listTools(request.params));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await remote.callTool(request.params);
    } catch (error) {
      return {
        content: [{ type: "text", text: `bashroom: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  });
  await server.connect(new StdioServerTransport());
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
