#!/bin/bash
# post_write_code hook for OpenBlink — Auto-trigger Build & Blink
#
# When Cascade edits a .rb file, this hook creates a trigger file that the
# OpenBlink extension picks up via FileSystemWatcher and runs Build & Blink.
#
# Input: JSON on stdin with tool_info.file_path

input=$(cat)
file_path=$(echo "$input" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"file_path"[[:space:]]*:[[:space:]]*"\(.*\)"/\1/')

# Only trigger for .rb files
if [[ "$file_path" != *.rb ]]; then
  exit 0
fi

# Reject paths with dangerous characters (newlines, control chars) or '..' path segments
if [[ "$file_path" =~ [[:cntrl:]] ]]; then
  exit 0
fi
# Check for '..' path components (but allow filenames that contain '..' as a substring)
IFS='/' read -ra segments <<< "$file_path"
for seg in "${segments[@]}"; do
  if [[ "$seg" == ".." ]]; then
    exit 0
  fi
done

# Determine workspace root (directory containing .windsurf/)
script_dir="$(cd "$(dirname "$0")" && pwd)"
workspace_root="$(cd "$script_dir/../.." && pwd)"

# Create trigger file for the extension to pick up
trigger_dir="$workspace_root/.openblink"
mkdir -p "$trigger_dir"

request_id="hook_$(date +%s)_$$"
relative_path="${file_path#$workspace_root/}"

# Escape backslashes and double quotes for safe JSON embedding
escaped_path=$(printf '%s' "$relative_path" | sed 's/\\/\\\\/g; s/"/\\"/g')

printf '{\n  "file": "%s",\n  "requestId": "%s"\n}\n' "$escaped_path" "$request_id" > "$trigger_dir/trigger.json"

exit 0
