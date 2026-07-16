import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "../..");
const wrangler = path.join(root, "node_modules", ".bin", "wrangler");

function waitForReady(child, url, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    let poll;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(poll);
      error ? reject(error) : resolve();
    };
    const timeout = setTimeout(
      () => finish(new Error(`wrangler did not become ready:\n${output}`)),
      timeoutMs,
    );
    const inspect = (chunk) => { output = (output + chunk.toString()).slice(-20_000); };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("exit", (code) => {
      finish(new Error(`wrangler exited before ready with code ${code}:\n${output}`));
    });
    poll = setInterval(async () => {
      try {
        await fetch(url);
        finish();
      } catch {
        // Server socket is not accepting requests yet.
      }
    }, 100);
  });
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code} signal ${signal || "none"}`));
    });
  });
}

async function withServer(port, task) {
  const persistence = await mkdtemp(path.join(os.tmpdir(), "bashroom-room-text-probe-"));
  const args = [
    "dev",
    "-c", "scripts/room-text-probe/wrangler.jsonc",
    "--port", String(port),
    "--persist-to", persistence,
    "--log-level", "error",
  ];
  const server = spawn(wrangler, args, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      XDG_CONFIG_HOME: persistence,
      WRANGLER_LOG_PATH: path.join(persistence, "wrangler.log"),
    },
  });

  try {
    await waitForReady(server, `http://127.0.0.1:${port}`);
    await task(`http://127.0.0.1:${port}`);
  } finally {
    if (server.exitCode === null) {
      server.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => server.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
      if (server.exitCode === null) server.kill("SIGKILL");
    }
    await rm(persistence, { recursive: true, force: true });
  }
}

// Fixed probe ports so concurrent harnesses on one machine stay apart:
// 8796 exercises the HTTP surface, 8797 the WebSocket sync surface.
const port = Number(process.env.ROOM_TEXT_PROBE_PORT ?? 8796);
const wsPort = Number(process.env.ROOM_TEXT_PROBE_WS_PORT ?? 8797);
await withServer(port, (base) => run(process.execPath, ["scripts/room-text-probe/blast.mjs", base]));
await withServer(wsPort, (base) => run(process.execPath, ["scripts/room-text-probe/blast-ws.mjs", base]));
