# nocx shell integration for bash
# Activated when NOCX_SHELL_INTEGRATION is set.
# Emits OSC 133 (A/B/C/D) command markers and OSC 7 (cwd).

if [[ -z "${NOCX_SHELL_INTEGRATION:-}" ]]; then
    return 2>/dev/null || exit 0
fi

if [[ -n "${__nocx_loaded:-}" ]]; then
    return 2>/dev/null || exit 0
fi
__nocx_loaded=1

__nocx_first_prompt=
__nocx_in_prompt_command=0
# Latch so the command-start (C) marker fires once per entered line, not once
# per simple command — a pipeline or list fires the DEBUG trap for each element.
#
# Initialised DISARMED (1), not armed (0): the DEBUG trap is live from the
# moment `trap ... DEBUG` runs below, and the remaining lines of THIS sourced
# script (and the rest of .bashrc after it) are ordinary commands — e.g. the
# `[[ ... ]]` tests below do not match the `__nocx_*` skip. Armed, the very
# first such test fires a spurious C, driving the input machine to RUNNING_RAW
# before the first A→B ever arrives; the first real prompt is then untrusted
# and the DOM editor never takes ownership until a command has run once
# (nocx-4ff: "editor appears only after the first command"). __nocx_precmd arms
# the latch (=0) at each prompt, so the first genuine command line still fires C.
__nocx_preexec_done=1

__nocx_encode_url() {
    local s="$1"
    s="${s// /%20}"
    s="${s//$'\t'/%09}"
    s="${s//$'\n'/%0a}"
    builtin printf '%s' "$s"
}

# The exit status is passed in as $1: the caller captures $? before any other
# command (even an assignment) can clobber it.
__nocx_precmd() {
    local __nocx_exit="$1"
    if [[ -n "$__nocx_first_prompt" ]]; then
        builtin printf '\e]133;D;%s\a' "$__nocx_exit"
    fi
    builtin printf '\e]133;A\a'
    builtin printf '\e]7;file://%s%s\a' \
        "$(__nocx_encode_url "${HOSTNAME%%.*}")" \
        "$(__nocx_encode_url "$PWD")"
    __nocx_first_prompt=1
    # Arm the command-start marker for the next command line.
    __nocx_preexec_done=0
}

__nocx_preexec() {
    builtin printf '\e]133;C\a'
}

