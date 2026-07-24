#!/usr/bin/env node

// Lossless production migration driver. It never reads or prints document
// bodies: the Worker copies exact R2 bytes into each room's Durable Object,
// and this script only pages the authenticated control route and records
// per-file hashes/statuses. Run during ROOM_TEXT_MODE=freeze.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_URL = "https://bashroom.sdan.io";
const args = process.argv.slice(2);
const baseUrl = flag("--url") || process.env.BASHROOM_URL || DEFAULT_URL;
const reportPath = flag("--report") || "";
const verifyOnly = args.includes("--verify-only");
const requestedLimit = Number(flag("--limit") || 20);
const pageLimit = Number.isFinite(requestedLimit)
  ? Math.max(1, Math.min(100, Math.floor(requestedLimit)))
  : 20;
const configPath = path.join(os.homedir(), ".bashroom", "config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const account = config.accounts?.[baseUrl.replace(/\/$/, "")];
const token = process.env.BASHROOM_TOKEN || account?.token;
if (!token) throw new Error(`no Bashroom token for ${baseUrl}`);

const report = {
  started_at: new Date().toISOString(),
  base_url: baseUrl,
  user_id: account?.user_id || "",
  rooms: [],
  errors: [],
};

const accountState = await request("/account/rooms", {});
const rooms = (accountState.rooms || [])
  .filter((room) => Array.isArray(room.scopes) && room.scopes.includes("admin") && room.scopes.includes("write"))
  .map((room) => room.room)
  .sort();
if (!rooms.length) throw new Error("no admin/write rooms found");

for (const action of (verifyOnly ? ["verify"] : ["migrate", "verify"])) {
  for (const room of rooms) {
    const summary = { room, action, migrated: 0, verified: 0, skipped: 0, files: 0, errors: [] };
    let cursor;
    do {
      const page = await request("/account/roomtext-migrate", { room, action, cursor, limit: pageLimit });
      for (const row of page.results || []) {
        summary.files += 1;
        if (row.status === "migrated") summary.migrated += 1;
        else if (row.status === "verified") summary.verified += 1;
        else if (row.status === "skipped") summary.skipped += 1;
        else {
          const failure = { room, action, path: row.path, error: row.error || "unknown", message: row.message || "" };
          summary.errors.push(failure);
          report.errors.push(failure);
        }
      }
      cursor = page.truncated ? page.cursor : undefined;
      process.stdout.write(
        `${action}\t${room}\tprogress=${summary.files}\terrors=${summary.errors.length}\n`,
      );
    } while (cursor);
    report.rooms.push(summary);
    process.stdout.write(
      `${action}\t${room}\tfiles=${summary.files}\tmigrated=${summary.migrated}\tverified=${summary.verified}\tskipped=${summary.skipped}\terrors=${summary.errors.length}\n`,
    );
  }
}

report.finished_at = new Date().toISOString();
report.ok = report.errors.length === 0;
if (reportPath) {
  fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}
process.stdout.write(`${JSON.stringify({ ok: report.ok, rooms: report.rooms.length, errors: report.errors.length, report: reportPath || null })}\n`);
if (!report.ok) process.exitCode = 1;

function flag(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
}

async function request(route, body) {
  let lastError;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}${route}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const value = await response.json().catch(() => ({}));
      if (!response.ok || value.ok === false) {
        throw new Error(`${route}: ${value.error || response.statusText || response.status}`);
      }
      return value;
    } catch (error) {
      lastError = error;
      if (attempt === 6) break;
      process.stderr.write(`${route}\tretry=${attempt}\terror=${String(error)}\n`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(1_000 * 2 ** (attempt - 1), 10_000)));
    }
  }
  throw lastError;
}
