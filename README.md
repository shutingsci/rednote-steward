<p align="center">
  <img src="assets/branding/rednote-steward-logo-v2.png" alt="RedNote Steward logo" width="132" />
</p>

<p align="center">
  <a href="./README.md"><strong>English</strong></a> | <a href="./README.zh-CN.md">中文</a>
</p>

<h1 align="center">RedNote Steward</h1>

<p align="center"><strong>Publish, organize, and maintain your Xiaohongshu account from one local workspace.</strong></p>
<p align="center">Photos · Finished videos · Existing posts · Publication history</p>

RedNote Steward brings ready-to-share media, account settings, publication tasks, and platform results into one workflow. Use it through Codex, a standard MCP client, or the `xhs-ops` command line. It reuses a logged-in Chrome session through OpenCLI and keeps the progress of each task on your machine.

A travel photo collection, a series of finished educational videos, and an update to an older post all need the same practical answers: which version is ready, which account will receive it, what has already been submitted, and where to continue after an interruption. Steward keeps those answers with the task, so they remain available in the next conversation or terminal session.

<p align="center">
  <img src="assets/branding/rednote-steward-overview-v2.png" alt="Photos and videos enter a local account queue, are published through OpenCLI and Chrome, and are read back from the same platform note. CLI and MCP share the controller; personal data remains local." width="100%" />
</p>

## What You Can Ask It To Do

> “Publish these prepared posts to my account in order, using the included covers and copy. Keep a record of each result.”

> “Show what is queued, what has been published, and which interrupted tasks need checking.”

> “Review this week's travel photos and posts. Keep my voice, improve the parts that benefit from editing, and preserve the scene in any photo adjustments.”

> “Match these revised videos to their earlier posts before we decide which versions to publish.”

The bundled Skill helps an assistant follow these workflows. Your account preferences, content decisions, and existing authorization remain part of your own workspace.

## Core Capabilities

| Work | What Steward provides |
| --- | --- |
| Prepare a release | Image or video packages with copy, native topic names, optional cover, and file fingerprints |
| Manage accounts | Stable account ID and browser profile bindings, with identity checks before writes |
| Publish and edit | New image/video posts and in-place video replacement in existing notes, with a local queue, authorization records, due times, and one active write per account |
| Continue after interruption | Saved attempts, platform note IDs, readback, and reconciliation before another attempt |
| Maintain existing posts | Inventory, supported text/topic/image edits, metrics, and review candidates |
| Organize an account | Local series/episode catalog, inspection cursors, media lineage, and append-only metrics history |
| Operate a batch | Bounded batch execution, per-item results, pause/cancel controls, and manual-publication handoff |
| Use another client | CLI and standard MCP Server over the same controller and task database |

Account preferences and operational records live outside the installed code. Media stays in the workspace you choose. Installation adds no recurring inspection or background publishing schedule.

The runner selects eligible accounts, so one unresolved task does not hold up an unrelated account. An account ID or Chrome profile has one local state owner, including when more than one `XHS_OPS_HOME` exists on the machine.

## Install with OPL Software Center

Install the released Package from OPL Software Center or its CLI:

```bash
opl packages install rednote-steward --json
opl packages status --package-id rednote-steward --json
opl packages update rednote-steward --json
```

The Package source is `ghcr.io/gaofeng21cn/one-person-lab-packages/rednote-steward`.
Its CLI and MCP entries share the same controller, installed identity, and user
state. Node.js 24+ and the browser connection remain runtime requirements.
Development checkouts are explicit overrides, not software-center releases.

The macOS installer below reads the same OCI stable version and source commit.
Choose Software Center or the standalone command for installation and updates.
Both provide the same CLI, MCP Server and assistant Skill.

## Install on macOS

With Node.js 24+ available, run:

```bash
curl -fsSL https://raw.githubusercontent.com/gaofeng21cn/rednote-steward/main/install.sh | bash
```

The installer installs the application, a pinned OpenCLI version, bundled adapters, and the generic Skill. When Codex is available, it also registers the MCP Server. It prepares the Browser Bridge extension; follow the printed instructions to enable it in Chrome and sign in to Xiaohongshu. Existing connected sessions can be reused.

Add the command directory to the current shell PATH, then discover the browser profile and account:

```bash
export PATH="$HOME/.local/bin:$PATH"
xhs-ops opencli profile list
xhs-ops account probe --profile YOUR_PROFILE
xhs-ops account add personal --user-id YOUR_USER_ID --profile YOUR_PROFILE
xhs-ops doctor --account personal --json
```

