#!/bin/sh
# Installs the AgentTunnel skill for Claude Code and Codex.
set -eu
skill=$(curl -fsSL https://agenttunnel.dev/skill.md)
for dir in "$HOME/.claude/skills" "$HOME/.codex/skills"; do
  mkdir -p "$dir/agent-tunnel"
  printf '%s\n' "$skill" > "$dir/agent-tunnel/SKILL.md"
  echo "Installed $dir/agent-tunnel/SKILL.md"
done
