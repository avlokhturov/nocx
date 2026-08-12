# Shell integration: what it is, and what a tab means when it says it is missing

This is the page the "Not integrated" card links to. It is written for
somebody using nocx, not for somebody working on it.

## Two kinds of tab

**An integrated tab** knows where each command started and ended, so nocx can
draw command blocks, record what you ran, and offer the command editor.

**A conventional tab** is an ordinary terminal with your shell's own prompt.
Everything still runs. What is missing is the structure around it: no command
blocks, no command editor, and nothing recorded in your history.

Both are fine, and plenty of tabs are conventional on purpose. A tab you
opened in raw mode, or a connection that runs a configured command instead of
a shell, is conventional by design and nocx says nothing about it.

The card appears only when nocx **tried** to integrate a session and did not
manage it. That is the case worth telling you about, because it usually means
something on the machine can be changed.

## What each reason means

**Not integrated — your shell did not answer nocx in time.**
nocx started your shell and opened a private channel for it to report on.
The shell never answered on that channel within ten seconds.

The usual cause is something in your shell's startup files that does not hand
control back: a program that takes over the shell, a prompt framework that
waits on the network, an interactive question, or anything that blocks before
the shell reaches a prompt. nocx deliberately does not name a culprit — it
cannot see what is running in the terminal, and guessing would be worse than
saying nothing.

To find it, check whether your shell reaches a prompt at all:

```sh
bash -lic 'echo nocx-reached-a-prompt'
```

If that hangs, or never prints, bisect your startup files: move the second
half of `~/.bashrc` (or `~/.zshrc`) aside, open a new tab, and put it back a
piece at a time until the card comes back.

**Integration lost — nocx lost its channel to this shell.**
The session _was_ integrated and the channel then ended. Commands still run;
they are no longer recorded. Opening a new tab starts a fresh session.

**Not integrated — nocx has no integration for this shell.**
The shell on the far end is not one nocx knows how to integrate. bash and zsh
are supported; other shells get an ordinary terminal.

**Not integrated — nocx could not create a private temporary file.**
Installing the integration needs somewhere private to write on the far host.
A full disk, a read-only or `noexec` temporary directory, or a restrictive
policy will all stop it.

**Not integrated — this connection runs a configured command.**
The connection is configured to run a specific command instead of a login
shell, so there is no shell to integrate.

**Not integrated — nocx cannot say why.**
Integration stopped somewhere nocx has no name for. The backend log has more;
this is deliberately reported as its own answer rather than being rounded to
one of the reasons above, because a wrong diagnosis is worse than an honest
"unknown".

## The two controls on the card

**Don't show again for this shell** stops the card for that shell, on this
machine. It is per shell on purpose: accepting that your login shell is not
integrated says nothing about the next host you connect to. The mark on the
tab stays either way — it is the honest state of that session, and it costs
you nothing to leave visible.

**Details** shows the chain of facts: which shell nocx started, what is true
now, and the last step that worked. If it names a program nocx observed, that
line is labelled a guess and it is one: it comes from the process table, which
can be raced, and never from reading your terminal's output.
