#!/bin/sh
# Install a GNU bash 3.2 as `bash32` — the bash macOS ships as /bin/bash.
#
# Why this exists: this is a macOS-first product, Apple froze /bin/bash at
# 3.2.57 (the last GPLv2 release, 2007), and the shell integration script must
# PARSE there. A bash-4-only construct is a syntax error 3.2 raises while
# reading the file, before any version guard inside it can run — which is how
# every bash shell on macOS came up with no integration at all while the whole
# Linux side of CI stayed green (nocx-cn86).
#
# TestBashScript_ParsesUnderBash32 needs a 3.2 to check against. macOS has one
# at /bin/bash and needs nothing from this script. Linux has none: Debian and
# Ubuntu package nothing older than 4, and bash-3.2.57 does not build on a
# modern toolchain without patching. The binary therefore comes from the
# official `bash:3.2` image, which is Alpine — so it is musl-linked, and the
# loader and libncursesw come with it into a private prefix rather than into
# /lib, where a musl libncursesw.so.6 would sit beside the system's glibc copy
# of the same soname. Nothing links against it; it is only ever exec'd.
#
# The pre-commit test image does the same thing in its own Dockerfile layers
# (.githooks/images/go-tests/Dockerfile) rather than calling this script,
# because a container build cannot reach the repo working tree — that is one
# duplication, deliberate, and both are checked by the same test.
#
# Usage: scripts/install-bash32.sh [prefix]   (default prefix: /usr/local)
set -eu

PREFIX="${1:-/usr/local}"
LIBDIR="$PREFIX/lib/bash32"

if ! command -v docker >/dev/null 2>&1; then
    printf 'install-bash32: docker is required to extract bash 3.2 from the bash:3.2 image\n' >&2
    exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# `tar -ch`, not `docker cp`: libncursesw.so.6 is a SYMLINK in that image, and
# docker cp copies the link rather than what it points at, so the extracted
# name lands dangling and the next `cp` dies on "cannot stat" — which is
# exactly how this step failed on the runner while the Dockerfile's own
# COPY --from resolved it. -h dereferences.
docker run --rm --entrypoint tar bash:3.2 \
    -ch -C / -f - \
    usr/local/bin/bash lib/ld-musl-x86_64.so.1 usr/lib/libncursesw.so.6 \
    | tar -x -C "$TMP"

mkdir -p "$LIBDIR" "$PREFIX/bin"
cp "$TMP/usr/local/bin/bash" "$LIBDIR/bash"
cp "$TMP/lib/ld-musl-x86_64.so.1" "$LIBDIR/"
cp "$TMP/usr/lib/libncursesw.so.6" "$LIBDIR/"
chmod +x "$LIBDIR/bash"

cat > "$PREFIX/bin/bash32" <<EOF
#!/bin/sh
exec $LIBDIR/ld-musl-x86_64.so.1 --library-path $LIBDIR $LIBDIR/bash "\$@"
EOF
chmod +x "$PREFIX/bin/bash32"

"$PREFIX/bin/bash32" --version | head -1
"$PREFIX/bin/bash32" --version | grep -q 'version 3\.2'
