import { defineConfig } from "vitest/config";

// Scope discovery to src/ so runs never walk into .claude/worktrees/, where
// swarm lanes carry duplicate copies of these suites. A 2026-07-16 review
// caught a reported "230/230" that was 57 distinct tests tripled by nested
// worktree discovery. The true branch count is 57.
export default defineConfig({
  test: {
    dir: "src",
    exclude: ["**/node_modules/**", "**/.claude/**", "**/worktrees/**"],
  },
});
