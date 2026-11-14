# Installation

RedNote Steward runs locally on macOS with Node.js 24+ and Google Chrome. Its packaged OpenCLI dependency is pinned to 1.8.5; Browser Bridge is pinned to 1.0.26. An existing compatible browser connection can be reused.

The application uses its packaged OpenCLI registry and adapters. It leaves an independently installed OpenCLI and `~/.opencli` commands in place. CLI, daemon and extension versions are separate; doctor shows the observed combination so a newer global CLI is not mistaken for the bundled runtime. A dependency upgrade is qualified per operation before it replaces the pinned combination.

## OPL Software Center

The current managed Package uses the shared OCI source:
`ghcr.io/gaofeng21cn/one-person-lab-packages/rednote-steward`.
Run `opl packages install rednote-steward --json`, inspect the installed version,
and use Software Center for updates and removal. Source tags bind immutable OCI
versions. Local checkouts are explicit developer overrides; the Software Center
never downloads a Git branch as a released version.

## macOS installation and updates

```bash
curl -fsSL https://raw.githubusercontent.com/gaofeng21cn/rednote-steward/main/install.sh | bash
```

The script installs the current `latest-stable` OCI Package into your user directory. Standalone and Software Center installations select the same version and source commit. It installs dependencies, adds command wrappers, prepares Browser Bridge, installs the generic Codex Skill, and registers the MCP Server when Codex CLI is available. Node.js 24+ is required; the installer can use an existing Homebrew installation when Node needs installing.

Current and versioned installs verify the OCI manifest, source layer and payload file digests. The installation manifest records the selected product version and source commit. Versioned installs accept versions published in the same OCI repository; source tags retain the history of older versions. A local `--source` install records its actual revision and dirty state.

The installed commands are:

- `xhs-ops`: account configuration, package inspection, queue operations, and platform reads.
- `rednote-steward-mcp`: the same operations through a standard STDIO MCP Server.

Add `export PATH="$HOME/.local/bin:$PATH"` to your shell startup file, or run it for the current terminal. The installer prints the remaining browser steps. Start a new Codex chat to discover the installed Skill and MCP tools.

## Connect Chrome and bind an account

1. Open `chrome://extensions`, enable Developer mode, and select **Load unpacked** with the Browser Bridge directory printed by setup. If a compatible extension is already connected, reuse it.
2. Open Xiaohongshu and its creator platform in that Chrome profile and sign in as the intended account holder.
3. Discover the connected profile, then read its current account identity:

```bash
xhs-ops opencli profile list
xhs-ops account probe --profile YOUR_PROFILE
```

4. Bind a local alias to the returned stable user ID and browser profile:

```bash
xhs-ops account add personal --user-id YOUR_USER_ID --profile YOUR_PROFILE
xhs-ops doctor --account personal --json
xhs-ops inventory --account personal --limit 20
```

Aliases are local names such as `personal` or `education`. The stable user ID determines account identity; the nickname is a display label. Each account uses its own profile. Login and device verification stay with the account holder in Chrome or the mobile app.

Doctor reports the actual package/source revision where available, state root and schema, dependency and bridge information, account identity and capability evidence. A capability that has not been exercised in this environment stays `unknown`; executable or extension files alone do not establish a logged-in publishing session. Use `xhs-ops doctor --redact` when sharing a diagnostic result; it omits private paths, UIDs, profiles and raw errors. Installation verification can use an account probe or inventory read without posting test content.

## MCP clients

The installer registers this server with Codex when available. To repair that registration and refresh the Skill:

```bash
xhs-ops setup --skill --mcp
```

For another MCP client, add a STDIO server using the absolute installed executable:

```json
{
  "mcpServers": {
    "rednote-steward": {
      "command": "/absolute/path/to/rednote-steward-mcp"
    }
  }
}
```

For a separate data directory, set `XHS_OPS_HOME` in the client environment and use the same value for CLI commands. This makes the client and shell use the same account bindings and task history. The same stable account ID or browser profile can have only one state owner on a machine; choosing another home does not create a second writer for that account.

When an account is deliberately moved between state roots, use the exact old home and a reason. The takeover path refuses an unreadable source, unresolved attempt or active lease:

```bash
xhs-ops account status personal
xhs-ops account takeover personal --user-id YOUR_USER_ID --profile YOUR_PROFILE \
  --from-home "$HOME/.local/share/rednote-steward-old" --reason "Transferred after previewing the old owner"
```

The server exposes tools for account probing and binding, inventory and note reads, package and batch operations, reconciliation and manual-result linking, catalog, metrics history and backups. `task_execute` returns a task ID after starting a separate worker; read `task_get` for launch status, phase and outcome. STDIO and structured tool results remain available when a host has no shared UI. The read-only qualification commands (`qualify`, `compare-qualifications`) compare observed account/backend behavior before a runtime upgrade; they do not publish test content.