# In marker-only mode __nocx_prompt_command runs the user/framework
# PROMPT_COMMAND first, then emits D/A/OSC 7, then sets PS1 to the
# marker-only B prompt as the final action — so a hostile framework
# PROMPT_COMMAND that rewrites PS1 cannot win. In baseline mode the
# original order is preserved (precmd first, then old PC).
__nocx_prompt_command() {
    # Capture the just-finished command's status FIRST — the assignment below
    # would otherwise reset $? to 0 before __nocx_precmd could read it.
    local __nocx_exit=$?
    __nocx_in_prompt_command=1
    if [[ "${NOCX_PROMPT_MODE:-}" == "marker-only" ]] && [[ "${__nocx_arm_marker_only:-}" == 1 ]]; then
        # Top-level session: arm the marker-only overlay.
        # 1) run the user/framework prompt command FIRST.
        if [[ -n "${__nocx_old_pc_arr+x}" ]]; then
            local __c
            for __c in "${__nocx_old_pc_arr[@]}"; do eval "$__c"; done
        elif [[ -n "${__nocx_old_pc:-}" ]]; then
            eval "$__nocx_old_pc"
        fi
        # 2) emit D/A/OSC7.
        __nocx_precmd "$__nocx_exit"
        # 3) set the marker-only prompt as the FINAL action.
        PS1="$__nocx_b_marker"
    elif [[ "${NOCX_PROMPT_MODE:-}" == "marker-only" ]]; then
        # Nested session (nocx-4ff.13): keep a visible prompt via baseline path.
        __nocx_precmd "$__nocx_exit"
        if [[ -n "${__nocx_old_pc_arr+x}" ]]; then
            local __c
            for __c in "${__nocx_old_pc_arr[@]}"; do eval "$__c"; done
        elif [[ -n "${__nocx_old_pc:-}" ]]; then
            eval "$__nocx_old_pc"
        fi
    else
        __nocx_precmd "$__nocx_exit"
        if [[ -n "${__nocx_old_pc_arr+x}" ]]; then
            local __c
            for __c in "${__nocx_old_pc_arr[@]}"; do eval "$__c"; done
        elif [[ -n "${__nocx_old_pc:-}" ]]; then
            eval "$__nocx_old_pc"
        fi
    fi

    # Command-existence snapshot (OSC 636): start the background compgen once
    # at the FIRST prompt, emit the finished payload once from a LATER prompt
    # — never in front of a prompt, and only while the shell is the sole
    # writer to the tty, so the payload cannot interleave with other output.
    if [[ -n "${__nocx_snap_staging:-}" ]] && [[ "${__nocx_snapshot_done:-0}" != "1" ]]; then
        if [[ "${__nocx_snapshot_started:-0}" != "1" ]]; then
            __nocx_snapshot_started=1
            # >| ignores a user's noclobber: the staging file already exists
            # (mktemp made it at source time), so a plain > would refuse.
            ( compgen -c 2>/dev/null | LC_ALL=C sort -u | __nocx_snapshot_build \
                >| "$__nocx_snap_staging" 2>/dev/null \
                && mv -f "$__nocx_snap_staging" "$__nocx_snap_file" ) &
            __nocx_snap_job=$!
        elif [[ -f "$__nocx_snap_file" ]]; then
            __nocx_snapshot_done=1
            __nocx_payload="$(< "$__nocx_snap_file")"
            builtin printf '\e]636;S;%s;%s\a' "$__nocx_snapshot_nonce" "$__nocx_payload"
            rm -f "$__nocx_snap_staging" "$__nocx_snap_file"
        fi
    fi
    __nocx_in_prompt_command=0
}

if [[ -z "${PROMPT_COMMAND:-}" ]]; then
    PROMPT_COMMAND='__nocx_prompt_command'
elif [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == declare\ -a* ]]; then
    # Array form: save and replace.
    eval "__nocx_old_pc_arr=(\"\${PROMPT_COMMAND[@]}\")"
    PROMPT_COMMAND='__nocx_prompt_command'
else
    __nocx_old_pc="$PROMPT_COMMAND"
    PROMPT_COMMAND='__nocx_prompt_command'
fi

# Save the original DEBUG trap so we can chain to it after our preexec hook.
__nocx_old_debug="$(trap -p DEBUG 2>/dev/null | sed "s/^trap -- '//;s/' DEBUG$//")"

__nocx_preexec_wrapper() {
    local __nocx_current_command=${BASH_COMMAND}
    # Fire the command-start marker once per entered line. Skip our own
    # internal commands, anything that runs while servicing PROMPT_COMMAND, and
    # every command after the first (the DEBUG trap fires per simple command,
    # so a pipeline/list would otherwise emit several C markers).
    if [[ "$__nocx_current_command" != __nocx_* ]] \
        && [[ "${__nocx_in_prompt_command:-0}" != "1" ]] \
        && [[ "${__nocx_preexec_done:-0}" != "1" ]]; then
        __nocx_preexec_done=1
        __nocx_preexec
    fi
    # Chain to the previous DEBUG trap, if any.
    if [[ -n "${__nocx_old_debug:-}" ]]; then
        eval "$__nocx_old_debug"
    fi
}
trap '__nocx_preexec_wrapper' DEBUG

__nocx_b_marker='\[\e]133;B\a\]'

