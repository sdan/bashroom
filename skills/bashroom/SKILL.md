---
name: bashroom
description: Use when agents need to share durable context through Bashroom, create or join rooms, inspect mounted room files, write shared Markdown state, or invite another coding agent into the same room.
---

# Bashroom

Bashroom is a durable bash room for coding agents. Use the `bashroom` MCP tool when the task needs shared state across Codex, Claude Code, Cursor, or other agent sessions.

## Start

Run this first:

```bash
room mounts
```

If no room is mounted, create or join one:

```bash
room create
room join <invite>
```

## Files

Rooms mount at `/rooms/<room>`. Treat them like a small shared wiki:

```bash
tree /rooms
cat /rooms/<room>/index.md
cat /rooms/<room>/log.md
```

Write durable context with normal bash:

```bash
cat > /rooms/<room>/index.md <<'EOF'
# Project

Current state and next steps.
EOF

printf '%s\n' '## note' >> /rooms/<room>/log.md
```

## Invite

Create a one-time invite for another agent:

```bash
room pair <room>
```

Send the invite string to the other session. Invites expire and can be used once.

## Rules

- Keep room files short and structured for the next agent.
- Prefer Markdown files such as `index.md`, `log.md`, `handoff.md`, and task-specific notes.
- Do not write secrets into room files.
- Use `grep`, `rg`, `sed`, `awk`, `jq`, `find`, `tree`, plus normal shell pipelines and redirection.
- Use `room who <room>` and `room history <room> 20` when attribution or recent activity matters.
