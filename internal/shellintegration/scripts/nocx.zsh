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
__nocx_lc_attempt_n=0
__nocx_lc_attempt_id=''
__nocx_lc_last_completed_id=''
__nocx_lc_last_completed_code=''
__nocx_lc_desynced=0
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
    # $1, when given, is the per-read timeout in seconds (the refresh poll
    # bounds the prompt); it defaults to the handshake timeout.
    local __t="${1:-$__nocx_lc_timeout_s}" __hdr __hex __len LC_ALL=C
    if ! read -t "$__t" -k 4 -u "$__nocx_lc_fd" __hdr 2>/dev/null; then
        return 1
    fi
    __hex=$(printf %s "$__hdr" | od -An -tx1 | tr -d ' \n')
    [[ "$__hex" =~ ^[0-9a-f]{8}$ ]] || return 1
    __len=$(( 16#$__hex ))
    (( __len > 0 && __len <= 65536 )) || return 1
    if ! read -t "$__t" -k "$__len" -u "$__nocx_lc_fd" __nocx_lc_frame 2>/dev/null; then
        return 1
    fi
    return 0
}

# Answer a pending refresh_request with an authenticated snapshot (protocol
# doc §10, ADR-0024 decision 7) — the zsh twin of the bash tier's
# __nocx_lc_ans_refresh. The kernel demands this when a framing gap
# desynchronized the domain; ONLY a snapshot answering the request restores
# authority, so this runs at every prompt and must not lose the request.
#
# The poll is prompt-boundary. It is non-blocking in the common case: zsh's
# `read` cannot probe without consuming a byte (unlike bash's `read -N 0`),
# so the readiness check is zselect -r, which consumes nothing. When
# zsh/zselect is unavailable the poll degrades to the bounded frame read
# below — a stall guard, not a working budget.
#
# The shell names its own attempts: it mints an id per command at start —
# the app mints its own and no outbound envelope carries one back (protocol
# §8) — and the kernel learns the shell's id at attach, resolving it as a
# per-attempt alias. The snapshot reports last_completed — the attempt the
# shell just finished, with the REAL exit status — whenever one exists, so a
# completion the gap swallowed still reconciles to its real status instead
# of to unknown. active_attempt is never reported: the shell answers only
# from a prompt, where nothing is running. shell_state is at_prompt because
# this runs from a prompt; next_seq is the shell's next sequence, strictly
# greater than the snapshot's own (the kernel rejects `next_seq <= seq`).
#
# On success marks the domain desynced: the prompt-boundary arm restores a
# visible prompt (decision 9) — a suppressed marker-only prompt over a
# Desynchronized domain would be invisible raw input.
__nocx_lc_ans_refresh() {
    local __rid
    if zmodload zsh/zselect 2>/dev/null; then
        zselect -t 0 -r "$__nocx_lc_fd" 2>/dev/null || return 1
    fi
    # A frame is buffered (the kernel writes each envelope in one write);
    # the short bound is a stall guard, not a working budget.
    __nocx_lc_read_frame 1 || return 1
    case "$__nocx_lc_frame" in
        *'"evt":"refresh_request"'*) : ;;
        *) return 1 ;; # not a refresh; leave it buffered for the next prompt
    esac
    __rid="${__nocx_lc_frame#*\"request\":\"}"
    __rid="${__rid%%\"*}"
    # Kernel-minted shape: req-<16 hex>. Anything else is not a request we
    # can answer — quoting it into the JSON would forge one.
    [[ "$__rid" =~ ^req-[0-9a-f]{16}$ ]] || return 1
    # The snapshot's own seq is seq+1 after this call; next_seq must be
    # strictly greater than it, and is the sequence the NEXT envelope will
    # carry — so it is seq+2 in pre-send terms.
    #
    # last_completed is the shell's own view (its id + the real exit
    # status), recorded by __nocx_precmd before the refresh can preempt the
    # complete. When no command just finished — the shell genuinely has
    # nothing to report — the field is omitted and the kernel reconciles
    # open attempts as unknown, never success.
    if [[ -n "${__nocx_lc_last_completed_id:-}" ]]; then
        __nocx_lc_send snapshot ',"request":"'"$__rid"'","shell_state":"at_prompt","last_completed":{"attempt":"'"$__nocx_lc_last_completed_id"'","exit_code":'"$__nocx_lc_last_completed_code"'},"next_seq":'"$(( __nocx_lc_seq + 2 ))"
    else
        __nocx_lc_send snapshot ',"request":"'"$__rid"'","shell_state":"at_prompt","next_seq":'"$(( __nocx_lc_seq + 2 ))"
    fi
    __nocx_lc_desynced=1
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
# \e]133;D[;<exit>]. A/B partition prompt bytes from output bytes for
# rendering; C/D are the standard's command-boundary markers, kept for
# third-party interop (ADR-0024 decision 1 leaves the decision open: nocx
# no longer consumes them, but any other tool reading the stream still can,
# and they carry no authority here).
__nocx_marker() {
    local __kind="$1" __code="${2:-}"
    if [[ -n "$__code" ]]; then
        builtin printf '\e]133;%s;%s\a' "$__kind" "$__code"
    else
        builtin printf '\e]133;%s\a' "$__kind"
    fi
}

