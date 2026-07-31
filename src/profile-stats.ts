const DAY_MS = 24 * 60 * 60 * 1000;

export const PROFILE_ACTIVITY_WINDOW_DAYS = 371;

export type ProfileActivityRow = {
  day: string;
  changed_files: number;
};

export type ProfileActivitySummary = {
  active_days: number;
  current_streak: number;
  longest_streak: number;
  activity: ProfileActivityRow[];
};

export type ProfileActivityWindow = {
  startDay: string;
  endExclusiveDay: string;
};

/** UTC day bounds shared by the Registry query and the streak reducer. */
export function profileActivityWindow(today = new Date()): ProfileActivityWindow {
  const todayMs = utcMidnightMs(today);
  return {
    startDay: dayAt(todayMs - (PROFILE_ACTIVITY_WINDOW_DAYS - 1) * DAY_MS),
    endExclusiveDay: dayAt(todayMs + DAY_MS),
  };
}

/**
 * Normalize daily durable-change counts and derive streaks within the same
 * trailing UTC window returned to the browser. Current streak requires a
 * change today; missing days terminate a streak.
 */
export function summarizeProfileActivity(
  rows: readonly ProfileActivityRow[],
  today = new Date(),
): ProfileActivitySummary {
  const todayMs = utcMidnightMs(today);
  const startMs = todayMs - (PROFILE_ACTIVITY_WINDOW_DAYS - 1) * DAY_MS;
  const counts = new Map<number, number>();

  for (const row of rows) {
    const dayMs = parseDay(row.day);
    const changedFiles = Math.max(0, Math.floor(Number(row.changed_files) || 0));
    if (dayMs === null || dayMs < startMs || dayMs > todayMs || changedFiles === 0) continue;
    counts.set(dayMs, (counts.get(dayMs) || 0) + changedFiles);
  }

  const orderedDays = [...counts.keys()].sort((left, right) => left - right);
  let longestStreak = 0;
  let run = 0;
  let previous: number | null = null;
  for (const dayMs of orderedDays) {
    run = previous !== null && dayMs === previous + DAY_MS ? run + 1 : 1;
    longestStreak = Math.max(longestStreak, run);
    previous = dayMs;
  }

  let currentStreak = 0;
  for (let cursor = todayMs; counts.has(cursor); cursor -= DAY_MS) currentStreak += 1;

  return {
    active_days: orderedDays.length,
    current_streak: currentStreak,
    longest_streak: longestStreak,
    activity: orderedDays.map((dayMs) => ({
      day: dayAt(dayMs),
      changed_files: counts.get(dayMs) || 0,
    })),
  };
}

function utcMidnightMs(value: Date): number {
  if (!Number.isFinite(value.getTime())) throw new Error("invalid profile activity date");
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

function parseDay(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && dayAt(parsed) === value ? parsed : null;
}

function dayAt(value: number): string {
  return new Date(value).toISOString().slice(0, 10);
}
