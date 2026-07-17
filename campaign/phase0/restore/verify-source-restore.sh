#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo "usage: $0 <source-seal-directory> <new-evidence-directory> <node-binary> <sqlite3-binary>" >&2
  exit 64
fi

seal_dir="$(cd "$1" && pwd -P)"
output_dir="$2"
node_bin="$3"
sqlite_bin="$4"
partial_dir="${output_dir}.partial-$$"
failed_dir="${output_dir}.failed"

die() {
  echo "restore-verifier: $*" >&2
  exit 1
}

[[ ! -e "$output_dir" && ! -e "$partial_dir" && ! -e "$failed_dir" ]] \
  || die "output, partial, or failed evidence path already exists"
[[ -f "$seal_dir/seal-manifest.json" ]] || die "seal-manifest.json is missing"
[[ -f "$seal_dir/seal-manifest.sha256" ]] || die "seal-manifest.sha256 is missing"
command -v git >/dev/null || die "git is required"
command -v jq >/dev/null || die "jq is required"
[[ -x "$node_bin" ]] || die "node binary is not executable: $node_bin"
[[ -x "$sqlite_bin" ]] || die "sqlite3 binary is not executable: $sqlite_bin"

mkdir -p "$partial_dir/logs" "$partial_dir/empty-home/.codex"
printf '{}\n' >"$partial_dir/empty-home/.codex/auth.json"

finish() {
  local code=$?
  if [[ $code -ne 0 && -d "$partial_dir" && ! -e "$failed_dir" ]]; then
    printf 'failed\n' >"$partial_dir/STATUS"
    mv "$partial_dir" "$failed_dir"
    echo "restore-verifier: failure evidence preserved at $failed_dir" >&2
  fi
  exit "$code"
}
trap finish EXIT

file_sha256() {
  if command -v sha256sum >/dev/null; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

check_sidecar() {
  if command -v sha256sum >/dev/null; then
    (cd "$seal_dir" && sha256sum -c seal-manifest.sha256)
  else
    (cd "$seal_dir" && shasum -a 256 -c seal-manifest.sha256)
  fi
}

format="$(jq -er '.format' "$seal_dir/seal-manifest.json")"
schema_version="$(jq -er '.schema_version' "$seal_dir/seal-manifest.json")"
[[ "$format" == "northset-phase0-source-seal" && "$schema_version" == "1" ]] \
  || die "unsupported source-seal manifest"

check_sidecar >"$partial_dir/logs/seal-manifest-sidecar.log" 2>&1 \
  || die "seal manifest sidecar verification failed"

bundle_artifact="$(jq -er '.source_bundle.artifact' "$seal_dir/seal-manifest.json")"
case "$bundle_artifact" in
  ''|/*|../*|*/../*|*/..) die "unsafe bundle artifact path in manifest" ;;
esac
bundle_path="$seal_dir/$bundle_artifact"
[[ -f "$bundle_path" ]] || die "source bundle is missing: $bundle_artifact"
expected_bundle_sha="$(jq -er '.source_bundle.sha256 | sub("^sha256:"; "")' "$seal_dir/seal-manifest.json")"
actual_bundle_sha="$(file_sha256 "$bundle_path")"
[[ "$actual_bundle_sha" == "$expected_bundle_sha" ]] \
  || die "bundle digest mismatch: expected $expected_bundle_sha, got $actual_bundle_sha"

empty_home="$partial_dir/empty-home"
bundle_verify_repo="$partial_dir/bundle-verify-repository"
HOME="$empty_home" GIT_CONFIG_NOSYSTEM=1 git init --bare "$bundle_verify_repo" \
  >"$partial_dir/logs/git-bundle-verify-repository-init.log" 2>&1 \
  || die "could not initialize bundle-verification repository"
HOME="$empty_home" GIT_CONFIG_NOSYSTEM=1 git -C "$bundle_verify_repo" bundle verify "$bundle_path" \
  >"$partial_dir/logs/git-bundle-verify.log" 2>&1 \
  || die "git bundle verify failed"

restored_repo="$partial_dir/restored-repository"
HOME="$empty_home" GIT_CONFIG_NOSYSTEM=1 git clone --no-hardlinks "$bundle_path" "$restored_repo" \
  >"$partial_dir/logs/git-clone.log" 2>&1 \
  || die "git clone from bundle failed"

expected_head="$(jq -er '.git.head_oid' "$seal_dir/seal-manifest.json")"
expected_tree="$(jq -er '.git.head_tree_oid' "$seal_dir/seal-manifest.json")"
actual_head="$(HOME="$empty_home" GIT_CONFIG_NOSYSTEM=1 git -C "$restored_repo" rev-parse HEAD)"
actual_tree="$(HOME="$empty_home" GIT_CONFIG_NOSYSTEM=1 git -C "$restored_repo" rev-parse 'HEAD^{tree}')"
[[ "$actual_head" == "$expected_head" ]] || die "restored HEAD mismatch"
[[ "$actual_tree" == "$expected_tree" ]] || die "restored tree mismatch"

