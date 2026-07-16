import { describe, expect, it } from "vitest";
import {
  decideRoomTextPublication,
  parseRoomTextPublication,
} from "./room-text-store";

// The monotonic R2 publication guard. Measured basis (benchmarks/room-text/
// experiments/r2-flush-guard.md): without it, an older flush resumed after an
// arbitrary pause CASed HEAD backward in 458/1000 randomized adversarial
// schedules; with it, zero across 2x1000. The invariant under test: a flush
// may only publish a HEAD manifest whose (epoch, revision) is strictly newer
// than the one currently visible, must skip when it is not, and must fail
// closed when the current marker is unreadable.
describe("room-text publication guard", () => {
  const manifest = (epoch: number, revision: number) =>
    JSON.stringify({ protocol: 1, fileId: "f", path: "notes.md", epoch, revision, byteLength: 1, artifact: `${epoch}@${revision}` });

  it("parses a real manifest's identity and fails closed on anything else", () => {
    expect(parseRoomTextPublication(manifest(3, 41))).toEqual({ epoch: 3, revision: 41 });
    expect(parseRoomTextPublication("")).toBeNull();
    expect(parseRoomTextPublication("not json")).toBeNull();
    expect(parseRoomTextPublication("null")).toBeNull();
    expect(parseRoomTextPublication("[1,2]")).toEqual(null);
    expect(parseRoomTextPublication(JSON.stringify({ epoch: 1 }))).toBeNull();
    expect(parseRoomTextPublication(JSON.stringify({ revision: 1 }))).toBeNull();
    expect(parseRoomTextPublication(JSON.stringify({ epoch: 0, revision: 1 }))).toBeNull();
    expect(parseRoomTextPublication(JSON.stringify({ epoch: 1, revision: -1 }))).toBeNull();
    expect(parseRoomTextPublication(JSON.stringify({ epoch: 1.5, revision: 1 }))).toBeNull();
    expect(parseRoomTextPublication(JSON.stringify({ epoch: "1", revision: 1 }))).toBeNull();
    expect(parseRoomTextPublication(JSON.stringify({ epoch: 1, revision: 2 ** 53 }))).toBeNull();
  });

  it("publishes over an absent HEAD", () => {
    expect(decideRoomTextPublication(null, { epoch: 1, revision: 0 })).toBe("publish");
  });

  it("orders by revision within an epoch", () => {
    expect(decideRoomTextPublication(manifest(1, 1), { epoch: 1, revision: 2 })).toBe("publish");
    expect(decideRoomTextPublication(manifest(1, 2), { epoch: 1, revision: 2 })).toBe("already-visible");
    // The adversarial-probe bug: an older paused flush resuming after a newer
    // publish. It must SKIP, never CAS backward.
    expect(decideRoomTextPublication(manifest(1, 2), { epoch: 1, revision: 1 })).toBe("stale");
  });

  it("orders by epoch before revision", () => {
    expect(decideRoomTextPublication(manifest(1, 999), { epoch: 2, revision: 0 })).toBe("publish");
    expect(decideRoomTextPublication(manifest(2, 0), { epoch: 1, revision: 999 })).toBe("stale");
  });

  it("fails closed on an unreadable current HEAD", () => {
    expect(decideRoomTextPublication("garbage", { epoch: 9, revision: 9 })).toBe("unreadable");
    expect(decideRoomTextPublication(JSON.stringify({ epoch: -1, revision: 0 }), { epoch: 9, revision: 9 })).toBe("unreadable");
  });
});
