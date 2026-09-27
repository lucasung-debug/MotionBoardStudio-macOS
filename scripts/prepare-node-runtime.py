#!/usr/bin/env python3
"""Fetch the pinned official standalone runtime, verifying before extraction."""
import hashlib
import json
import os
from pathlib import Path
import platform
import sys
import tarfile
import urllib.request
import uuid

VERSION = "v24.21.0"
CHECKSUMS = {
    "arm64": "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057",
    "x64": "1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097",
}


def main():
    architecture = {"arm64": "arm64", "x86_64": "x64"}.get(platform.machine())
    if sys.platform != "darwin" or architecture is None:
        raise SystemExit("Build on an Apple Silicon or Intel Mac.")
    name = f"node-{VERSION}-darwin-{architecture}"
    destination = Path(__file__).resolve().parent.parent / ".local" / "node-runtime" / name
    destination.mkdir(parents=True, exist_ok=True)
    archive = destination / f"{name}.tar.gz"
    source = f"https://nodejs.org/dist/{VERSION}/{archive.name}"
    if not archive.is_file():
        temporary = archive.with_name(archive.name + "." + uuid.uuid4().hex + ".download")
        try:
            with urllib.request.urlopen(source, timeout=60) as response, temporary.open("xb") as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
            temporary.rename(archive)
        except Exception:
            # Only the incomplete download created by this invocation is removed.
            if temporary.exists():
                temporary.unlink()
            raise
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    if digest != CHECKSUMS[architecture]:
        raise SystemExit("Official Node archive checksum mismatch; refusing to extract or execute.")
    with tarfile.open(archive, "r:gz") as package:
        for member_name, filename, mode in [(f"{name}/bin/node", "node", 0o755), (f"{name}/LICENSE", "LICENSE", 0o644)]:
            member = package.getmember(member_name)
            if not member.isfile():
                raise SystemExit("Unexpected runtime archive member type.")
            data = package.extractfile(member).read()
            file = destination / filename
            if file.exists() and file.read_bytes() != data:
                raise SystemExit(f"Existing runtime file differs; preserve it and choose a clean cache: {file}")
            if not file.exists():
                file.write_bytes(data)
            os.chmod(file, mode)
    receipt = {"version": VERSION, "architecture": architecture, "archiveSHA256": digest,
               "source": source, "checksums": f"https://nodejs.org/dist/{VERSION}/SHASUMS256.txt"}
    (destination / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(destination)


if __name__ == "__main__":
    main()
