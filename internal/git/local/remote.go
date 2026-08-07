package local

import (
	"context"
	"fmt"
	"strings"

	"github.com/shady2k/nocx/internal/git"
	"github.com/shady2k/nocx/internal/git/spawn"
)

// remoteURLMax is the bound for the three tiny reads RemoteURL makes. A
// remote URL is a config value; anything near this bound is not a URL the
// panel should send a user to.
const remoteURLMax = 8 << 10

// RemoteURL is the URL of the remote the current branch tracks (brief,
// nocx-hc0m), in three bounded reads, each argv and never a shell:
//
//  1. git symbolic-ref --short HEAD — the branch, from HEAD, not from a
//     client-supplied name. A non-zero exit is data: detached HEAD has no
//     branch, hence no upstream, hence nothing to open.
//  2. git for-each-ref --format=%(upstream:remotename) refs/heads/<branch>
//     — the remote the branch tracks, by git's own atom: a remote whose
//     name contains a slash is not mis-split here. Empty output (no
//     upstream) and "." (a local upstream) are both "nothing to open".
//  3. git remote get-url <remote> — the URL. A non-zero exit is data too:
//     the tracked remote was deleted.
//
// Every one of the three "no answer" cases is ErrNoRemote, the result state
// "none" on the wire — the panel draws no link (design D14) and never sees
// a transport error. Only an invocation that could not be made or completed
// is an error.
func (r *Repo) RemoteURL(ctx context.Context) (string, error) {
	branch, err := r.symbolicBranch(ctx)
	if err != nil {
		return "", err
	}
	if branch == "" {
		return "", &git.ErrNoRemote{}
	}
	remote, err := r.upstreamRemote(ctx, branch)
	if err != nil {
		return "", err
	}
	if remote == "" || remote == "." {
		return "", &git.ErrNoRemote{}
	}
	url, err := r.remoteURL(ctx, remote)
	if err != nil {
		return "", err
	}
	if url == "" {
		return "", &git.ErrNoRemote{}
	}
	return url, nil
}

// symbolicBranch names the current branch; "" and nil on a detached HEAD.
func (r *Repo) symbolicBranch(ctx context.Context) (string, error) {
	sink := &byteSink{max: remoteURLMax}
	res := run(ctx, spec{
		argv: append([]string{r.gitPath}, spawn.SymbolicRefArgs()...),
		dir:  r.toplevel,
		env:  r.envSettled(),
		sink: sink,
	})
	if res.cancelled {
		return "", ctx.Err()
	}
	if res.err != nil {
		return "", res.err
	}
	if res.exitCode != 0 {
		// Detached HEAD: git symbolic-ref refuses to name a branch. There
		// is no upstream to open — the ordinary none, never an error.
		return "", nil
	}
	return strings.TrimSpace(string(sink.buf)), nil
}

// upstreamRemote names the remote the branch tracks, via git's own
// %(upstream:remotename) atom. Unlike the other two reads, for-each-ref
// carries NO data in its exit code: "no upstream" and "branch gone" both
// print an empty line and exit 0, so a non-zero exit here is an invocation
// problem (a corrupt repository, a bad option), never a no-remote answer.
func (r *Repo) upstreamRemote(ctx context.Context, branch string) (string, error) {
	sink := &byteSink{max: remoteURLMax}
	res := run(ctx, spec{
		argv: append([]string{r.gitPath}, spawn.UpstreamRemoteArgs(branch)...),
		dir:  r.toplevel,
		env:  r.envSettled(),
		sink: sink,
	})
	if res.cancelled {
		return "", ctx.Err()
	}
	if res.err != nil {
		return "", res.err
	}
	if res.exitCode != 0 {
		return "", fmt.Errorf("git for-each-ref: exit %d: %s", res.exitCode, res.stderr)
	}
	// Empty output (no upstream) and "." (a local upstream) are both
	// "nothing to open"; the caller maps them.
	return strings.TrimSpace(string(sink.buf)), nil
}

// remoteURL reads one remote's fetch URL.
func (r *Repo) remoteURL(ctx context.Context, remote string) (string, error) {
	sink := &byteSink{max: remoteURLMax}
	res := run(ctx, spec{
		argv: append([]string{r.gitPath}, spawn.RemoteUrlArgs(remote)...),
		dir:  r.toplevel,
		env:  r.envSettled(),
		sink: sink,
	})
	if res.cancelled {
		return "", ctx.Err()
	}
	if res.err != nil {
		return "", res.err
	}
	if res.exitCode != 0 {
		// The tracked remote no longer exists (git remote get-url answers
		// 128 with "No such remote"). Nothing to open.
		return "", nil
	}
	return strings.TrimSpace(string(sink.buf)), nil
}

// compile-time proof the local Repo satisfies the seam.
var _ git.Repo = (*Repo)(nil)
