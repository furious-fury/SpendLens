# SpendLens

SpendLens is a local-first financial statement analyzer. It imports bank statements, helps classify
transactions, and explains how money moved without requiring permanent statement uploads.

## Requirements

- Node.js 22.13–24
- pnpm 10
- An operating-system credential store for local mode, or a mounted secret file for self-hosting

## Start locally

```bash
pnpm install
pnpm dev
```

Open `http://127.0.0.1:5173`, then read the one-time setup token in a second terminal:

```bash
pnpm security:setup-token
```

The setup flow creates an encrypted database, asks for a separate SpendLens password, and generates
a recovery file plus recovery code. Store the recovery file and code separately.

### Windows and WSL

Install and run SpendLens from the same environment. Windows and Windows Subsystem for Linux (WSL)
create different command launchers and native dependencies, so they cannot share one `node_modules`
installation.

If you switch between Windows and WSL, rebuild the installation from the terminal you intend to use:

```bash
pnpm install --force
pnpm dev
```

## Database key modes

Local mode is the default. SpendLens stores the random database key in Windows Credential Manager,
macOS Keychain, or the Linux keyring.

Self-hosted mode reads the database key from a permission-restricted mounted file. Generate one
before the first startup:

```bash
pnpm security:generate-secret -- /safe/path/spendlens-database-key
```

Then set:

```bash
SPENDLENS_DATABASE_KEY_FILE=/safe/path/spendlens-database-key
```

On Linux, the secret file must use mode `0600` or a stricter mode.

## Maintenance recovery

Recovery requires all three items:

1. The encrypted database backup.
2. The SpendLens recovery file.
3. The separate recovery code.

With the application stopped, run:

```bash
pnpm security:recover -- --recovery-file /safe/path/spendlens-recovery.json
```

The command prompts without echoing the recovery code or new password. It validates access, creates
a pre-recovery copy of the encrypted database, changes the password, and revokes existing sessions.

## Encrypted backups and device-loss restoration

Create and download a portable `.slbackup` file from Settings → Security. The backup remains
encrypted and still requires the matching recovery file and recovery code.

Automatic daily backups run at 02:00 in the workspace timezone only when a server-side backup
folder is configured:

```bash
SPENDLENS_BACKUP_DIR=/safe/backups/spendlens
```

Prefer another physical drive or mounted volume. A backup on the same drive protects against some
mistakes, but not drive or device loss.

Verify a backup while SpendLens is stopped:

```bash
pnpm backup:verify -- --backup /safe/path/workspace.slbackup --recovery-file /safe/path/spendlens-recovery.json
```

Restore onto a clean machine:

```bash
pnpm backup:restore -- --backup /safe/path/workspace.slbackup --recovery-file /safe/path/spendlens-recovery.json
```

Replacing an existing workspace additionally requires `--replace-existing` and
`--confirm-workspace <current-workspace-id>`. Restoration preserves the login password stored in
the backup. Use `pnpm security:recover` afterward if that password is also unavailable.

API keys stored in the local operating-system keyring are intentionally not copied into portable
backups and must be entered again after device loss. Self-hosted provider credentials stored inside
the encrypted database remain portable.

## Quality commands

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```