status="$(HOME="$empty_home" GIT_CONFIG_NOSYSTEM=1 git -C "$restored_repo" status --porcelain=v2 --untracked-files=all)"
[[ -z "$status" ]] || die "restored worktree is not clean"

inventory_tsv="$partial_dir/logs/inventory-digests.tsv"
jq -r '[
    .inventory.lockfiles[],
    .inventory.dockerfiles[],
    .inventory.profile_registries[],
    .inventory.migration_files[],
    .inventory.policy_files[]
  ] | unique_by(.path)[] | [.path, (.sha256 | sub("^sha256:"; ""))] | @tsv' \
  "$seal_dir/seal-manifest.json" >"$inventory_tsv"

while IFS=$'\t' read -r relative_path expected_sha; do
  [[ -n "$relative_path" ]] || continue
  case "$relative_path" in
    /*|../*|*/../*|*/..) die "unsafe inventory path in manifest: $relative_path" ;;
  esac
  [[ -f "$restored_repo/$relative_path" ]] || die "inventory file missing after restore: $relative_path"
  actual_sha="$(file_sha256 "$restored_repo/$relative_path")"
  [[ "$actual_sha" == "$expected_sha" ]] \
    || die "inventory digest mismatch after restore: $relative_path"
done <"$inventory_tsv"

credential_names=(
  GH_TOKEN GITHUB_TOKEN GITLAB_TOKEN SSH_AUTH_SOCK
  AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY GOOGLE_APPLICATION_CREDENTIALS
  OPENAI_API_KEY CODEX_API_KEY
)
for credential_name in "${credential_names[@]}"; do
  [[ -z "${!credential_name-}" ]] || die "credential-bearing environment is not permitted: $credential_name"
done

expected_node_version="$(jq -er '.environment.node.version' "$seal_dir/seal-manifest.json")"
actual_node_version="$($node_bin --version)"
[[ "$actual_node_version" == "$expected_node_version" ]] \
  || die "Node version mismatch: expected $expected_node_version, got $actual_node_version"
sqlite_version="$($sqlite_bin --version)"

(
  cd "$restored_repo"
  env -i \
    HOME="$empty_home" \
    CODEX_HOME="$empty_home/.codex" \
    PATH="$(dirname "$node_bin"):$(dirname "$sqlite_bin"):/usr/local/bin:/usr/bin:/bin" \
    LANG=C.UTF-8 \
    GIT_CONFIG_NOSYSTEM=1 \
    "$node_bin" --test
) >"$partial_dir/logs/full-test-output.log" 2>&1 \
  || die "full restored test suite failed"

guest_os="$(uname -srvmo)"
guest_arch="$(uname -m)"
git_version="$(git --version)"
jq -n \
  --arg status passed \
  --arg verified_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg source_manifest_format "$format" \
  --arg expected_head_oid "$expected_head" \
  --arg restored_head_oid "$actual_head" \
  --arg expected_head_tree_oid "$expected_tree" \
  --arg restored_head_tree_oid "$actual_tree" \
  --arg bundle_sha256 "$actual_bundle_sha" \
  --arg node_version "$actual_node_version" \
  --arg sqlite_version "$sqlite_version" \
  --arg git_version "$git_version" \
  --arg guest_os "$guest_os" \
  --arg guest_architecture "$guest_arch" \
  '{
    schema_version: 1,
    status: $status,
    verified_at: $verified_at,
    source_manifest_format: $source_manifest_format,
    bundle_sha256: $bundle_sha256,
    bundle_sha256_match: true,
    bundle_verified: true,
    expected_head_oid: $expected_head_oid,
    restored_head_oid: $restored_head_oid,
    head_oid_match: true,
    expected_head_tree_oid: $expected_head_tree_oid,
    restored_head_tree_oid: $restored_head_tree_oid,
    head_tree_oid_match: true,
    clean_worktree: true,
    inventory_digest_check: true,
    credential_environment_clean: true,
    node_version: $node_version,
    node_version_match: true,
    sqlite_available: true,
    sqlite_version: $sqlite_version,
    synthetic_codex_auth_placeholder: true,
    synthetic_codex_auth_placeholder_scope: "Empty JSON test fixture only; no host credential was copied into the VM.",
    git_version: $git_version,
    guest_os: $guest_os,
    guest_architecture: $guest_architecture,
    full_test_suite_command: "node --test",
    full_test_suite_passed: true
  }' >"$partial_dir/restore-result.json"

printf 'passed\n' >"$partial_dir/STATUS"
mv "$partial_dir" "$output_dir"
trap - EXIT
echo "restore-verifier: PASS; evidence at $output_dir"
