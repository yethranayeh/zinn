#!/bin/sh
# Restore guard for a quiet measurement session.
#
# Usage: guard.sh <guard-log> <restore-state-file> <session-status-file> <out-status-file>
#
# The wrapper starts this once as root, after sudo -v, with its stdin and
# stdout connected to pipes. The guard runs every system change and every undo,
# so neither needs a terminal or a sudo ticket. If its stdin closes without an
# END line, the wrapper is gone and the guard restores every change it still
# has applied.
#
# Protocol, one request per line with words separated by single spaces:
#   apply spotlight <volume>     mdutil -i off <volume>
#   undo spotlight <volume>      mdutil -i on <volume>
#   apply time-machine           tmutil disable
#   undo time-machine            tmutil enable
#   apply wifi <device>          networksetup -setairportpower <device> off
#   undo wifi <device>           networksetup -setairportpower <device> on
#   END                          exit without restoring
# A volume path with spaces is the rest of the line after the kind.
# The guard prints "ready" before it reads requests. Each request gets one
# reply line:
#   <exit-code> <stderr with line breaks replaced by spaces>
# A rejected request replies with exit code 2.
#
# Commands are found with PATH=/usr/bin:/usr/sbin:/bin:/sbin. A test may replace
# that PATH with QUIET_SESSION_GUARD_PATH.
# The guard ignores SIGHUP, SIGINT and SIGPIPE and restores on SIGTERM.

if [ "$#" -ne 4 ]; then
  printf 'usage: guard.sh <guard-log> <restore-state-file> <session-status-file> <out-status-file>\n' >&2
  exit 2
fi

guard_log=$1
state_file=$2
status_file=$3
out_status_file=$4

PATH=${QUIET_SESSION_GUARD_PATH:-/usr/bin:/usr/sbin:/bin:/sbin}
export PATH

RESTORE_COMMAND='bun run measure:quiet restore'

applied=
exit_code=0
command_stderr=
flat_stderr=
status_lines=

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$guard_log" 2>/dev/null
}

flatten() {
  printf '%s\n' "$1" | {
    flat=
    while IFS= read -r line; do
      flat="$flat $line"
    done
    printf '%s' "${flat# }"
  }
}

run_command() {
  command_name=$1
  shift
  old_ifs=$IFS
  IFS=' '
  command_text=$*
  IFS=$old_ifs
  log "command: $command_name $command_text"
  command_stderr=$("$command_name" "$@" 2>&1 >/dev/null)
  exit_code=$?
  flat_stderr=$(flatten "$command_stderr")
  log "exit $exit_code"
  log "stderr: $flat_stderr"
}

reply() {
  printf '%s %s\n' "$1" "$2"
}

add_applied() {
  applied="${applied}${1}	${2}
"
}

remove_applied() {
  remove_kind=$1
  remove_arg=$2
  kept=
  old_ifs=$IFS
  IFS='
'
  for entry in $applied; do
    entry_kind=${entry%%	*}
    entry_arg=${entry#*	}
    if [ "$entry_kind" = "$remove_kind" ] && [ "$entry_arg" = "$remove_arg" ]; then
      continue
    fi
    kept="${kept}${entry}
"
  done
  IFS=$old_ifs
  applied=$kept
}

apply_change() {
  change_kind=$1
  change_arg=$2
  if [ -z "$change_arg" ] && [ "$change_kind" != "time-machine" ]; then
    log "rejected request: missing argument for $change_kind"
    log "exit 2"
    reply 2 "rejected request: missing argument"
    return
  fi
  add_applied "$change_kind" "$change_arg"
  case $change_kind in
    spotlight)
      run_command mdutil -i off "$change_arg"
      ;;
    time-machine)
      run_command tmutil disable
      ;;
    wifi)
      run_command networksetup -setairportpower "$change_arg" off
      ;;
  esac
  reply "$exit_code" "$flat_stderr"
}

undo_change_command() {
  change_kind=$1
  change_arg=$2
  case $change_kind in
    spotlight)
      run_command mdutil -i on "$change_arg"
      ;;
    time-machine)
      run_command tmutil enable
      ;;
    wifi)
      run_command networksetup -setairportpower "$change_arg" on
      ;;
  esac
  if [ "$exit_code" -eq 0 ]; then
    remove_applied "$change_kind" "$change_arg"
  fi
}

