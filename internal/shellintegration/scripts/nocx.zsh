# nocx shell integration for zsh
# Activated when NOCX_SHELL_INTEGRATION is set.
# Emits OSC 133 (A/B/C/D) command markers and OSC 7 (cwd).

if [[ -z "${NOCX_SHELL_INTEGRATION:-}" ]]; then
    return 2>/dev/null || exit 0
fi

if [[ -n "${__nocx_loaded:-}" ]]; then
    return 2>/dev/null || exit 0
fi
__nocx_loaded=1

# Environment identity — the readiness passport (OSC 636 ; P) and the
# nocx_env= tag on every OSC 133 marker. NOCX_ENVIRONMENT_ID is minted by the
# backend delivery planner per attempt and exported by the launcher before
# this script is sourced; a shell without it (transient-integrated, raw, or a
# child shell inside tmux/sudo) emits no passport and no tagged marker —
# fail-open, exactly the pre-passport behaviour. The id is restricted to
# [A-Za-z0-9._-]{1,64}; a marker is tagged only when the id is present AND
# well-formed, because a malformed id must never reach the wire.
__nocx_env_id="${NOCX_ENVIRONMENT_ID:-}"
__nocx_parent_env_id="${NOCX_PARENT_ENVIRONMENT_ID:--}"
__nocx_generation="${NOCX_GENERATION:--}"
__nocx_tagged=0
if [[ -n "$__nocx_env_id" ]] && [[ "$__nocx_env_id" =~ ^[A-Za-z0-9._-]{1,64}$ ]]; then
    __nocx_tagged=1
fi

# --- Authenticated lifecycle channel (ADR-0024, docs/lifecycle-protocol.md) ---
# The command lifecycle rides a channel that is not the tty; every envelope
# is authenticated by the per-epoch capability. The capability reaches the
# shell substituted into the bootstrap script text (the launcher rcfile's
# @CAP@, or the first line of the in-band raw-mode stream); it is NEVER in
# the environment, never exported, and never written to a file. A shell
# without a capability, a transport or an accept is a conventional terminal:
# the native prompt stays visible and no lifecycle event is sent (ADR-0024
# decisions 3 and 9).
#
# The envelope addresses lane, domain and epoch explicitly — they are names,
# not secrets, and arrive via the launcher environment (NOCX_LIFECYCLE_*) or
# the in-band dispatcher. The transport is either an inherited descriptor
# (NOCX_LIFECYCLE_FD, local) or a loopback TCP port (NOCX_LIFECYCLE_PORT,
# remote and in-band).
__nocx_cap="${__nocx_cap:-}"
# zsh has no `export -n`: `typeset +x` removes the export attribute. A
# user rc running under `set -a` would otherwise auto-export the bootstrap's
# assignment, publishing the capability in /proc/<pid>/environ.
# NOTE: zsh's `typeset -n` is a nameref — never use it for this.
typeset +x __nocx_cap 2>/dev/null
__nocx_lc_lane="${NOCX_LIFECYCLE_LANE:-}"
__nocx_lc_dom="${NOCX_LIFECYCLE_DOMAIN:-}"
__nocx_lc_epoch="${NOCX_LIFECYCLE_EPOCH:-}"
__nocx_lc_fd="${NOCX_LIFECYCLE_FD:-}"
__nocx_lc_port="${NOCX_LIFECYCLE_PORT:-}"
if [[ "${NOCX_LIFECYCLE_TIMEOUT_MS:-}" =~ ^[0-9]+$ ]] && (( NOCX_LIFECYCLE_TIMEOUT_MS >= 1 )); then
    # zsh `read -t` takes integer seconds; ceil the millisecond override.
    __nocx_lc_timeout_s=$(( (NOCX_LIFECYCLE_TIMEOUT_MS + 999) / 1000 ))
else
    # Matches the kernel's hello_timeout (protocol doc §5): a shell that
    # gives up before the kernel's own budget would strand an accept that
    # arrives late, leaving an Established domain with no consumer.
    __nocx_lc_timeout_s=10
fi
__nocx_lc_active=0
__nocx_lc_seq=0
__nocx_lc_attempt_open=0
__nocx_lc_frame=''
__nocx_lc_lane_esc=''
__nocx_lc_dom_esc=''