if [[ "${NOCX_PROMPT_MODE:-}" != "marker-only" ]] || [[ "${__nocx_arm_marker_only:-}" != 1 ]]; then
    # Baseline mode or nested marker-only (nocx-4ff.13): wrap PS1 with
    # the B marker so the prompt is visible. Top-level marker-only leaves
    # PS1 untouched — __nocx_prompt_command sets it at runtime.
    if [[ -z "${__nocx_prompt_wrapped:-}" ]]; then
        # Use ANSI-C quoting with doubled backslashes so \[ and \] are emitted
        # literally; they tell bash that the OSC sequence is non-printing.
        PS1="${PS1:-}"$'\\[\e]133;B\\a\\]'
        __nocx_prompt_wrapped=1
    fi
fi

# Nested-session gate (nocx-4ff.13): record the owning session at source
# time so child shells see the guard and keep a visible prompt.
# ALSO capture owner-ness into __nocx_arm_marker_only before the export,
# so __nocx_prompt_command can distinguish owner from nested descendant.
if [[ "${NOCX_PROMPT_MODE:-}" == "marker-only" ]] && [[ -z "${__nocx_owned_session:-}" ]]; then
    __nocx_owned_session="${NOCX_SESSION_ID:-}"
    export __nocx_owned_session
    __nocx_arm_marker_only=1
fi

#   OSC 636 ; S ; <nonce> ; <names> ST          snapshot; <names> is
#                                               `;`-joined and hex-escaped
#                                               (\\ for backslash, \xHH for
#                                               control/C1 bytes and ';')
#   OSC 636 ; H ; <nonce> ST                    session hello — the FIRST 636
#                                               message, before any command
# The nonce is a per-session secret generated here: any process can print an
# OSC — a command's own output can forge a snapshot — so the frontend
# discards any payload that does not carry the established nonce. It is
# emitted at source time, before the first prompt, when no user command has
# run; the frontend accepts exactly one hello, so a forged re-hello cannot
# re-anchor the nonce.
#
# compgen -c | sort -u measures ~37 ms on this machine and can take seconds
# on NFS, so it must never sit in front of the prompt. The snapshot is
# computed in a background job started at the FIRST prompt (the environment
# is final only once the rc has finished) and emitted from the NEXT prompt —
# the only moment the shell is the sole writer to the tty, so the payload
# can never interleave with other output. One snapshot per session; staleness
# is deliberately a later problem (per-prompt fingerprints cost the same
# enumeration they were meant to save).
#
# The snapshot is staged in a mktemp file whose name carries no secret — the
# nonce must never appear in a path, in any argv, or exported — and mode 600
# from creation. An EXIT trap (chained, like the DEBUG trap) removes the
# staging and final files even when the shell exits before the snapshot was
# emitted, and the final name only exists after the atomic mv, so a prompt
# can never read a partial payload.
__nocx_gen_nonce() {
    # 32 hex chars from the kernel RNG; RANDOM+$$ fallback if od is missing.
    local n
    n="$(od -An -N16 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')"
    if [[ -n "$n" ]]; then
        builtin printf '%s' "$n"
    else
        builtin printf '%04x%04x%04x%04x' "$RANDOM" "$RANDOM" "$RANDOM" "$RANDOM"
    fi
}
__nocx_snapshot_nonce="$(__nocx_gen_nonce)"
# A user rc running under `set -a` would auto-export every assignment,
# publishing the nonce in /proc/<pid>/environ; drop the export attribute
# explicitly (the nonce is assigned exactly once, so this sticks).
export -n __nocx_snapshot_nonce
# The snapshot is staged in a mktemp file whose name carries NO secret: the
# nonce must never appear in a path (ls /tmp is world-readable), in any argv
# (ps reads argv), or exported (/proc/<pid>/environ) — the nonce is the whole
# forgery defence of OSC 636. mktemp creates the file mode 600 from the
# start (no create-then-chmod window) with O_EXCL (no symlink pre-emption).
# The atomic mv to the .snap name below is what tells a later prompt the
# payload is complete; the .snap name inherits the staging file's 600 mode.
__nocx_snap_staging="$(mktemp "${TMPDIR:-/tmp}/nocx-snap.XXXXXX" 2>/dev/null)"
__nocx_snap_file="${__nocx_snap_staging:+${__nocx_snap_staging}.snap}"
__nocx_snapshot_started=0
__nocx_snapshot_done=0