undo_change() {
  if [ -z "$2" ] && [ "$1" != "time-machine" ]; then
    log "rejected request: missing argument for $1"
    log "exit 2"
    reply 2 "rejected request: missing argument"
    return
  fi
  undo_change_command "$1" "$2"
  reply "$exit_code" "$flat_stderr"
}

add_status_line() {
  status_lines="${status_lines}${1}
"
}

write_status() {
  if ! printf '%s' "$status_lines" > "$status_file" 2>/dev/null; then
    log "could not write $status_file"
  fi
  if ! printf '%s' "$status_lines" > "$out_status_file" 2>/dev/null; then
    log "could not write $out_status_file"
  fi
}

restore_all() {
  restore_reason=$1
  trap '' HUP INT PIPE TERM
  log "restoring applied changes: $restore_reason"
  status_lines=
  add_status_line "quiet-session guard restore"
  add_status_line "$restore_reason"
  if [ -z "$applied" ]; then
    add_status_line "No changes were applied."
    if rm -f "$state_file" 2>/dev/null; then
      add_status_line "Restore state file removed."
    else
      add_status_line "Could not remove the restore state file: $state_file"
    fi
    write_status
    log "no changes to restore"
    return 0
  fi

  reversed=
  old_ifs=$IFS
  IFS='
'
  for entry in $applied; do
    reversed="${entry}
${reversed}"
  done

  failed=0
  for entry in $reversed; do
    restore_kind=${entry%%	*}
    restore_arg=${entry#*	}
    restore_label=$restore_kind
    if [ -n "$restore_arg" ]; then
      restore_label="$restore_kind $restore_arg"
    fi
    undo_change_command "$restore_kind" "$restore_arg"
    if [ "$exit_code" -eq 0 ]; then
      add_status_line "Undo $restore_label: exit 0"
    else
      failed=1
      add_status_line "Undo $restore_label: exit $exit_code $flat_stderr"
    fi
  done
  IFS=$old_ifs

  if [ "$failed" -eq 0 ]; then
    if rm -f "$state_file" 2>/dev/null; then
      add_status_line "Restore state file removed."
    else
      failed=1
      add_status_line "Could not remove the restore state file: $state_file"
    fi
  else
    add_status_line "Restore state file kept at $state_file"
    add_status_line "Run: $RESTORE_COMMAND"
  fi
  write_status

  if [ "$failed" -eq 0 ]; then
    log "restored every applied change"
  else
    log "restore failed, state file kept at $state_file"
    log "run: $RESTORE_COMMAND"
  fi
  return "$failed"
}

handle_request() {
  request=$1
  case $request in
    "apply spotlight -"* | "undo spotlight -"* | "apply wifi -"* | "undo wifi -"*)
      # An argument starting with a dash would reach the command as an option.
      log "rejected request: $request"
      log "exit 2"
      reply 2 "rejected request: argument starts with a dash"
      ;;
    "apply spotlight "*)
      apply_change spotlight "${request#apply spotlight }"
      ;;
    "undo spotlight "*)
      undo_change spotlight "${request#undo spotlight }"
      ;;
    "apply time-machine")
      apply_change time-machine ""
      ;;
    "undo time-machine")
      undo_change time-machine ""
      ;;
    "apply wifi "*)
      apply_change wifi "${request#apply wifi }"
      ;;
    "undo wifi "*)
      undo_change wifi "${request#undo wifi }"
      ;;
    "apply spotlight" | "undo spotlight" | "apply wifi" | "undo wifi")
      log "rejected request: missing argument"
      log "exit 2"
      reply 2 "rejected request: missing argument"
      ;;
    *)
      log "rejected request: $request"
      log "exit 2"
      reply 2 "rejected request"
      ;;
  esac
}

# A closed terminal or Ctrl-C must not stop the guard before it restores.
trap '' HUP INT PIPE
trap 'restore_all "the guard received SIGTERM"; exit 143' TERM

log "guard started"
printf 'ready\n'
while IFS= read -r request; do
  log "request: $request"
  if [ "$request" = "END" ]; then
    log "END received, exiting without restoring"
    exit 0
  fi
  handle_request "$request"
done

restore_all "The wrapper ended unexpectedly without sending END."
exit $?
