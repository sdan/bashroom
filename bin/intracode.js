#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_URL = "http://127.0.0.1:8787";
const CONFIG_PATH = path.join(os.homedir(), ".intracode", "config.json");

function usage() {
  return `intracode

Shared context rooms for coding agents.

Setup:
  intracode create [room] [--label <device>]
  intracode pair <room>
  intracode join <code> [--label <device>]

Use:
  intracode <room> read
  intracode <room> history [limit]
  intracode <room> write <markdown>
  intracode <room> checkpoint <markdown>

Devices:
  intracode rooms
  intracode devices <room>
  intracode revoke <room> <label>
  intracode rotate <room>
  intracode export <room>
  intracode delete <room>

Environment:
  INTRACODE_URL    Worker URL. Defaults to ${DEFAULT_URL}
  INTRACODE_TOKEN  Override saved room token.
`;
}

function parseArgs(argv) {
  const args = [...argv];
  let baseUrl = process.env.INTRACODE_URL || DEFAULT_URL;

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--url") {
      baseUrl = args[index + 1];
      args.splice(index, 2);
      index -= 1;
    }
  }

  return { baseUrl: baseUrl.replace(/\/$/, ""), args };
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return { rooms: {} };
  }
}

function writeConfig(config) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function configKey(baseUrl, room) {
  return `${baseUrl} ${room}`;
}

function saveRoom(baseUrl, room, token, label) {
  const config = readConfig();
  config.rooms ||= {};
  config.rooms[configKey(baseUrl, room)] = { url: baseUrl, room, token, label };
  writeConfig(config);
}

function roomToken(baseUrl, room) {
  if (process.env.INTRACODE_TOKEN) return process.env.INTRACODE_TOKEN;
  return readConfig().rooms?.[configKey(baseUrl, room)]?.token || "";
}

function defaultLabel() {
  return `${process.env.USER || "agent"}@${os.hostname()}`;
}

function flagValue(args, flag, fallback) {
  const index = args.indexOf(flag);
  if (index === -1) return fallback;
  const value = args[index + 1];
  args.splice(index, 2);
  return value || fallback;
}

function readStdinIfAvailable() {
  if (process.stdin.isTTY) return "";
  return fs.readFileSync(0, "utf8").trimEnd();
}

function removeRoom(baseUrl, room) {
  const config = readConfig();
  delete config.rooms?.[configKey(baseUrl, room)];
  writeConfig(config);
}

async function request(baseUrl, pathname, { method = "POST", token, body } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;

  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || response.statusText || "request failed");
  }
  return data;
}

async function roomRead(baseUrl, room, op, body, limit) {
  const token = roomToken(baseUrl, room);
  if (!token) throw new Error(`No token for ${room}. Run: intracode join <code>`);
  return request(baseUrl, `/rooms/${encodeURIComponent(room)}`, {
    token,
    body: { op, body, limit },
  });
}

async function main() {
  const { baseUrl, args } = parseArgs(process.argv.slice(2));

  if (args.length === 0 || args[0] === "--help" || args[0] === "help") {
    console.log(usage());
    return;
  }

  if ((args[0] === "room" && args[1] === "create") || args[0] === "create") {
    const label = flagValue(args, "--label", defaultLabel());
    const room = args[0] === "create" ? args[1] : args[2];
    const result = await request(baseUrl, "/api/rooms", { body: { room, label } });
    saveRoom(baseUrl, result.room, result.token, result.label);
    console.log(`created ${result.room}`);
    console.log(`saved token for ${result.label}`);
    return;
  }

  if (args[0] === "pair") {
    const room = args[1];
    const token = roomToken(baseUrl, room);
    const result = await request(baseUrl, `/api/rooms/${encodeURIComponent(room)}/pair`, { token, body: {} });
    console.log(result.code);
    console.log(`expires ${result.expires_at}`);
    return;
  }

  if (args[0] === "join") {
    const code = args[1];
    const label = flagValue(args, "--label", defaultLabel());
    const result = await request(baseUrl, "/api/join", { body: { code, label } });
    saveRoom(baseUrl, result.room, result.token, result.label);
    console.log(`joined ${result.room}`);
    console.log(`saved token for ${result.label}`);
    return;
  }

  if (args[0] === "devices") {
    const room = args[1];
    const result = await request(baseUrl, `/api/rooms/${encodeURIComponent(room)}/devices`, {
      method: "GET",
      token: roomToken(baseUrl, room),
    });
    for (const device of result.devices) {
      console.log(`${device.label}\t${device.active ? "active" : "revoked"}\t${device.scopes.join(",")}`);
    }
    return;
  }

  if (args[0] === "rooms") {
    const config = readConfig();
    for (const entry of Object.values(config.rooms || {})) {
      console.log(`${entry.room}\t${entry.label}\t${entry.url}`);
    }
    return;
  }

  if (args[0] === "revoke") {
    const room = args[1];
    const label = args[2];
    await request(baseUrl, `/api/rooms/${encodeURIComponent(room)}/revoke`, {
      token: roomToken(baseUrl, room),
      body: { label },
    });
    console.log(`revoked ${label}`);
    return;
  }

  if (args[0] === "rotate") {
    const room = args[1];
    const result = await request(baseUrl, `/api/rooms/${encodeURIComponent(room)}/rotate`, {
      token: roomToken(baseUrl, room),
      body: {},
    });
    saveRoom(baseUrl, result.room, result.token, result.label);
    console.log(`rotated ${result.room}`);
    console.log(`saved token for ${result.label}`);
    return;
  }

  if (args[0] === "export") {
    const room = args[1];
    const token = roomToken(baseUrl, room);
    if (!token) throw new Error(`No token for ${room}.`);
    const response = await fetch(`${baseUrl}/api/rooms/${encodeURIComponent(room)}/export`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(await response.text());
    process.stdout.write(await response.text());
    return;
  }

  if (args[0] === "delete") {
    const room = args[1];
    await request(baseUrl, `/api/rooms/${encodeURIComponent(room)}/delete`, {
      token: roomToken(baseUrl, room),
      body: {},
    });
    removeRoom(baseUrl, room);
    console.log(`deleted ${room}`);
    return;
  }

  const [room, rawOp = "read", ...opArgs] = args;
  const op = rawOp === "note" ? "write" : rawOp;
  const stdin = readStdinIfAvailable();
  const body = opArgs.join(" ").trim() || stdin || undefined;
  const limit = op === "history" && opArgs[0] && /^\d+$/.test(opArgs[0]) ? Number(opArgs[0]) : undefined;
  const result = await roomRead(baseUrl, room, op, limit ? undefined : body, limit);
  process.stdout.write(result.stdout);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
