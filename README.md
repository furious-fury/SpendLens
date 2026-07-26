# SpendLens

SpendLens is a local-first financial statement analyzer. It imports bank statements, helps classify
transactions, and explains how money moved without requiring permanent statement uploads.

## Requirements

- Node.js 22
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

## Quality commands

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```
