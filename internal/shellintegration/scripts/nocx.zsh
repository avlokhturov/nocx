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
    __nocx_marker C
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
            PROMPT="$__nocx_b_marker"
            PS1="$__nocx_b_marker"
            RPROMPT=''
            RPS1=''
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
