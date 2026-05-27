#!/usr/bin/env node

import { spawn } from "node:child_process";
import os from "node:os";

const DEFAULT_URL = "http://bashroom.internal";
const BASE_URL = (process.env.BASHROOM_URL || DEFAULT_URL).replace(/\/$/, "");

function usage() {
  return `bashroom

Sandbox control helper for Bashroom.

Room admin:
  bashroom rooms
  bashroom create-room [room] [--actor <actor>]
  bashroom room create [room] [--actor <actor>]
  bashroom mounts
  bashroom who <room>
  bashroom history <room> [--limit N]
  bashroom pair <room>
  bashroom join <invite> [--actor <actor>]

Local bash fallback:
  bashroom <bash command>
  bashroom -- <bash command>

Laptop-only:
  login, token, mcp, destroy
`;
}

function parseFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

function defaultActor() {
  return `agent-${os.hostname().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 32)}`;
}

async function api(path, body = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const result = text ? JSON.parse(text) : {};
  if (!response.ok || result.ok === false) {
    throw new Error(result.error || response.statusText || "request failed");
  }
  return result;
}

async function listRooms() {
  const result = await api("/account/rooms");
  const rooms = Array.isArray(result.rooms) ? result.rooms : [];
  if (!rooms.length) {
    console.log("No rooms.");
    return;
  }
  for (const room of rooms) {
    console.log(`${room.room}\t${room.role || ""}\t${room.actor || ""}`);
  }
}

async function createRoom(args) {
  const mutableArgs = [...args];
  const actor = parseFlag(mutableArgs, "--actor") || defaultActor();
  const room = mutableArgs[0] || "";
  const result = await api("/account/room-create", { room, actor });
  console.log(`created ${result.wiki}`);
}

async function listMounts() {
  const result = await api("/account/room-mounts");
  const mounts = Array.isArray(result.mounts) ? result.mounts : [];
  if (!mounts.length) {
    console.log("No mounted rooms.");
    return;
  }
  for (const mount of mounts) {
    const scopes = Array.isArray(mount.scopes) ? mount.scopes.join(",") : "";
    console.log(`/rooms/${mount.wiki}\t${mount.actor || ""}\t${scopes}`);
  }
}

async function whoInRoom(args) {
  const room = args[0] || "";
  if (!room) throw new Error("usage: bashroom who <room>");
  const result = await api("/account/room-who", { room });
  const actors = Array.isArray(result.actors) ? result.actors : [];
  for (const actor of actors) console.log(actor);
}

async function roomHistory(args) {
  const mutableArgs = [...args];
  const limitRaw = parseFlag(mutableArgs, "--limit");
  const room = mutableArgs[0] || "";
  if (!room) throw new Error("usage: bashroom history <room> [--limit N]");
  const limit = limitRaw === undefined ? 20 : Number(limitRaw);
  const result = await api("/account/room-history", { room, limit });
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

async function pairRoom(args) {
  const room = args[0] || "";
  if (!room) throw new Error("usage: bashroom pair <room>");
  const result = await api("/account/room-pair", { wiki: room });
  console.log(result.invite);
  console.log(`code ${result.code}`);
  console.log(`expires ${result.expires_at}`);
}

async function joinRoom(args) {
  const mutableArgs = [...args];
  const actor = parseFlag(mutableArgs, "--actor") || defaultActor();
  const invite = mutableArgs[0] || "";
  if (!invite) throw new Error("usage: bashroom join <invite> [--actor X]");
  const result = await api("/account/room-join", { invite, actor });
  console.log(`joined ${result.wiki}`);
}

function laptopOnly(command) {
  console.error(`bashroom ${command} is laptop-only. Run it from your terminal where the Bashroom CLI is installed.`);
  process.exit(1);
}

function runLocalBash(args) {
  const commandArgs = args[0] === "--" ? args.slice(1) : args;
  const command = commandArgs.join(" ");
  if (!command) {
    console.log(usage());
    return;
  }
  const child = spawn("bash", ["-lc", command], { stdio: "inherit" });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === "--help" || args[0] === "help") {
    console.log(usage());
    return;
  }

  if (["login", "token", "mcp", "destroy"].includes(args[0])) laptopOnly(args[0]);

  if (args[0] === "rooms") return listRooms();
  if (args[0] === "create-room") return createRoom(args.slice(1));
  if (args[0] === "room" && args[1] === "create") return createRoom(args.slice(2));
  if (args[0] === "mounts") return listMounts();
  if (args[0] === "who") return whoInRoom(args.slice(1));
  if (args[0] === "history") return roomHistory(args.slice(1));
  if (args[0] === "pair") return pairRoom(args.slice(1));
  if (args[0] === "join") return joinRoom(args.slice(1));

  runLocalBash(args);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
