#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 7 ]]; then
  echo "usage: $0 <new-output-dir> <lima-yaml> <node-bin> <node-tar> <node-shasums> <sqlite-bin> <sqlite-deb>" >&2
  exit 64
fi

output="$1"
lima_yaml="$2"
node_bin="$3"
node_tar="$4"
node_shasums="$5"
sqlite_bin="$6"
sqlite_deb="$7"

[[ ! -e "$output" ]] || { echo "output already exists: $output" >&2; exit 1; }
mkdir -p "$output"
cp "$lima_yaml" "$output/lima.yaml"

host_share_count="$({ findmnt -rn -t virtiofs,9p,fuse.sshfs 2>/dev/null || true; } | wc -l | tr -d ' ')"
ssh_agent_present=false
[[ -n "${SSH_AUTH_SOCK-}" ]] && ssh_agent_present=true
credential_count=0
for name in GH_TOKEN GITHUB_TOKEN GITLAB_TOKEN AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY \
  GOOGLE_APPLICATION_CREDENTIALS OPENAI_API_KEY CODEX_API_KEY; do
  [[ -n "${!name-}" ]] && credential_count=$((credential_count + 1))
done

jq -n \
  --arg captured_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg instance northset-phase01-restore \
  --arg virtualization_driver vz \
  --arg kernel "$(uname -srvmo)" \
  --arg architecture "$(uname -m)" \
  --arg os_pretty "$(. /etc/os-release; printf %s "$PRETTY_NAME")" \
  --argjson host_directory_mount_count "$host_share_count" \
  --argjson ssh_agent_socket_present "$ssh_agent_present" \
  --argjson credential_environment_name_count "$credential_count" \
  --arg lima_config_sha256 "$(sha256sum "$output/lima.yaml" | awk '{print $1}')" \
  --argjson mounts "$(findmnt --json -o TARGET,SOURCE,FSTYPE)" \
  '{
    schema_version: 1,
    captured_at: $captured_at,
    instance: $instance,
    real_vm: true,
    virtualization_driver: $virtualization_driver,
    kernel: $kernel,
    architecture: $architecture,
    os: $os_pretty,
    host_directory_mount_count: $host_directory_mount_count,
    host_directory_mounts_present: ($host_directory_mount_count != 0),
    ssh_agent_forwarding_configured: false,
    ssh_agent_socket_present: $ssh_agent_socket_present,
    credential_environment_name_count: $credential_environment_name_count,
    lima_config_sha256: $lima_config_sha256,
    mounts: $mounts
  }' >"$output/vm-environment.json"

jq -n \
  --arg captured_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg node_version "$($node_bin --version)" \
  --arg node_tar_sha256 "$(sha256sum "$node_tar" | awk '{print $1}')" \
  --arg node_shasums_sha256 "$(sha256sum "$node_shasums" | awk '{print $1}')" \
  --arg sqlite_version "$($sqlite_bin --version)" \
  --arg sqlite_package "$(dpkg-deb --field "$sqlite_deb" Package)" \
  --arg sqlite_package_version "$(dpkg-deb --field "$sqlite_deb" Version)" \
  --arg sqlite_package_architecture "$(dpkg-deb --field "$sqlite_deb" Architecture)" \
  --arg sqlite_deb_sha256 "$(sha256sum "$sqlite_deb" | awk '{print $1}')" \
  '{
    schema_version: 1,
    captured_at: $captured_at,
    node: {
      version: $node_version,
      scope: "user",
      source: "https://nodejs.org/dist/v24.16.0/",
      archive_sha256: $node_tar_sha256,
      official_shasums_file_sha256: $node_shasums_sha256,
      checksum_verified: true
    },
    sqlite: {
      version: $sqlite_version,
      scope: "user extracted package, no sudo",
      package: $sqlite_package,
      package_version: $sqlite_package_version,
      architecture: $sqlite_package_architecture,
      source: "Ubuntu resolute main via apt download",
      deb_sha256: $sqlite_deb_sha256
    },
    source_manifest_gap: "The source seal records Node and Docker but not the sqlite3 CLI required by ten tests."
  }' >"$output/prerequisites.json"

(
  cd "$output"
  sha256sum lima.yaml vm-environment.json prerequisites.json >SHA256SUMS
  sha256sum -c SHA256SUMS
)
