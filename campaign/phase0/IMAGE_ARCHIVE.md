# Phase 0 custom-image archive

`custom-images.json` is the complete registry of repository-owned Dockerfiles. The archive
command fails if a tracked custom Dockerfile is missing from the registry or if the registry
points at an untracked Dockerfile.

Create a new ignored evidence directory:

```sh
node campaign/phase0/archive-custom-images.mjs \
  --output runs/phase0/custom-images-$(date -u +%Y%m%dT%H%M%SZ)
```

For each image, the command creates or reuses a dedicated Buildx `docker-container` builder,
then builds a platform-specific OCI archive with BuildKit SBOM and provenance attestations.
Because Docker Engine does not load OCI-layout tarballs, the command structurally validates
the OCI layout and attestation descriptors, then reuses the BuildKit cache to emit a Docker
image archive compressed with Zstandard. It removes its run-unique verification tag, loads
that Docker-native archive, inspects it, runs `codex --version` with networking disabled, and
writes a separate SPDX JSON SBOM using Docker Scout.

`SHA256SUMS` covers both archives and all evidence files. Verify it from the evidence
directory with:

```sh
shasum -a 256 -c SHA256SUMS
```

The command's local verification is not the Phase 0.1 clean-VM restore gate, encrypted
off-machine copy, or signed top-level campaign manifest.