# JSON-escape one string into __nocx_lc_json_escaped. Backslash, quote and
# the C0/DEL bytes JSON forbids are escaped; raw UTF-8 passes through.
# Deliberately NOT under LC_ALL=C: zsh's character-class pattern matching
# misbehaves in the C locale (verified), and the byte-counting callers
# (__nocx_lc_send/__nocx_lc_read_frame) scope LC_ALL=C themselves.
__nocx_lc_json_escape() {
    local s="$1" out i c code hex
    out=${s//\\/\\\\}
    out=${out//\"/\\\"}
    out=${out//$'\n'/\\n}
    out=${out//$'\t'/\\t}
    out=${out//$'\r'/\\r}
    out=${out//$'\b'/\\b}
    out=${out//$'\f'/\\f}
    # Remaining C0 (0x01-0x08, 0x0b, 0x0c, 0x0e-0x1f) and DEL break a JSON
    # string; the common escapes above already took \t \n \r \b \f. zsh
    # strings are 1-indexed, so the loop runs 1..length.
    if [[ "$out" == *[$'\001'-$'\010'$'\013'$'\014'$'\016'-$'\037'$'\177']* ]]; then
        for ((i = 1; i <= ${#out}; i++)); do
            c=${out[i]}
            code=$(( #c ))
            if (( code >= 0 && (code < 32 || code == 127) )); then
                hex=${(l:2::0:)$(( [##16] code ))}
                out="${out[1,i-1]}\\u00${hex}${out[i+1,${#out}]}"
            fi
        done
    fi
    __nocx_lc_json_escaped=$out
}

# Send one envelope: 4-byte big-endian length prefix then the JSON bytes
# (protocol doc §6). Every envelope carries the full addressing tuple and
# the bearer capability; the sequence increments per envelope (doc §11).
# LC_ALL=C so ${#json} counts bytes, not characters.
__nocx_lc_send() {
    # $1 = event kind; $2 = extra JSON fields (leading comma) or empty
    local __evt="$1" __extra="${2:-}" __json __len __b0 __b1 __b2 __b3 LC_ALL=C
    __nocx_lc_seq=$(( __nocx_lc_seq + 1 ))
    __json="{\"v\":1,\"lane\":\"${__nocx_lc_lane_esc}\",\"dom\":\"${__nocx_lc_dom_esc}\",\"epoch\":${__nocx_lc_epoch},\"seq\":${__nocx_lc_seq},\"cap\":\"${__nocx_cap}\",\"evt\":\"${__evt}\"${__extra}}"
    __len=${#__json}
    __b0=$(( (__len >> 24) & 0xff )); __b1=$(( (__len >> 16) & 0xff ))
    __b2=$(( (__len >> 8) & 0xff )); __b3=$(( __len & 0xff ))
    builtin printf "\\$(printf '%03o' "$__b0")\\$(printf '%03o' "$__b1")\\$(printf '%03o' "$__b2")\\$(printf '%03o' "$__b3")%s" "$__json" >&"$__nocx_lc_fd" 2>/dev/null
}

# Read one length-prefixed JSON frame into __nocx_lc_frame. zsh's `read -k`
# is binary-safe (unlike bash's), so the NUL-containing prefix is read
# directly; the length bytes are parsed through od. Any framing failure
# (EOF, garbage, oversize) returns non-zero and the caller fails open.
__nocx_lc_read_frame() {
    local __hdr __hex __len LC_ALL=C
    if ! read -t "$__nocx_lc_timeout_s" -k 4 -u "$__nocx_lc_fd" __hdr 2>/dev/null; then
        return 1
    fi
    __hex=$(printf %s "$__hdr" | od -An -tx1 | tr -d ' \n')
    [[ "$__hex" =~ ^[0-9a-f]{8}$ ]] || return 1
    __len=$(( 16#$__hex ))
    (( __len > 0 && __len <= 65536 )) || return 1
    if ! read -t "$__nocx_lc_timeout_s" -k "$__len" -u "$__nocx_lc_fd" __nocx_lc_frame 2>/dev/null; then
        return 1
    fi
    return 0
}

# The render fence: 32 random bytes (64 hex chars) the shell generates when
# a command finishes and writes to the pty after the output. It is a
# rendezvous for render ordering and carries NO authority (protocol doc §8);
# when /dev/urandom is unavailable a session-scoped pseudo-random fallback
# is honest for a nonce whose only job is matching.
__nocx_lc_fence() {
    local f i
    f="$(od -An -N32 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')"
    if [[ -z "$f" ]]; then
        # zsh printf has no -v; the [##16] arithmetic flag builds hex with
        # no fork. RANDOM is 15 bits, so four digits per draw, 16 draws.
        for ((i = 0; i < 16; i++)); do
            f+="${(l:4::0:)$(( [##16] RANDOM ))}"
        done
    fi
    f="${f:0:64}"
    if [[ "$f" =~ ^[0-9a-f]{64}$ ]]; then
        __nocx_lc_fence_hex=$f
        return 0
    fi
    return 1
}

# Establish the channel: connect (or use the inherited descriptor), send
# hello (sequence 1), and wait — bounded — for accept. Only after accept may
# the shell suppress its prompt or emit lifecycle events (decision 3). Any
# failure leaves a conventional terminal with a visible native prompt.
__nocx_lc_init() {
    local __cfg_ok=0
    __nocx_lc_active=0
    if [[ -n "$__nocx_cap" ]] && [[ "$__nocx_cap" =~ ^[0-9a-f]{64}$ ]] \
        && [[ -n "$__nocx_lc_lane" ]] && [[ -n "$__nocx_lc_dom" ]] \
        && [[ "$__nocx_lc_epoch" =~ ^[0-9]+$ ]] \
        && [[ -n "$__nocx_lc_fd" || -n "$__nocx_lc_port" ]]; then
        __cfg_ok=1
    fi
    if [[ "$__cfg_ok" != "1" ]]; then
        return 1
    fi
    if [[ -n "$__nocx_lc_port" ]]; then
        # Remote / in-band transport: zsh's ztcp. The bind address is the
        # literal 127.0.0.1, never localhost (ADR-0024). A FIXED high
        # descriptor, like the bash tier: zsh's ztcp allocates into REPLY
        # and would collide with the inherited-fd path otherwise.
        if ! zmodload zsh/net/tcp 2>/dev/null; then
            return 1
        fi
        if ! ztcp 127.0.0.1 "$__nocx_lc_port" 2>/dev/null; then
            return 1
        fi
        __nocx_lc_fd=$REPLY
    fi
    __nocx_lc_json_escape "$__nocx_lc_lane"
    __nocx_lc_lane_esc=$__nocx_lc_json_escaped
    __nocx_lc_json_escape "$__nocx_lc_dom"
    __nocx_lc_dom_esc=$__nocx_lc_json_escaped
    __nocx_lc_send hello ',"shell":"zsh","max_frame":65536'
    if ! __nocx_lc_read_frame; then
        return 1
    fi
    # Two independent substring checks, not one ordered pattern: the
    # envelope's field order is the adapter's, and a case pattern like
    # *evt*cap* would silently reject a valid accept whose cap field
    # precedes evt.
    case "$__nocx_lc_frame" in
        *'"evt":"accept"'*) : ;;
        *) return 1 ;;
    esac
    case "$__nocx_lc_frame" in
        *'"cap":"'"$__nocx_cap"'"'*) : ;;
        *) return 1 ;;
    esac
    __nocx_lc_active=1
    return 0
}
__nocx_lc_init

autoload -Uz add-zsh-hook

__nocx_exit_code=0
__nocx_first_prompt=

__nocx_encode_url() {
    local s="$1"
    s="${s// /%20}"
    s="${s//$'\t'/%09}"
    s="${s//$'\n'/%0a}"
    builtin printf '%s' "$s"
}

# Capture the just-finished command's exit status. This must run before any
# other precmd hook can clobber $?, so it is forced to the front of
# precmd_functions below; it re-returns the status so later hooks still see it.
__nocx_capture_status() {
    __nocx_exit_code=$?
    return $__nocx_exit_code
}

# Emit one OSC 133 lifecycle marker — \e]133;A, \e]133;B, \e]133;C or
# \e]133;D[;<exit>] — tagged with the environment id (nocx_env=<id>) when
# this shell is an identified environment and bare otherwise. Untagged
# markers drive block boundaries exactly as before; the tag is what lets the
# renderer attribute a marker to an environment (spec §5.2).
__nocx_marker() {
    local __kind="$1" __code="${2:-}"
    if [[ "${__nocx_tagged:-0}" == "1" ]]; then
        if [[ -n "$__code" ]]; then
            builtin printf '\e]133;%s;%s;nocx_env=%s\a' "$__kind" "$__code" "$__nocx_env_id"
        else
            builtin printf '\e]133;%s;nocx_env=%s\a' "$__kind" "$__nocx_env_id"
        fi
    elif [[ -n "$__code" ]]; then
        builtin printf '\e]133;%s;%s\a' "$__kind" "$__code"
    else
        builtin printf '\e]133;%s\a' "$__kind"
    fi
}

__nocx_precmd() {
    # Authenticated channel first: complete (with the exit status and a
    # fresh fence nonce), write the SAME nonce to the pty after the command's
    # output (the render-order rendezvous, decision 1 carve-out), then
    # prompt_ready. The complete carries no attempt id; the kernel resolves
    # the domain's single open attempt.
    if [[ "${__nocx_lc_active:-0}" == "1" ]]; then
        if [[ "${__nocx_lc_attempt_open:-0}" == "1" ]]; then
            if __nocx_lc_fence; then
                __nocx_lc_send complete ',"exit_code":'"$__nocx_exit_code"',"fence":"'"$__nocx_lc_fence_hex"'"'
                builtin printf '\e]1337;NOCX_FENCE;%s\a' "$__nocx_lc_fence_hex"
            fi
            __nocx_lc_attempt_open=0
        fi
        __nocx_lc_send prompt_ready
    fi
    if [[ -n "$__nocx_first_prompt" ]]; then
        __nocx_marker D "$__nocx_exit_code"
    fi
    __nocx_marker A
    builtin printf '\e]7;file://%s%s\a' \
        "$(__nocx_encode_url "${HOST%%.*}")" \
        "$(__nocx_encode_url "$PWD")"
    __nocx_first_prompt=1
}

__nocx_preexec() {
    # zsh's preexec hook receives the full command line as $1.
    __nocx_marker C
    if [[ "${__nocx_lc_active:-0}" == "1" ]]; then
        # Shell-originated start, WITHOUT an attempt id: the kernel attaches
        # to a pending app attempt or mints a shell-originated one, and
        # resolves the completion by context (protocol doc §7-§8). The
        # command text is truncated to the kernel's command budget (4096
        # bytes); a longer line loses its tail, never its frame.
        local __cmd="${1:-}" LC_ALL=C
        __cmd="${__cmd:0:4000}"
        __nocx_lc_json_escape "$__cmd"
        __nocx_lc_send start ',"command":"'"$__nocx_lc_json_escaped"'"'
        __nocx_lc_attempt_open=1
    fi
}

add-zsh-hook precmd __nocx_capture_status
add-zsh-hook precmd __nocx_precmd
add-zsh-hook preexec __nocx_preexec

# Force the status capture to the front of precmd_functions so a precmd hook the
# user registered earlier (oh-my-zsh, plugins, sourced before our gate) cannot
# clobber $? before we read it. Dedupe first so re-sourcing stays idempotent.
precmd_functions=(__nocx_capture_status ${precmd_functions:#__nocx_capture_status})

# Non-printing B marker (zsh %{...%} so it takes zero prompt width).
__nocx_b_marker=$'%{\e]133;B\a%}'
if [[ "${__nocx_tagged:-0}" == "1" ]]; then
    # The id is [A-Za-z0-9._-]{1,64} — no '%' or '}' can reach PROMPT, so
    # the %{...%} non-printing wrapper cannot be forged by the value.
    __nocx_b_marker=$'%{\e]133;B;nocx_env='"$__nocx_env_id"$'%}'
fi


if [[ "${NOCX_PROMPT_MODE:-}" == "marker-only" ]]; then
    # Nested-session gate (nocx-4ff.13): a shell that inherits a
    # NOCX_SESSION_ID it did not create (__nocx_owned_session already
    # exported by a parent) keeps a visible prompt.
    if [[ -n "${__nocx_owned_session:-}" ]]; then
        # Nested shell — do NOT arm the marker-only overlay.
        :
    else
        __nocx_owned_session="${NOCX_SESSION_ID:-}"
        export __nocx_owned_session
        # Enhanced mode: reassert a marker-only prompt AFTER frameworks run, every
        # prompt. Kept last in precmd_functions so a framework precmd that rewrote
        # PS1 cannot win. Do NOT touch PS2/PS3 (continuation/secondary stay native).
        __nocx_marker_only_prompt() {
            # Suppress the prompt only when the authenticated channel is
            # live: a suppressed prompt without a live domain is the phishing
            # primitive decision 9 forbids. Not live, the framework's prompt
            # stands visible, with the render-only B partition marker
            # appended exactly as baseline mode wraps it (the marker
            # suppresses nothing by itself).
            if [[ "${__nocx_lc_active:-0}" == "1" ]]; then
                PROMPT="$__nocx_b_marker"
                RPROMPT=''
                RPS1=''
            else
                # PROMPT and PS1 are the SAME parameter in zsh — assigning
                # both would append the marker twice.
                PROMPT="${PROMPT}$__nocx_b_marker"
            fi
        }
        add-zsh-hook precmd __nocx_marker_only_prompt
        # Force it last, deduped, on every source.
        precmd_functions=(${precmd_functions:#__nocx_marker_only_prompt} __nocx_marker_only_prompt)
    fi
elif [[ -z "${__nocx_prompt_wrapped:-}" ]]; then
    if [[ "${__nocx_tagged:-0}" == "1" ]]; then
        PS1="${PS1:-}"$'%{\e]133;B;nocx_env='"$__nocx_env_id"$'%}'
    else
        PS1="${PS1:-}"$'%{\e]133;B\a%}'
    fi
    __nocx_prompt_wrapped=1
fi

# Readiness passport — OSC 636 ; P ; <protocolVersion> ; <environmentId> ;
# <parentEnvironmentId> ; <scriptVersion> ; <tier> ; <generation> ST (spec
# §5.2). Announced ONCE, at source time, before the first prompt. The
# environment id, parent and generation travel in env vars set by the
# launcher; protocol version, script version and tier are static here. Every
# field is [A-Za-z0-9._-]{1,64}; when any env-provided field is absent or
# malformed NO passport is emitted — a passport the renderer would reject
# must not be sent (fail-open). The renderer accepts a passport only when
# its id matches the one minted for the attempt in flight; a duplicate or
# unexpected id changes nothing.
__nocx_protocol_version='1'
__nocx_script_version='11'
__nocx_tier='enhanced'
__nocx_passport_ok=0
if [[ "${__nocx_tagged:-0}" == "1" ]] \
    && [[ "$__nocx_parent_env_id" =~ ^[A-Za-z0-9._-]{1,64}$ ]] \
    && [[ "$__nocx_generation" =~ ^[A-Za-z0-9._-]{1,64}$ ]]; then
    __nocx_passport_ok=1
fi
__nocx_passport_emit() {
    if [[ "${__nocx_passport_ok:-0}" != "1" ]]; then
        return
    fi
    builtin printf '\e]636;P;%s;%s;%s;%s;%s;%s\a' \
        "$__nocx_protocol_version" "$__nocx_env_id" "$__nocx_parent_env_id" \
        "$__nocx_script_version" "$__nocx_tier" "$__nocx_generation"
}
__nocx_passport_emit

# Native-mode escape (nocx-4ff.9): drop the marker-only overlay and restore a
# visible prompt on the next precmd. Called by nocx when the user hits escape.
__nocx_native_mode() {
    add-zsh-hook -d precmd __nocx_marker_only_prompt 2>/dev/null
    unset NOCX_PROMPT_MODE
    PROMPT='%~ %# '
    PS1='%~ %# '
}
