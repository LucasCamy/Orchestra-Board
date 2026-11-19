#!/bin/sh
set -eu

# The host records the initial contents before any worker can edit the volume.
test -f /workspace/.orchestra-initialized

if [ -f /orchestra/config/hooks.json ]; then
  mkdir -p "$CODEX_HOME"
  install -m 600 /orchestra/config/hooks.json "$CODEX_HOME/hooks.json"
  profile="$CODEX_HOME/orchestra.config.toml"
  cp /orchestra/config/orchestra.config.toml "$profile.next"
  if [ -f "$profile" ]; then sed -n '/^\[hooks/,$p' "$profile" >> "$profile.next"; fi
  mv "$profile.next" "$profile"
fi

if [ -n "$ORCHESTRA_AGENT_COMMAND" ]; then
  if [ "$ORCHESTRA_CHILD" = 1 ]; then
    exec /bin/sh -c "$ORCHESTRA_AGENT_COMMAND"
  fi
  /bin/sh -c "$ORCHESTRA_AGENT_COMMAND" || true
fi
exec /bin/sh -i
