#!/usr/bin/env bash
set -euo pipefail

# Install a released source snapshot and its locked dependencies into user space.
version="latest-stable"
source_dir=""
skip_browser=0
skip_integrations=0
install_root="${XHS_OPS_INSTALL_ROOT:-$HOME/.local/share/rednote-steward/app}"
bin_dir="${XHS_OPS_BIN_DIR:-$HOME/.local/bin}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) version="$2"; shift 2 ;;
    --source) source_dir="$2"; shift 2 ;;
    --skip-browser-setup) skip_browser=1; shift ;;
    --skip-integrations) skip_integrations=1; shift ;;
    --help|-h)
      printf '%s\n' 'Usage: install.sh [--version latest-stable|vX.Y.Z] [--source DIR] [--skip-browser-setup] [--skip-integrations]' \
        'XHS_OPS_INSTALL_ROOT chooses the application directory; XHS_OPS_BIN_DIR chooses the command directory.'
      exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done

case "$version" in
  latest-stable|v[0-9]*.[0-9]*.[0-9]*) ;;
  *) printf 'Use a release tag such as v0.2.6: %s\n' "$version" >&2; exit 2 ;;
esac
case "$version" in *[!a-zA-Z0-9._-]*) printf 'Invalid release tag\n' >&2; exit 2 ;; esac

if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    printf '%s\n' 'Installing Node.js 24 with Homebrew...'
    brew install node@24
    export PATH="$(brew --prefix node@24)/bin:$PATH"
  else
    printf '%s\n' 'Install Node.js 24 or newer from https://nodejs.org, then run this command again.' >&2
    exit 1
  fi
fi
command -v npm >/dev/null 2>&1 || { printf '%s\n' 'npm is required with Node.js.' >&2; exit 1; }
node_bin="$(command -v node)"
stage="$(mktemp -d "${TMPDIR:-/tmp}/rednote-steward.XXXXXXXX")"
trap 'rm -rf "$stage"' EXIT

if [ -n "$source_dir" ]; then
  source_dir="$(cd "$source_dir" && pwd -P)"
  mkdir -p "$stage/source"
  # Copy only public package inputs. Never take a developer's .state, .git,
  # media workspace or local node_modules into an installation.
  "$node_bin" --input-type=module - "$source_dir" "$stage/source" <<'NODE'
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [from, to] = process.argv.slice(2);
const entries = ['package.json', 'package-lock.json', 'release-manifest.json', 'release-automation.json', 'src', 'adapters', 'skills', 'scripts', 'install.sh', 'LICENSE', 'NOTICE', 'README.md', 'README.zh-CN.md', 'docs', 'assets', 'examples', 'opl-package.json', 'app-contribution-adapter.json', 'plugin.json', '.codex-plugin', 'mcp.json', '.agents/plugins'];
for (const name of entries) {
  try { await fs.cp(path.join(from, name), path.join(to, name), { recursive: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
// Local source installation keeps its exact revision and dirty state. Release
// artifacts already carry the immutable manifest generated from their commit.
try { await fs.access(path.join(to, 'release-manifest.json')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const { createReleaseManifest } = await import(pathToFileURL(path.join(from, 'src/lib/build.mjs')).href);
  const manifest = await createReleaseManifest(from);
  await fs.writeFile(path.join(to, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}
NODE
else
  command -v curl >/dev/null 2>&1 || { printf '%s\n' 'curl is required.' >&2; exit 1; }
  curl --fail --silent --show-error --location \
    https://raw.githubusercontent.com/gaofeng21cn/rednote-steward/main/scripts/download-stable.mjs \
    -o "$stage/download-stable.mjs"
  "$node_bin" "$stage/download-stable.mjs" "$stage/oci" "$version" > "$stage/selected.json"
  mv "$stage/oci/source" "$stage/source"
fi

printf '%s\n' 'Installing locked dependencies...'
(
  cd "$stage/source"
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund
)
set -- --source "$stage/source" --root "$install_root" --bin "$bin_dir" --node "$node_bin"
if [ "$skip_browser" -eq 0 ]; then set -- "$@" --browser-extension; fi
if [ "$skip_integrations" -eq 0 ]; then set -- "$@" --skill --mcp; fi

"$node_bin" "$stage/source/scripts/install-local.mjs" "$@"
printf '\n%s\n' "Commands are installed in $bin_dir." \
  'If xhs-ops is not on PATH, add your command directory to PATH or invoke it by its absolute path.' \
  'Run xhs-ops doctor after connecting the Chrome extension and your account.'
