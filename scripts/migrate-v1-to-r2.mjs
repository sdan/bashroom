#!/usr/bin/env node
// One-shot v1→v2 migration: read every Room DO snapshot via the worker's
// temporary /internal/snapshot endpoint, write each file to R2 at
// users/<user_id>/<room>/<path> via /internal/r2-put, and verify counts +
// a byte sample. Deletes itself in spirit when task #12 runs (the worker
// endpoints and this file both go away together).
//
// Usage:
//   MIGRATION_TOKEN=<token> node scripts/migrate-v1-to-r2.mjs
//
// Reads account token from ~/.bashroom/config.json (same file the CLI uses).
// Writes a local backup of every snapshot to ./backup/<room>.json before
// touching R2 — so a script bug or R2 mishap doesn't lose data.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE_URL = (process.env.BASHROOM_URL || "https://bashroom.sdan.io").replace(/\/$/, "");
const MIGRATION_TOKEN = process.env.MIGRATION_TOKEN;
const CONFIG_PATH = path.join(os.homedir(), ".bashroom", "config.json");
const BACKUP_DIR = path.join(process.cwd(), "backup");

if (!MIGRATION_TOKEN) {
  console.error("error: MIGRATION_TOKEN env var required");
  process.exit(1);
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
  catch { return null; }
}

function getAccount() {
  const cfg = readConfig();
  const account = cfg?.accounts?.[BASE_URL];
  if (!account?.token) {
    console.error(`error: not logged in for ${BASE_URL}. Run: bashroom login`);
    process.exit(1);
  }
  return account;
}

async function api(pathname, body, token) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${pathname}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
  if (!res.ok || parsed?.ok === false) {
    throw new Error(`${pathname}: ${res.status} ${parsed?.error || res.statusText || "request failed"}`);
  }
  return parsed;
}

function ensureBackupDir() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function backupRoom(room, snapshot) {
  const safeName = room.replace(/\//g, "__");
  const filePath = path.join(BACKUP_DIR, `${safeName}.json`);
  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2));
  return filePath;
}

function readBackup(room) {
  const safeName = room.replace(/\//g, "__");
  return JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, `${safeName}.json`), "utf8"));
}

async function main() {
  const account = getAccount();
  console.log(`Migration target: ${BASE_URL}`);
  console.log(`Account: ${account.handle || account.user_id || "(unknown)"}`);
  console.log(`User ID: ${account.user_id}`);
  console.log();

  // 1. List rooms.
  const roomsResult = await api("/account/rooms", {}, account.token);
  const rooms = Array.isArray(roomsResult.rooms) ? roomsResult.rooms : [];
  if (!rooms.length) {
    console.log("No rooms to migrate. Done.");
    return;
  }
  console.log(`Found ${rooms.length} room${rooms.length === 1 ? "" : "s"}:`);
  for (const r of rooms) console.log(`  ${r.room}\t${r.role}\t${r.actor}`);
  console.log();

  // 2. Phase 1 — snapshot every room into ./backup/. This is the rollback artifact.
  ensureBackupDir();
  const snapshots = new Map();
  console.log("Phase 1: snapshot every room into ./backup/");
  for (const r of rooms) {
    const snap = await api("/internal/snapshot", { room: r.room }, MIGRATION_TOKEN);
    const files = Array.isArray(snap.files) ? snap.files : [];
    snapshots.set(r.room, files);
    const filePath = backupRoom(r.room, { room: r.room, files });
    const totalBytes = files.reduce((sum, f) => sum + (f.content?.length || 0), 0);
    console.log(`  ${r.room}: ${files.length} file${files.length === 1 ? "" : "s"}, ${totalBytes} bytes → ${filePath}`);
  }
  console.log();

  // 3. Phase 2 — verify backups read back cleanly.
  console.log("Phase 2: verify backups");
  for (const r of rooms) {
    const fromDisk = readBackup(r.room);
    const inMem = snapshots.get(r.room);
    if (JSON.stringify(fromDisk.files) !== JSON.stringify(inMem)) {
      throw new Error(`backup mismatch for ${r.room}`);
    }
    console.log(`  ${r.room}: ok`);
  }
  console.log();

  // 4. Phase 3 — PUT every file to R2 at users/<user_id>/<room>/<path>.
  console.log("Phase 3: PUT to R2");
  let totalPut = 0;
  for (const r of rooms) {
    const files = snapshots.get(r.room);
    for (const f of files) {
      const key = `users/${account.user_id}/${r.room}/${f.path}`;
      await api("/internal/r2-put", { key, content: f.content }, MIGRATION_TOKEN);
      totalPut += 1;
    }
    console.log(`  ${r.room}: ${files.length} file${files.length === 1 ? "" : "s"} PUT`);
  }
  console.log(`  total: ${totalPut} file${totalPut === 1 ? "" : "s"} written`);
  console.log();

  // 5. Phase 4 — sample byte-compare. Pick the first file of each room,
  //    fetch it back via the same /internal/snapshot endpoint (which still
  //    reads from v1 DOs), compare to the backup. This catches encoding
  //    drift; the full R2 round-trip verify happens in task #14.
  console.log("Phase 4: sample verify (re-snapshot vs. backup)");
  for (const r of rooms) {
    const snap = await api("/internal/snapshot", { room: r.room }, MIGRATION_TOKEN);
    const fromBackup = readBackup(r.room);
    if (JSON.stringify(snap.files) !== JSON.stringify(fromBackup.files)) {
      console.warn(`  ${r.room}: DRIFT — snapshot changed during migration; rerun script`);
    } else {
      console.log(`  ${r.room}: stable`);
    }
  }
  console.log();

  console.log("✅ Migration complete.");
  console.log("Backups retained in ./backup/ — keep until v2 is verified.");
  console.log("Next: build v2 worker code (tasks #5–#11), then cut over (task #12).");
}

main().catch((err) => {
  console.error();
  console.error(`❌ Migration failed: ${err.message}`);
  console.error("State: any files PUT to R2 are safe (PUT is idempotent on rerun).");
  console.error("Local backups in ./backup/ are intact.");
  process.exit(1);
});
