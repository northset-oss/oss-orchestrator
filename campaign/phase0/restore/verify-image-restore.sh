#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <custom-image-artifact-dir> <new-evidence-dir> <nerdctl-binary>" >&2
  exit 64
fi

artifact_dir="$(cd "$1" && pwd -P)"
output_dir="$2"
nerdctl_bin="$3"
partial_dir="${output_dir}.partial-$$"
failed_dir="${output_dir}.failed"

die() {
  echo "image-restore-verifier: $*" >&2
  exit 1
}

[[ ! -e "$output_dir" && ! -e "$partial_dir" && ! -e "$failed_dir" ]] \
  || die "output, partial, or failed evidence path already exists"
[[ -f "$artifact_dir/inventory.json" && -f "$artifact_dir/SHA256SUMS" ]] \
  || die "inventory.json or SHA256SUMS is missing"
[[ -x "$nerdctl_bin" ]] || die "nerdctl binary is not executable"
command -v jq >/dev/null || die "jq is required"
command -v tar >/dev/null || die "tar is required"
command -v zstd >/dev/null || die "zstd is required"

mkdir -p "$partial_dir/logs" "$partial_dir/oci"
finish() {
  local code=$?
  if [[ $code -ne 0 && -d "$partial_dir" && ! -e "$failed_dir" ]]; then
    printf 'failed\n' >"$partial_dir/STATUS"
    mv "$partial_dir" "$failed_dir"
    echo "image-restore-verifier: failure evidence preserved at $failed_dir" >&2
  fi
  exit "$code"
}
trap finish EXIT

check_sha256s() {
  if command -v sha256sum >/dev/null; then
    (cd "$artifact_dir" && sha256sum -c SHA256SUMS)
  else
    (cd "$artifact_dir" && shasum -a 256 -c SHA256SUMS)
  fi
}
check_sha256s >"$partial_dir/logs/checksums.log" 2>&1 \
  || die "checksum verification failed"

[[ "$(jq -er '.schema_version' "$artifact_dir/inventory.json")" == 1 ]] \
  || die "unsupported image inventory schema"
[[ "$(jq -er '.images | length' "$artifact_dir/inventory.json")" == 1 ]] \
  || die "this verifier requires exactly one registered custom image"

source_head="$(jq -er '.source.head' "$artifact_dir/inventory.json")"
source_clean="$(jq -r '.source.clean_at_inventory' "$artifact_dir/inventory.json")"
tag="$(jq -er '.images[0].archive_tag' "$artifact_dir/inventory.json")"
expected_image_id="$(jq -er '.images[0].loaded_image_id' "$artifact_dir/inventory.json")"
expected_platform="$(jq -er '.images[0].platform' "$artifact_dir/inventory.json")"
expected_oci_digest="$(jq -er '.images[0].oci_manifest_digest' "$artifact_dir/inventory.json")"
oci_relative="$(jq -er '.images[0].files.oci_archive.path' "$artifact_dir/inventory.json")"
docker_relative="$(jq -er '.images[0].files.docker_load_archive.path' "$artifact_dir/inventory.json")"
sbom_relative="$(jq -er '.images[0].files.sbom.path' "$artifact_dir/inventory.json")"
metadata_relative="$(jq -er '.images[0].files.build_metadata.path' "$artifact_dir/inventory.json")"
for relative in "$oci_relative" "$docker_relative" "$sbom_relative" "$metadata_relative"; do
  case "$relative" in ''|/*|../*|*/../*|*/..) die "unsafe artifact path: $relative" ;; esac
  [[ -f "$artifact_dir/$relative" ]] || die "artifact is missing: $relative"
done

zstd -t "$artifact_dir/$docker_relative" >"$partial_dir/logs/zstd-test.log" 2>&1 \
  || die "Docker load archive failed zstd integrity test"
tar -tf "$artifact_dir/$oci_relative" >"$partial_dir/logs/oci-tar-list.log" \
  || die "OCI archive is not a readable tar file"
oci_layout_entry="$(grep -E '(^|/)oci-layout$' "$partial_dir/logs/oci-tar-list.log" | head -1)"
oci_index_entry="$(grep -E '(^|/)index.json$' "$partial_dir/logs/oci-tar-list.log" | head -1)"
[[ -n "$oci_layout_entry" && -n "$oci_index_entry" ]] || die "OCI layout or index is missing"
tar -xOf "$artifact_dir/$oci_relative" "$oci_layout_entry" >"$partial_dir/oci/oci-layout"
tar -xOf "$artifact_dir/$oci_relative" "$oci_index_entry" >"$partial_dir/oci/index.json"
[[ "$(jq -er '.imageLayoutVersion' "$partial_dir/oci/oci-layout")" == 1.0.0 ]] \
  || die "unsupported OCI layout version"
