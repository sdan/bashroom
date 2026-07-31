import { describe, expect, it } from "vitest";
import {
  PROFILE_ACTIVITY_WINDOW_DAYS,
  profileActivityWindow,
  summarizeProfileActivity,
} from "./profile-stats";

describe("profileActivityWindow", () => {
  it("returns an inclusive 371-day UTC window", () => {
    expect(PROFILE_ACTIVITY_WINDOW_DAYS).toBe(371);
    expect(profileActivityWindow(new Date("2026-07-31T23:59:59.000Z"))).toEqual({
      startDay: "2025-07-26",
      endExclusiveDay: "2026-08-01",
    });
  });
});

describe("summarizeProfileActivity", () => {
  it("counts active days and derives current and longest UTC streaks", () => {
    const summary = summarizeProfileActivity([
      { day: "2026-07-20", changed_files: 2 },
      { day: "2026-07-21", changed_files: 1 },
      { day: "2026-07-29", changed_files: 3 },
      { day: "2026-07-30", changed_files: 1 },
      { day: "2026-07-31", changed_files: 4 },
    ], new Date("2026-07-31T12:00:00.000Z"));

    expect(summary).toEqual({
      active_days: 5,
      current_streak: 3,
      longest_streak: 3,
      activity: [
        { day: "2026-07-20", changed_files: 2 },
        { day: "2026-07-21", changed_files: 1 },
        { day: "2026-07-29", changed_files: 3 },
        { day: "2026-07-30", changed_files: 1 },
        { day: "2026-07-31", changed_files: 4 },
      ],
    });
  });

  it("filters invalid, future, zero, and out-of-window rows", () => {
    const summary = summarizeProfileActivity([
      { day: "2025-07-25", changed_files: 9 },
      { day: "2025-07-26", changed_files: 1 },
      { day: "2026-07-30", changed_files: 2 },
      { day: "2026-07-30", changed_files: 3 },
      { day: "2026-07-31", changed_files: 0 },
      { day: "2026-08-01", changed_files: 5 },
      { day: "not-a-day", changed_files: 7 },
    ], new Date("2026-07-31T08:00:00.000Z"));

    expect(summary).toEqual({
      active_days: 2,
      current_streak: 0,
      longest_streak: 1,
      activity: [
        { day: "2025-07-26", changed_files: 1 },
        { day: "2026-07-30", changed_files: 5 },
      ],
    });
  });

  it("treats leap-day neighbors as consecutive UTC days", () => {
    const summary = summarizeProfileActivity([
      { day: "2024-02-28", changed_files: 1 },
      { day: "2024-02-29", changed_files: 1 },
      { day: "2024-03-01", changed_files: 1 },
    ], new Date("2024-03-01T00:00:00.000Z"));

    expect(summary.current_streak).toBe(3);
    expect(summary.longest_streak).toBe(3);
  });
});
