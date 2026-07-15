import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "../..");
const wrangler = path.join(root, "node_modules", ".bin", "wrangler");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

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

const port = await freePort();
const persistence = await mkdtemp(path.join(os.tmpdir(), "bashroom-room-text-probe-"));
const server = spawn(wrangler, [
  "dev",
  "-c", "scripts/room-text-probe/wrangler.jsonc",
  "--port", String(port),
  "--persist-to", persistence,
  "--log-level", "error",
], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });

try {
  await waitForReady(server, `http://127.0.0.1:${port}`);
  await run(process.execPath, ["scripts/room-text-probe/blast.mjs", `http://127.0.0.1:${port}`]);
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