[[ "$(jq -er '.schemaVersion' "$partial_dir/oci/index.json")" == 2 ]] \
  || die "unsupported OCI index schema"
jq -e --arg digest "$expected_oci_digest" 'any(.manifests[]; .digest == $digest)' \
  "$partial_dir/oci/index.json" >/dev/null || die "OCI descriptor digest mismatch"

[[ "$(jq -er '.spdxVersion' "$artifact_dir/$sbom_relative")" == SPDX-2.3 ]] \
  || die "SBOM is not SPDX-2.3 JSON"
sbom_package_count="$(jq -er '.packages | length' "$artifact_dir/$sbom_relative")"
[[ "$sbom_package_count" -gt 0 ]] || die "SBOM package inventory is empty"
[[ "$(jq -er '.["containerimage.digest"]' "$artifact_dir/$metadata_relative")" == "$expected_oci_digest" ]] \
  || die "build metadata digest does not match the inventory"

credential_names=(
  GH_TOKEN GITHUB_TOKEN GITLAB_TOKEN SSH_AUTH_SOCK
  AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY GOOGLE_APPLICATION_CREDENTIALS
  OPENAI_API_KEY CODEX_API_KEY
)
for credential_name in "${credential_names[@]}"; do
  [[ -z "${!credential_name-}" ]] || die "credential-bearing environment is not permitted: $credential_name"
done

"$nerdctl_bin" load --input "$artifact_dir/$docker_relative" \
  >"$partial_dir/logs/nerdctl-load.log" 2>&1 || die "container runtime failed to load archive"
inspect="$($nerdctl_bin image inspect --format '{{.Id}} {{.Os}} {{.Architecture}}' "$tag")" \
  || die "loaded image inspect failed"
printf '%s\n' "$inspect" >"$partial_dir/logs/nerdctl-inspect.log"
read -r actual_image_id actual_os actual_architecture <<<"$inspect"
expected_os="${expected_platform%%/*}"
expected_architecture="${expected_platform##*/}"
[[ "$actual_image_id" == "$expected_image_id" ]] || die "loaded image ID mismatch"
[[ "$actual_os" == "$expected_os" && "$actual_architecture" == "$expected_architecture" ]] \
  || die "loaded image platform mismatch"

"$nerdctl_bin" run --rm --net none --entrypoint codex "$tag" --version \
  >"$partial_dir/logs/network-disabled-smoke.log" 2>&1 \
  || die "network-disabled image smoke test failed"
smoke_output="$(cat "$partial_dir/logs/network-disabled-smoke.log")"
[[ -n "$smoke_output" ]] || die "image smoke output is empty"

status=passed
completion_eligible=true
if [[ "$source_clean" != true ]]; then
  status=passed_baseline_only
  completion_eligible=false
fi
guest_mount_count="$({ findmnt -rn -t virtiofs,9p,fuse.sshfs 2>/dev/null || true; } | wc -l | tr -d ' ')"

jq -n \
  --arg status "$status" \
  --arg verified_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg source_head "$source_head" \
  --arg tag "$tag" \
  --arg image_id "$actual_image_id" \
  --arg platform "$actual_os/$actual_architecture" \
  --arg oci_manifest_digest "$expected_oci_digest" \
  --arg smoke_output "$smoke_output" \
  --arg runtime "$($nerdctl_bin --version)" \
  --argjson source_clean_at_inventory "$source_clean" \
  --argjson sbom_package_count "$sbom_package_count" \
  --argjson completion_eligible "$completion_eligible" \
  --argjson host_directory_mount_count "$guest_mount_count" \
  '{
    schema_version: 1,
    status: $status,
    verified_at: $verified_at,
    source_head: $source_head,
    source_clean_at_inventory: $source_clean_at_inventory,
    checksums_verified: true,
    zstd_integrity_verified: true,
    oci_layout_verified: true,
    oci_manifest_digest: $oci_manifest_digest,
    sbom_spdx_version: "SPDX-2.3",
    sbom_package_count: $sbom_package_count,
    archive_loaded: true,
    image_tag: $tag,
    loaded_image_id: $image_id,
    image_identity_matched: true,
    platform: $platform,
    runtime: $runtime,
    network_disabled_smoke_passed: true,
    smoke_output: $smoke_output,
    credential_environment_clean: true,
    host_directory_mount_count: $host_directory_mount_count,
    host_directory_mounts_present: ($host_directory_mount_count != 0),
    completion_eligible: $completion_eligible,
    limitation: (if $completion_eligible then null else "Image archive inventory was captured from a dirty source worktree; this validates restore mechanics but cannot close the final Phase 0.1 seal gate." end)
  }' >"$partial_dir/image-restore-result.json"

printf '%s\n' "$status" >"$partial_dir/STATUS"
mv "$partial_dir" "$output_dir"
trap - EXIT
echo "image-restore-verifier: $status; evidence at $output_dir"
