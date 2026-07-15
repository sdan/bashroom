// Vitest runs on Node, but the workers tsconfig has no node types.
// @ts-expect-error -- node builtin without @types/node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The RoomText hot path must stay synchronous with respect to everything
// that is not DO storage. Measured basis (NOTES.md 2026-07-08): a non-storage
// await inside a DO handler is a yield point — concurrent requests interleave
// and in-memory read-modify-write loses updates (76% loss in the probe).
// Because the store is fully synchronous, DO write coalescing batches its
// sql.exec calls into one implicit transaction per turn and output gates
// carry durability — the "memory-speed mutation, honest ack" design. This
// test makes that discipline a build property instead of a code-review hope.
// The client module is held to the same wire: it performs no I/O and holds
// no real timers — hosts inject schedule() and the transport — so the sync
// machinery stays deterministic and unit-testable without a browser.
describe("room-text hot-path discipline", () => {
  const files = ["src/room-text.ts", "src/room-text-store.ts", "src/room-text-client.ts"];

  for (const file of files) {
    it(`${file} stays synchronous (no await/async/timers/fetch)`, () => {
      const source = readFileSync(file, "utf8");
      // Strip comments so prose mentioning these words doesn't trip the wire.
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      expect(code).not.toMatch(/\basync\b/);
      expect(code).not.toMatch(/\bawait\b/);
      expect(code).not.toMatch(/\bsetTimeout\b|\bsetInterval\b/);
      expect(code).not.toMatch(/\bfetch\s*\(/);
    });
  }
});
