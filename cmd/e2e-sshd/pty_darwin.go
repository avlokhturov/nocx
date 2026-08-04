//go:build darwin

package main

import "syscall"

// ptySetctty returns the SysProcAttr that makes the child's PTY its
// controlling terminal — required for a real interactive shell.
func ptySetctty() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0}
}