# The lifecycle channel died mid-session: a send failed at a prompt
# boundary. Clear the active latch — the domain is lost and nothing more may
# be emitted over the dead transport — and mark the session recovered so the
# marker-only prompt hook restores a visible native prompt with the one-shot
# recovery fence (ADR-0024 decision 8). nocx matches that fence and
# acknowledges the restoration; until it lands, the session is neither an
# authenticated terminal nor a usable conventional one.
__nocx_lc_recover() {
    __nocx_lc_active=0
    __nocx_lc_recovered=1
}

__nocx_precmd() {
    # Authenticated channel first: refresh, complete (with the exit status
    # and a fresh fence nonce), write the SAME nonce to the pty after the
    # command's output (the render-order rendezvous, decision 1 carve-out),
    # then prompt_ready. The complete carries no attempt id; the kernel
    # resolves the domain's single open attempt.
    if [[ "${__nocx_lc_active:-0}" == "1" ]]; then
        # Record the just-finished command's completion BEFORE the refresh
        # can preempt the complete: the snapshot reports what the shell
        # actually knows — its own attempt id and the real exit status — so
        # a completion the gap swallowed reconciles to its real status
        # rather than to unknown.
        if [[ "${__nocx_lc_attempt_open:-0}" == "1" ]]; then
            __nocx_lc_last_completed_id="$__nocx_lc_attempt_id"
            __nocx_lc_last_completed_code="$__nocx_exit_code"
        fi
        # A framing gap may have desynchronized the domain while the shell
        # was busy; the kernel's refresh_request is buffered. Answer it
        # FIRST — only a snapshot answering it restores authority (decision
        # 7), and while the domain is desynchronized the complete and
        # prompt_ready below would be quarantined anyway.
        if __nocx_lc_ans_refresh; then
            __nocx_lc_attempt_open=0
        elif [[ "${__nocx_lc_attempt_open:-0}" == "1" ]]; then
            if __nocx_lc_fence; then
                if __nocx_lc_send complete ',"exit_code":'"$__nocx_exit_code"',"fence":"'"$__nocx_lc_fence_hex"'"'; then
                    builtin printf '\e]1337;NOCX_FENCE;%s\a' "$__nocx_lc_fence_hex"
                else
                    __nocx_lc_recover
                fi
            fi
            __nocx_lc_attempt_open=0
        fi
        # A failed send means the transport is dead — the domain is lost,
        # the visible native prompt must be restored (decision 8), and no
        # further send is attempted this boundary (recover cleared active).
        if [[ "${__nocx_lc_active:-0}" == "1" ]]; then
            __nocx_lc_send prompt_ready || __nocx_lc_recover
        fi
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
        # Shell-originated start, named with the shell's own attempt id: the
        # shell mints one per command because it never learns the app-minted
        # id (protocol §8 — no outbound envelope carries one back), and its
        # id is the only name it can report in a snapshot. The kernel
        # attaches to a pending app attempt (recording the id as a
        # per-attempt alias) or creates a shell-originated attempt under
        # this id. The id carries the domain (s-<dom>-<counter>): PID spaces
        # are not shared across domains, so s-$$-<n> collides whenever a
        # docker exec / ssh shell shares a low PID with another domain's
        # shell, and the kernel's global id table would reject the second
        # domain's first command. The domain is the disambiguator; the
        # per-shell counter keeps ids unique within it. The command text is
        # truncated to the kernel's command budget (4096 bytes); a longer
        # line loses its tail, never its frame.
        local __cmd="${1:-}" LC_ALL=C
        __cmd="${__cmd:0:4000}"
        __nocx_lc_json_escape "$__cmd"
        __nocx_lc_attempt_id="s-$__nocx_lc_dom-$(( __nocx_lc_attempt_n++ ))"
        __nocx_lc_send start ',"attempt":"'"$__nocx_lc_attempt_id"'","command":"'"$__nocx_lc_json_escaped"'"'
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
            elif [[ "${__nocx_lc_recovered:-0}" == 1 ]]; then
                # The channel died mid-session (a send failed): a visible
                # native prompt stands, never a suppressed one taking raw
                # input (decision 8). The one-shot recovery fence rides
                # exactly the FIRST prompt's bytes — nocx matches it and
                # acknowledges the restoration; afterwards PROMPT is rebuilt
                # without it, so the nonce reaches the terminal once and is
                # never reused.
                __nocx_native_mode
                if [[ "${__nocx_lc_recovery_emitted:-0}" != 1 ]] && [[ -n "${__nocx_lc_recovery:-}" ]]; then
                    PROMPT="${PROMPT}"$'%{\e]1337;NOCX_RECOVERY;'"$__nocx_lc_recovery"$'\a%}'
                    __nocx_lc_recovery_emitted=1
                fi
                PROMPT="${PROMPT}$__nocx_b_marker"
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
    PS1="${PS1:-}"$'%{\e]133;B\a%}' 
    __nocx_prompt_wrapped=1
fi

# Restore a visible native prompt. Real caller: the marker-only prompt
# hook's recovered branch (ADR-0024 decision 8) — after the lifecycle channel
# dies mid-session, the user must never be left at a suppressed prompt taking
# raw input, which is the worst of both. The older nocx-4ff.9 "user hits
# escape" attribution had no caller and is deleted: the escape surface it
# described no longer exists.
__nocx_native_mode() {
    add-zsh-hook -d precmd __nocx_marker_only_prompt 2>/dev/null
    unset NOCX_PROMPT_MODE
    PROMPT='%~ %# '
    PS1='%~ %# '
}
