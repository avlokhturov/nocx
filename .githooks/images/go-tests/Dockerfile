# Image the pre-commit hook runs `go test -race ./...` in (go_test_containerized).
#
# The stock golang:1.26-bookworm carries bash and dash (Debian's /bin/sh is
# dash, and dash is an Essential package, so /usr/bin/dash is always present)
# but NOT zsh. The shellintegration launcher tests fail, not skip, when the
# shell they must prove is absent (nocx-gd84) — so a hook that ran the stock
# image would fail the three TestZshLauncher_* tests on every commit.
#
# zsh is installed HERE, in the image, instead of via an apt-get in the run
# command, for a measured reason: an `apt-get update && apt-get install zsh`
# in a fresh golang:1.26-bookworm container costs ~28s (measured 2026-08-04)
# and needs Debian-mirror network on every commit, which would break the
# hook's warm-run-offline property (the image and caches are what make a
# repeat commit run with no network). Building the image instead confines the
# apt cost to first use and to base-image updates. The hook builds this image
# (with the BuildKit layer cache) before every run, so this Dockerfile is the
# source of truth: a package added here takes effect on the next commit
# without anyone remembering to rebuild or re-tag anything.
#
# dash is named explicitly even though Debian's Essential set guarantees it:
# the shell tests' contract is "dash and zsh are present", and pinning both
# here keeps that contract in one visible place instead of inheriting dash by
# accident of the base image's Essential set.
#
# openssh-server: the live-sshd suite (nocx-u7uh.17) proves the remote
# lifecycle channel against a REAL OpenSSH server spawned by the test. The
# stock image carries bash/dash/ssh/ssh-keygen but not sshd; the same
# fail-not-skip rule that put zsh here requires the fixture to be provable
# inside the container the hook runs.
FROM golang:1.26-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends dash zsh openssh-server \
 && rm -rf /var/lib/apt/lists/*
