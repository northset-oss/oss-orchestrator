# Phase 0.1 clean-VM restore

The restore gate must run inside a real VM. A Docker container is not sufficient. The
validated host mechanism is Lima with Apple's `vz` virtualization driver on arm64 macOS.

Create an isolated Ubuntu VM with no host-directory mounts, no forwarded SSH agent, and no
container runtime:

```sh
limactl start --name northset-phase01-restore --tty=false \
  --vm-type vz --arch aarch64 --cpus 4 --memory 6 --disk 30 \
  --mount-none --containerd none template:default
```

Copy the source-seal directory and `verify-source-restore.sh` into guest storage with
`limactl copy`. Do not mount the production checkout and do not copy any credential file.
Install the exact Node version recorded in `seal-manifest.json` in the guest's home
directory, verifying the release archive against Node's `SHASUMS256.txt`. Supply a
user-scoped `sqlite3` binary because the repository's candidate-lake tests invoke that CLI.

Run the verifier in a guest shell after unsetting credential-bearing variables:

```sh
bash verify-source-restore.sh \
  /guest/path/to/source-seal \
  /guest/path/to/new-restore-evidence \
  /guest/path/to/node \
  /guest/path/to/sqlite3
```

The verifier checks the manifest sidecar and bundle digest, verifies the bundle in a fresh
bare repository, clones only from the bundle, matches the recorded HEAD and tree, requires
an empty porcelain-v2 status, verifies critical inventory digests, requires the recorded
Node version, and runs `node --test` with an otherwise empty environment. One existing test
calls the credential-copy preparation path even though Docker is mocked; the verifier uses
an empty `{}` `auth.json` fixture for that test and records this fact. It never copies a real
credential into the VM.

`collect-vm-evidence.sh` records the VM kernel/OS/architecture, mount table, absence of host
directory mounts and credential environment names, Lima configuration digest, and the exact
user-scoped Node and SQLite bootstrap evidence.

The seal is definitive only when it targets the final clean Phase 0 integration commit.
Restoring an earlier clean baseline proves the mechanism but does not close the final
campaign seal gate.
