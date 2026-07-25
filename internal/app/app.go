package app

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"

	"github.com/shady2k/nocx/internal/config"
	"github.com/shady2k/nocx/internal/credential"
	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/profile"
	"github.com/shady2k/nocx/internal/pty"
	"github.com/shady2k/nocx/internal/session"
	"github.com/shady2k/nocx/internal/shellintegration"
	"github.com/shady2k/nocx/internal/ssh"
	"github.com/shady2k/nocx/internal/transport"
	"github.com/shady2k/nocx/internal/update"
)

type App struct {
	Logger           log.Logger
	Pty              session.PTYFactory
	Session          *session.Reg
	Transport        *transport.WSServer
	Config           *config.Stub
	ShellIntegration shellintegration.ShellIntegration
	Updater          update.Updater
	Profiles         profile.ProfileStore
	Credentials      credential.CredentialStore
}

// Log logs a message from the frontend.
func (a *App) Log(message string) {
	a.Logger.Info("frontend: " + message)
}

func New() (*App, error) {
	slogger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	logger := log.NewSlogAdapter(slogger)

	cfg := config.NewStub(logger)
	shint := shellintegration.New(logger)
	ptf := &localPTYFactory{log: logger, shint: shint}
	sess := session.New(logger, ptf)

	// SSH client (AD-4): real client on x/crypto/ssh, honors ~/.ssh/config.
	sshClient, err := ssh.NewReal(logger)
	if err != nil {
		return nil, fmt.Errorf("ssh client: %w", err)
	}
	sess = sess.WithSSHFactory(&sshFactoryAdapter{client: sshClient})

	// Profile + credential stores (AD-4 seam): separate wired deps, not
	// through config.Stub. Profile store persists to the OS config dir;
	// credential store uses the OS keychain (vault is a Phase-2 upgrade).
	configDir, err := os.UserConfigDir()
	if err != nil {
		logger.Warn("could not determine config dir, using in-memory profile store", "error", err)
	}
	var profileStore profile.ProfileStore
	if configDir != "" {
		profileStore = profile.NewJSONStore(filepath.Join(configDir, "nocx", "profiles.json"))
	} else {
		profileStore = profile.NewJSONStore(filepath.Join(os.TempDir(), "nocx-profiles.json"))
	}
	credStore := credential.NewKeychain()

	tp := transport.NewWSServer(
		logger, sess,
		transport.WithProfileStore(profileStore),
		transport.WithCredentialStore(credStore),
	)

	app := &App{
		Logger:           logger,
		Pty:              ptf,
		Session:          sess,
		Transport:        tp,
		Config:           cfg,
		ShellIntegration: shint,
		Profiles:         profileStore,
		Credentials:      credStore,
	}

	logger.Info("application initialized")
	return app, nil
}

type localPTYFactory struct {
	log   log.Logger
	shint shellintegration.ShellIntegration
}

func (f *localPTYFactory) NewPTY(_ context.Context, cfg pty.Config) (pty.Pty, error) {
	env := f.shint.ActivationEnv(cfg.Enhanced)
	return pty.NewLocal(f.log, cfg, pty.WithExtraEnv(env))
}

func (a *App) Start(ctx context.Context) error {
	a.Logger.Info("starting application services")

	home, err := os.UserHomeDir()
	if err != nil {
		a.Logger.Warn("shellintegration: could not determine home dir", "error", err)
	} else if err := a.ShellIntegration.EnsureInstalled(home); err != nil {
		a.Logger.Warn("shellintegration: install failed", "error", err)
	}

	return a.Transport.Start(ctx)
}

func (a *App) Shutdown(ctx context.Context) {
	a.Logger.Info("shutting down application")
	if err := a.Transport.Stop(ctx); err != nil {
		a.Logger.Error("transport shutdown error", "error", err)
	}
	a.Logger.Info("application stopped")
}

func (a *App) WSPort() int {
	return a.Transport.Port()
}

// sshFactoryAdapter adapts ssh.SSH to session.SSHFactory.
type sshFactoryAdapter struct {
	client ssh.SSH
}

func (a *sshFactoryAdapter) Connect(ctx context.Context, host string, opts ...ssh.ConnectOption) (ssh.Channel, error) {
	return a.client.Connect(ctx, host, opts...)
}
