import { describe, expect, it } from "vitest";
import { webIndexHtml } from "./web-ui";

describe("private self profile", () => {
  const html = webIndexHtml();

  it("routes @handle before rooms and preserves document lifecycle boundaries", () => {
    expect(html).toContain('function profileHandleFromUrl()');
    expect(html).toContain('if (profileHandleFromUrl()) return null');
    expect(html).toContain('flushAutosave();\n    resetHistory();');
    expect(html).toContain('profileSurface = true;\n    profileRouteHandle = String(state.handle);\n    disconnectPresence();');
    expect(html).toContain('const fromUrl = share || profileSurface ? null : stateFromUrl()');
  });

  it("uses the private aggregate endpoint without persisting profile data", () => {
    expect(html).toContain('api("/web/api/profile")');
    for (const field of ["room_count", "file_count", "active_days", "current_streak", "longest_streak", "storage_bytes", "last_change_at", "changed_files"]) {
      expect(html).toContain(field);
    }
    expect(html).not.toContain('localStorage.setItem("bashroom.profile');
  });

  it("keeps activity quiet, truthful, and out of the tab order", () => {
    expect(html).toContain("Durable changes in your rooms");
    expect(html).toContain("Distinct file paths changed each day. Repeated saves and retries collapse to one file per day.");
    expect(html).toContain('role="img" aria-label="');
    expect(html).toContain('grid-template-columns: repeat(var(--profile-weeks, 54), 10px)');
    expect(html).toContain('newProfileCalendar.scrollLeft = profileCalendarScroll === null');
    expect(html).toContain('<span class="profile-day level-');
    expect(html).not.toContain('<button class="profile-day');
  });

  it("provides semantic profile, return, retry, and sign-out controls", () => {
    expect(html).toContain('id="profile-open" type="button"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('id="profile-back" type="button"');
    expect(html).toContain('id="profile-retry" type="button"');
    expect(html).toContain('id="logout" type="button"');
    expect(html).toContain("if (!state.token || share || profileSurface) { hideFeatureTour(); return; }");
  });
});