Use the ID returned by the probe. Give each account its own profile binding. Doctor reports the installed source, toolchain, identity and capability evidence; untested capabilities remain `unknown`. The [installation guide](docs/installation.md) covers a fresh machine, MCP clients, upgrades, and removal.

## Publish a Prepared Package

Create a `post.json` beside your media:

```json
{
  "schemaVersion": 1,
  "platform": "xiaohongshu",
  "account": "personal",
  "kind": "publish",
  "title": "A moment by the sea",
  "body": "Your own caption goes here.",
  "topics": [],
  "images": ["photos/01.jpg", "photos/02.jpg"]
}
```

Then inspect it and add it to the queue:

```bash
xhs-ops inspect ./post.json
xhs-ops ingest ./post.json
xhs-ops approve TASK_ID --authorization "Publish this prepared package" --now
xhs-ops run TASK_ID
xhs-ops show TASK_ID
```

An assistant can record an existing authorization for the requested batch; the `approve` command does not require another conversational approval. For video, use `video` and optional `cover` fields in place of `images`. Native topic names belong in `topics`; the adapter selects platform candidates during publishing.

Replacing an existing video and its custom cover uses two saves on the same note: video and copy first, then the cover. After the cover confirmation click, the adapter waits up to 30 seconds for the dialog to close; if it remains open, the cover stage stops before title/body submission. Stage evidence supports recovery without uploading the saved video again.

For a cover-only repair, use an `edit` package with `cover` and no `video`; the saved video is checked and preserved. `XHS_OPS_COVER_TIMEOUT` can raise the preview wait from its 120-second default up to 600 seconds.

See [publishing and recovery](docs/publishing.md) for video packages, edits, scheduling, and interrupted tasks. [Synthetic examples](examples/) contain no account data or real posts.

## Manage a Prepared Batch

```bash
xhs-ops ingest-batch ./posts/one/post.json ./posts/two/post.json --batch travel-set
xhs-ops approve-batch travel-set --authorization "Publish this prepared batch" --now
xhs-ops run-batch travel-set --limit 4
xhs-ops handoff TASK_ID
```

Each item retains its own content fingerprint and result. A manual platform action can be linked back to the original task with `link-existing`; a recovery reads the saved attempt before another submission. Catalog, metric history, media provenance and backup/restore workflows are covered in [account operations](docs/operations.md).

## Use With an MCP Client

The standard STDIO server is available as `rednote-steward-mcp`:

```json
{
  "mcpServers": {
    "rednote-steward": {
      "command": "rednote-steward-mcp"
    }
  }
}
```

Use the installed executable's absolute path when your client does not inherit the shell PATH. CLI and MCP share account settings and task state. Long publishing calls return a task ID for subsequent progress queries.

## Current Scope

The local browser workflow targets macOS and logged-in Chrome through the pinned OpenCLI/Browser Bridge combination. Image publishing, existing-post maintenance, account reads, and inventory build on the original workflow. Video and custom-cover support are included in the adapter. Tests exercise control flow; live media acceptance is recorded separately for the relevant account and environment. Platform changes may require adapter updates.

The CLI, standard MCP Server and assistant Skill share one controller and released version. The OPL/Codex plugin includes the same runtime, locked dependencies and read-only views for tasks, exact content differences, frozen media and platform readback. Software Center and the standalone installer select the verified OCI stable release. Source tags retain version history; installation and updates use the same published Package. Use `xhs-ops review TASK_ID` or `task_review` in clients without a shared UI. Your chosen tools produce content and enhance photos; Steward manages their prepared outputs and publication records.

## Documentation and Development

- [Installation](docs/installation.md) — new users, browser connection, MCP, upgrades, and removal.
- [Publishing and recovery](docs/publishing.md) — content packages, edits, task states, and reconciliation.
- [Account operations](docs/operations.md) — batches, manual handoff, catalog, metrics history, media lineage, and backups.
- [Architecture](docs/architecture.md) — the shared controller, account isolation, and private data layout.
- [Backend compatibility](docs/backend-compatibility.md) — capability evidence and read-only comparisons before an adapter upgrade.
- [Assistant Skill](skills/rednote-steward/SKILL.md) — publishing and account-maintenance guidance.

```bash
npm ci
npm test
npm run check:package
```

## License

[Apache License 2.0](LICENSE). OpenCLI and other reused components are credited in [NOTICE](NOTICE).
