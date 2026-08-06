package local

import (
	"context"
	"errors"
	"time"

	"github.com/shady2k/nocx/internal/git"
)

// Factory is the local implementation of git.RepoFactory: probe capability,
// resolve the environment, run rev-parse, and build a Repo on the answer —
// all before a Repo exists, all inside the factory so the composition layer
// never has to run git of its own (spec §5.1).
type Factory struct {
	env      *envCache
	probe    *capability
	ceilings ceilings
	fixedEnv []string // pinned environment (WithEnv); nil resolves from the shell
}

// Option configures a Factory. Zero values select the package defaults.
type Option func(*options)

type options struct {
	shell         string
	envTimeout    time.Duration
	envMaxOutput  int64
	fixedEnv      []string
	statusBytes   int64
	statusWall    time.Duration
	statusEntries int
}

// NewFactory builds a local factory. The environment and the git probe are
// resolved lazily, on the first Open, and cached from then on.
func NewFactory(opts ...Option) *Factory {
	var o options
	for _, opt := range opts {
		opt(&o)
	}
	c := ceilings{
		statusBytes:   git.MaxStatusBytes,
		statusWall:    git.MaxStatusWallClock,
		statusEntries: git.MaxStatusEntries,
	}
	if o.statusBytes > 0 {
		c.statusBytes = o.statusBytes
	}
	if o.statusWall > 0 {
		c.statusWall = o.statusWall
	}
	if o.statusEntries > 0 {
		c.statusEntries = o.statusEntries
	}
	return &Factory{
		env:      newEnvCache(o.shell, o.envTimeout, o.envMaxOutput),
		probe:    &capability{},
		ceilings: c,
		fixedEnv: o.fixedEnv,
	}
}

// Open resolves the repository cwd stands in. Every outcome other than ok is
// a state in the result, not an error — with two exceptions: an empty cwd
// (which the factory refuses rather than letting rev-parse run in the
// backend's own directory) and a cancelled context both surface as errors.
// The ownership-transfer rules (§5.1) are enforced by the caller: a Repo is
// returned only with an ok outcome, and the caller must register it or close
// it — there is no third option.
func (f *Factory) Open(ctx context.Context, cwd string) (git.Repo, git.OpenOutcome, error) {
	if cwd == "" {
		return nil, git.OpenOutcome{State: git.OpenNoCwd}, nil
	}
	env, envState, envReason := f.fixedEnv, git.EnvResolved, ""
	if f.fixedEnv == nil {
		env, envState, envReason = f.env.resolve(ctx)
	}
	if ctx.Err() != nil {
		return nil, git.OpenOutcome{}, ctx.Err()
	}

	gitPath, version, err := f.probe.probe(ctx, env)
	outcome := git.OpenOutcome{EnvState: envState, EnvReason: envReason, GitVersion: version}
	switch {
	case err != nil:
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return nil, git.OpenOutcome{}, err
		}
		outcome.State = git.OpenGitUnavailable
		return nil, outcome, nil
	case belowFloor(version):
		outcome.State = git.OpenGitTooOld
		return nil, outcome, nil
	}

	toplevel, gitDir, err := revParse(ctx, gitPath, env, cwd)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return nil, git.OpenOutcome{}, err
		}
		outcome.State = git.OpenNotARepository
		return nil, outcome, nil
	}

	outcome.State = git.OpenOK
	outcome.Toplevel = toplevel
	outcome.GitDir = gitDir
	repo := &Repo{
		gitPath:  gitPath,
		env:      env,
		toplevel: toplevel,
		gitDir:   gitDir,
		ceilings: f.ceilings,
	}
	return repo, outcome, nil
}