# Nothing may survive the shell: a session that exits before the snapshot was
# emitted (the leak path) must leave no file behind. Kill the background
# compgen first — it could otherwise mv the .snap name into place AFTER the
# rm below — then remove both files, then chain the shell's pre-existing EXIT
# trap, the same pattern the DEBUG trap above uses. jobs -p guards the kill:
# a long-lived interactive session's job is long done, and killing a reaped
# PID could hit a reused one.
__nocx_old_exit="$(trap -p EXIT 2>/dev/null | sed "s/^trap -- '//;s/' EXIT$//")"
__nocx_exit_cleanup() {
    # The DEBUG trap fires for every simple command below (and inside trap
    # handlers on some bash versions); mark the exit path as "in a prompt
    # command" so the wrapper suppresses any spurious OSC 133 C.
    __nocx_in_prompt_command=1
    if [[ -n "${__nocx_snap_job:-}" ]] \
        && jobs -p 2>/dev/null | grep -qx "$__nocx_snap_job"; then
        kill "$__nocx_snap_job" 2>/dev/null
        wait "$__nocx_snap_job" 2>/dev/null
    fi
    if [[ -n "${__nocx_snap_staging:-}" ]]; then
        rm -f "$__nocx_snap_staging" "$__nocx_snap_file"
    fi
    if [[ -n "${__nocx_old_exit:-}" ]]; then
        eval "$__nocx_old_exit"
    fi
}
trap '__nocx_exit_cleanup' EXIT

# Hex-escape one command name into the global payload accumulator, appending
# a `;` separator. Bytes that would break or fake the OSC sequence are
# escaped as \xHH; backslash is \\ (VS Code's scheme). Raw UTF-8 (>= 0xa0)
# passes through — the terminal decodes the byte stream, and escaping every
# byte would double the payload for no safety.
__nocx_encode_hex_into() {
    local s="$1" i c code hex LC_ALL=C
    for ((i = 0; i < ${#s}; i++)); do
        c="${s:i:1}"
        if [[ "$c" == '\' ]]; then
            __nocx_payload+='\\'
        elif [[ "$c" == ';' ]]; then
            __nocx_payload+='\x3b'
        else
            builtin printf -v code '%d' "'$c"
            (( code < 0 )) && (( code += 256 ))
            if (( code < 32 || (code >= 127 && code <= 159) )); then
                builtin printf -v hex '%02x' "$code"
                __nocx_payload+="\\x$hex"
            else
                __nocx_payload+="$c"
            fi
        fi
    done
    __nocx_payload+=';'
}

# Fill __nocx_payload with the hex-escaped, `;`-joined names, capped at
# 8192 names and 65536 encoded characters. Returns non-zero when the list is
# empty — an empty snapshot must never reach the frontend: "every command is
# unknown" is the same lie as "every command exists", pointing the other way.
__nocx_snapshot_build() {
    __nocx_payload=''
    local line n=0 before LC_ALL=C
    while IFS= read -r line; do
        before=${#__nocx_payload}
        __nocx_encode_hex_into "$line"
        if (( ${#__nocx_payload} > 65536 )); then
            __nocx_payload="${__nocx_payload:0:before}"
            break
        fi
        n=$((n + 1))
        if (( n >= 8192 )); then
            break
        fi
    done
    # Emit the payload on stdout — the caller redirects it into the temp file.
    if [[ -n "$__nocx_payload" ]]; then
        builtin printf '%s' "$__nocx_payload"
        return 0
    fi
    return 1
}

# Announce the session nonce before the first prompt.
builtin printf '\e]636;H;%s\a' "$__nocx_snapshot_nonce"

# Native-mode escape (nocx-4ff.9): restore a visible prompt.
__nocx_native_mode() {
    unset NOCX_PROMPT_MODE
    PS1='\w \$ '
}