## Where files live

| Location | Contents |
| --- | --- |
| `~/.local/share/rednote-steward/app/releases/<version>/` | Installed code and dependencies |
| `~/.local/share/rednote-steward/app/current` | Selected installed release |
| `~/.local/bin/` | `xhs-ops` and `rednote-steward-mcp` wrappers |
| `~/.local/share/rednote-steward/` | Account bindings, SQLite state, receipts, worker logs, and installation record |
| `~/.codex/skills/rednote-steward/` | Generic assistant instructions |
| Your chosen content folder | Original media, derivatives, copy, and content packages |
| Chrome profile | Browser login and session data |

`XHS_OPS_HOME` selects the private state root. `XHS_OPS_INSTALL_ROOT` and `XHS_OPS_BIN_DIR` select installation and wrapper directories. An upgrade replaces application code while retaining task history and account settings.

## Update, repair, and remove

Read installation status:

```bash
xhs-ops installation status --json
```

This local read checks the selected release, installation record, code digest
and managed commands. It returns the product name, stable ID, installed version
and revision without account data, browser activity or private paths. Source
checkouts and the Codex plugin do not count as a native application install.
Available updates remain unchecked until the software source is queried.

Inspect managed integrations separately:

```bash
xhs-ops setup --status
```

Refresh managed integrations:

```bash
xhs-ops setup --skill --mcp
```

Install a specific published version:

```bash
curl -fsSL https://raw.githubusercontent.com/gaofeng21cn/rednote-steward/main/install.sh \
  | bash -s -- --version v0.2.6
```

Run the packaged uninstaller to remove managed installation files and integrations:

```bash
bash "$HOME/.local/share/rednote-steward/app/current/scripts/uninstall.sh"
```

Private account state, task history, receipts, and media are retained. `xhs-ops setup --uninstall` removes only managed Skill/MCP integrations. Existing files that setup replaces are backed up; unrelated configuration is preserved.

The uninstaller must belong to the currently selected native release. An old
release cannot remove a newer installation. Installer progress output is not a
single JSON response; management callers verify the result with a fresh
installation status read.

## OPL and Codex plugin management

The stable Package ID is `rednote-steward`; the display name is **RedNote
Steward**. Its description and localized presentation live in `opl-package.json`.
The repository marketplace declares `rednote-steward@rednote-steward`. OPL uses
the pinned source payload and Codex native plugin manager for installation,
update, enable/disable and removal. Released Package identity is verified independently of
account login and publishing capabilities.

The plugin contains the runtime, MCP definition and package lock. Its shared
launcher prepares dependencies with `npm ci --ignore-scripts` inside the plugin
directory, sends setup messages to stderr, and starts the same CLI, MCP or App
contribution entrypoint. Node.js 24+ and npm are required. No global npm package,
native application selection, extra MCP registration or browser session is
created by this dependency preparation.

Removing the plugin removes that carrier; it leaves the native application and
private account/task/media state with their existing owners. Use the same
`XHS_OPS_HOME` when both carriers should operate the same queue. Installing a
plugin does not grant publication authorization or create a second account owner.

## Existing xhs-ops workspaces

Install Steward alongside the original workspace first. Verify the new account binding and platform reads before transferring operational responsibility. Existing databases, JSON ledgers, active browser drafts, and authorization records remain with their current owner until deliberately migrated.

Use one queue for a live account. Before resuming an older task, check its current record and platform note ID in the original system. Back up the current state and use a migration/restore preview to check schema, account/task counts, note IDs and media paths before applying a transfer. Restore targets an empty destination; it retains history and clears live process IDs rather than launching queued work. A new installation alone is not a reason to ingest already-published material again. See [account operations](operations.md) for backup and restore commands.

## Development install

```bash
git clone https://github.com/gaofeng21cn/rednote-steward.git
cd rednote-steward
npm ci
node src/cli.mjs help
npm test
```

To try changes that have reached `main` before a versioned release, install
the checkout explicitly with `bash install.sh --source "$PWD"`. The public
one-command installer selects the verified OCI `latest-stable` version.

For an isolated installer check, use its `--source PATH`, `--skip-browser-setup`, and `--skip-integrations` options with separate installation, binary, and state directories. Production browser sessions are unnecessary for this check.

## Stable release

OPL Package Publisher checks delivery changes on `main` daily. It prepares one product version, runs the owner tests and package check, binds an annotated source tag and publishes the immutable OCI version. `latest-stable` advances after publication verification. Software Center and the macOS installer consume that same version and source commit.

GitHub source tags retain code history. The repository has no separate GitHub Release download channel. A CI package archive is a validation artifact; user installations use OCI.
