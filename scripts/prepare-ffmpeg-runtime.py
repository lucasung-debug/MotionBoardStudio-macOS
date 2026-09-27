#!/usr/bin/env python3
"""Build the pinned LGPL FFmpeg tools using only macOS system dependencies.

Progress goes to stderr; stdout contains only the completed runtime directory.
No source patches, global package installation, or existing-cache deletion occur.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import uuid


VERSION = "9.0.2"
DEPLOYMENT_TARGET = "14.0"
FINGERPRINT = "FCF986EA15E6E293A5644F10B4322F04D67658D8"
DOWNLOADS = {
    f"ffmpeg-{VERSION}.tar.xz": (
        f"https://ffmpeg.org/releases/ffmpeg-{VERSION}.tar.xz",
        "8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e",
    ),
    f"ffmpeg-{VERSION}.tar.xz.asc": (
        f"https://ffmpeg.org/releases/ffmpeg-{VERSION}.tar.xz.asc",
        "d617fd94ea354dadd2a8bb16243d37c44e1e9729b06b6ad58fe30bfb0fa943f2",
    ),
    "ffmpeg-devel.asc": (
        "https://ffmpeg.org/ffmpeg-devel.asc",
        "397b3becedcd5a98769967ff1ff8501ddc89f8368b8f766e4701377d7dbaabe5",
    ),
}


def now():
    return datetime.now(timezone.utc).isoformat()


def log(message):
    print(message, file=sys.stderr, flush=True)


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def public_copy_text(text, work):
    """Normalize private build locations in redistribution records only."""
    return text.replace(str(work), "/tmp/motionboard-ffmpeg-build").replace(str(Path.home()), "/Users/BUILD_USER")


def run(command, *, env, cwd=None, log_path=None):
    command = [str(item) for item in command]
    log("+ " + shlex.join(command))
    if log_path:
        with Path(log_path).open("w", encoding="utf-8") as output:
            result = subprocess.run(command, cwd=cwd, env=env, stdout=output, stderr=subprocess.STDOUT)
        if result.returncode:
            log(Path(log_path).read_text(encoding="utf-8", errors="replace")[-10000:])
        result.check_returncode()
        return Path(log_path).read_text(encoding="utf-8", errors="replace")
    return subprocess.check_output(command, cwd=cwd, env=env, stderr=subprocess.STDOUT, text=True)


def fetch(name, directory, offline):
    path = directory / name
    url, expected = DOWNLOADS[name]
    if not path.exists():
        bundled = Path(__file__).resolve().parent / name
        if bundled.is_file():
            if sha256(bundled) != expected:
                raise RuntimeError(f"Bundled source checksum mismatch: {bundled}")
            shutil.copyfile(bundled, path)
        else:
            if offline:
                raise RuntimeError(f"Offline source is missing: {path}")
            temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".download")
            log(f"Downloading {url}")
            # Failed downloads remain in the cache for inspection and cannot be reused.
            with urllib.request.urlopen(url, timeout=60) as response, temporary.open("xb") as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
            if sha256(temporary) != expected:
                raise RuntimeError(f"Downloaded source checksum mismatch: {temporary}")
            temporary.rename(path)
    if sha256(path) != expected:
        raise RuntimeError(f"Source checksum mismatch; preserved without extraction: {path}")
    return path


def verify_signature(downloads, work, env):
    gpg = shutil.which("gpg")
    if not gpg:
        log("GPG is unavailable; all source, signature and public-key SHA256 pins match.")
        return {"verified": False, "method": "Pinned SHA256", "reason": "gpg unavailable"}
    home = work / "gpg"
    home.mkdir(mode=0o700)
    args = [gpg, "--no-options", "--batch", "--no-autostart", "--homedir", home, "--no-auto-key-retrieve"]
    run(args + ["--import", downloads / "ffmpeg-devel.asc"], env=env, log_path=work / "gpg-import.log")
    output = run(args + ["--status-fd", "1", "--verify", downloads / f"ffmpeg-{VERSION}.tar.xz.asc",
                         downloads / f"ffmpeg-{VERSION}.tar.xz"], env=env, log_path=work / "signature-verification.txt")
    if f"[GNUPG:] VALIDSIG {FINGERPRINT} " not in output:
        raise RuntimeError("Release signature does not match the pinned FFmpeg signing fingerprint.")
    return {"verified": True, "method": "GPG detached signature and pinned SHA256", "fingerprint": FINGERPRINT}


def extract_source(archive_path, work):
    with tarfile.open(archive_path, "r:xz") as archive:
        for member in archive.getmembers():
            path = PurePosixPath(member.name)
            if path.is_absolute() or ".." in path.parts or not path.parts or path.parts[0] != f"ffmpeg-{VERSION}":
                raise RuntimeError(f"Unsafe source archive path: {member.name}")
            if not (member.isfile() or member.isdir()):
                raise RuntimeError(f"Unexpected source archive member type: {member.name}")
        # Members were checked explicitly; this also works on Python 3.9 shipped by Xcode.
        archive.extractall(work)
    return work / f"ffmpeg-{VERSION}"


def inspect_runtime(directory, env):
    dependencies = {}
    minimum_os = {}
    for program in ("ffmpeg", "ffprobe"):
        binary = directory / program
        output = run(["/usr/bin/otool", "-L", binary], env=env)
        libraries = [line.strip().split(" (compatibility version", 1)[0] for line in output.splitlines()[1:] if line.strip()]
        if not libraries or any(not item.startswith(("/usr/lib/", "/System/Library/")) for item in libraries):
            raise RuntimeError(f"Non-system dependency in {program}: {libraries}")
        dependencies[program] = libraries
        load_commands = run(["/usr/bin/otool", "-l", binary], env=env)
        versions = re.findall(r"\bminos\s+(\d+\.\d+(?:\.\d+)?)", load_commands)
        if versions != [DEPLOYMENT_TARGET]:
            raise RuntimeError(f"Unexpected deployment target in {program}: {versions}")
        minimum_os[program] = versions[0]
    return {"systemDependencies": dependencies, "minimumMacOS": minimum_os}


def check_capabilities(directory, env, evidence):
    ffmpeg = directory / "ffmpeg"
    requirements = {
        "encoders": {"h264_videotoolbox", "ffv1", "mjpeg", "png", "aac", "pcm_f32le", "pcm_s16le"},
        "decoders": {"h264", "ffv1", "mjpeg", "png", "aac", "mp3", "pcm_f32le", "pcm_s16le"},
        "filters": {"tmix", "select", "tile", "scale", "color", "amix", "aresample", "setpts", "format", "sine"},
    }
    for category, required in requirements.items():
        output = run([ffmpeg, "-hide_banner", f"-{category}"], env=env)
        (evidence / f"{category}.txt").write_text(output, encoding="utf-8")
        present = {tokens[1] for line in output.splitlines() if len(tokens := line.split()) >= 2}
        missing = required - present
        if missing:
            raise RuntimeError(f"Missing FFmpeg {category}: {sorted(missing)}")
    encoder_help = run([ffmpeg, "-hide_banner", "-h", "encoder=h264_videotoolbox"], env=env)
    if "-allow_sw" not in encoder_help:
        raise RuntimeError("VideoToolbox software fallback option is missing.")
    (evidence / "h264-videotoolbox.txt").write_text(encoder_help, encoding="utf-8")
    license_text = run([ffmpeg, "-L"], env=env)
    normalized_license = " ".join(license_text.split())
    if "GNU Lesser General Public License" not in normalized_license or "nonfree and unredistributable" in normalized_license:
        raise RuntimeError("Unexpected FFmpeg binary license.")
    (evidence / "binary-license.txt").write_text(license_text, encoding="utf-8")
    return {category: sorted(required) for category, required in requirements.items()}


def smoke_test(directory, env, work):
    started = now()
    output = work / "smoke-videotoolbox.mp4"
    commands = [
        [directory / "ffmpeg", "-hide_banner", "-nostdin", "-v", "warning", "-f", "lavfi", "-i",
         "testsrc2=size=320x180:rate=24:duration=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
         "-c:v", "h264_videotoolbox", "-allow_sw", "1", "-b:v", "2000000", "-profile:v", "high",
         "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-shortest", output],
        [directory / "ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", output],
        [directory / "ffmpeg", "-hide_banner", "-nostdin", "-v", "error", "-i", output, "-f", "null", "-"],
    ]
    receipts = []
    probe = None
    for index, command in enumerate(commands):
        command_started = now()
        result = run(command, env=env, log_path=work / f"smoke-{index + 1}.log")
        receipts.append({"command": [str(item) for item in command], "startedAt": command_started,
                         "finishedAt": now(), "exitCode": 0})
        if index == 1:
            probe = json.loads(result)
    video = next(item for item in probe["streams"] if item["codec_type"] == "video")
    audio = next(item for item in probe["streams"] if item["codec_type"] == "audio")
    if video["codec_name"] != "h264" or audio["codec_name"] != "aac" or int(video["nb_frames"]) != 24:
        raise RuntimeError("Synthetic VideoToolbox MP4 failed stream/frame verification.")
    return {"startedAt": started, "finishedAt": now(), "commands": receipts, "media": probe,
            "outputSHA256": sha256(output), "outputPath": str(output)}


def validate_cache(destination, recipe_sha, env):
    receipt_path = destination / "receipt.json"
    if not receipt_path.is_file():
        return False
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    if receipt.get("recipeSHA256") != recipe_sha:
        return False
    if receipt.get("archiveSHA256") != DOWNLOADS[f"ffmpeg-{VERSION}.tar.xz"][1]:
        return False
    for relative, expected in receipt.get("fileSHA256", {}).items():
        path = destination / relative
        if not path.is_file() or sha256(path) != expected:
            return False
    if not {"ffmpeg", "ffprobe"}.issubset(receipt.get("fileSHA256", {})):
        return False
    inspect_runtime(destination, env)
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, default=Path(__file__).resolve().parent.parent / ".local" / "ffmpeg-runtime")
    parser.add_argument("--offline", action="store_true", help="Use pinned archives from the cache or alongside this script.")
    parser.add_argument("--jobs", type=int, default=min(os.cpu_count() or 4, 12))
    args = parser.parse_args()
    architecture = {"arm64": "arm64", "x86_64": "x86_64"}.get(platform.machine())
    if sys.platform != "darwin" or architecture is None:
        raise RuntimeError("Build on an Apple Silicon or Intel Mac with Xcode installed.")
    if args.jobs < 1:
        raise RuntimeError("--jobs must be positive.")
    developer = os.environ.get("DEVELOPER_DIR")
    if not developer:
        xcode = Path("/Applications/Xcode.app/Contents/Developer")
        developer = str(xcode) if xcode.is_dir() else subprocess.check_output(["/usr/bin/xcode-select", "-p"], text=True).strip()
    # No Homebrew compiler, include paths, linker flags, or DYLD overrides enter the build.
    env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "C", "LC_ALL": "C",
           "DEVELOPER_DIR": developer, "MACOSX_DEPLOYMENT_TARGET": DEPLOYMENT_TARGET}
    cache = args.cache_dir.resolve()
    cache.mkdir(parents=True, exist_ok=True)
    downloads = cache / "downloads"
    downloads.mkdir(exist_ok=True)
    for name in DOWNLOADS:
        fetch(name, downloads, args.offline)
    recipe_sha = sha256(__file__)
    destination = cache / f"ffmpeg-{VERSION}-darwin-{architecture}-macos14-{recipe_sha[:12]}"
    if validate_cache(destination, recipe_sha, env):
        log(f"Verified cached runtime: {destination}")
        print(destination)
        return
    if destination.exists():
        raise RuntimeError(f"Existing runtime differs or is incomplete; preserved for inspection: {destination}")
    # FFmpeg's Makefiles reject whitespace in source paths. Preserve this isolated
    # short build directory on success and failure; never clean another build.
    work = Path(tempfile.mkdtemp(prefix="motionboard-ffmpeg-", dir="/tmp")).resolve()
    started = now()
    log(f"Build files and logs: {work}")
    signature = verify_signature(downloads, work, env)
    source = extract_source(downloads / f"ffmpeg-{VERSION}.tar.xz", work)
    build = work / "build"
    build.mkdir()
    stage = work / "runtime"
    stage.mkdir()
    evidence = stage / "redistribution"
    evidence.mkdir()
    sdk = run(["/usr/bin/xcrun", "--sdk", "macosx", "--show-sdk-path"], env=env).strip()
    compiler = "/usr/bin/clang"
    options = [
        "--prefix=/opt/motionboard-ffmpeg", "--target-os=darwin", f"--arch={architecture}", f"--cc={compiler}",
        "--cxx=/usr/bin/clang++", f"--host-cc={compiler}",
        f"--sysroot={sdk}", f"--extra-cflags=-mmacosx-version-min={DEPLOYMENT_TARGET}",
        f"--extra-ldflags=-mmacosx-version-min={DEPLOYMENT_TARGET}",
        f"--host-cflags=-isysroot {sdk} -mmacosx-version-min={DEPLOYMENT_TARGET}",
        f"--host-ldflags=-isysroot {sdk} -mmacosx-version-min={DEPLOYMENT_TARGET}",
        "--disable-autodetect", "--disable-gpl", "--disable-nonfree", "--disable-version3",
        "--disable-shared", "--enable-static", "--disable-debug", "--disable-doc", "--disable-ffplay",
        "--disable-indevs", "--disable-outdevs", "--enable-indev=lavfi", "--enable-videotoolbox",
        "--enable-audiotoolbox", "--enable-zlib", "--enable-securetransport",
    ]
    if architecture == "x86_64":
        # macOS does not ship nasm; keep Intel rebuilds free of package-manager prerequisites.
        options.append("--disable-x86asm")
    command = [str(Path("..") / source.name / "configure"), *options]
    run(command, env=env, cwd=build, log_path=work / "configure.log")
    run(["/usr/bin/make", f"-j{args.jobs}", "ffmpeg", "ffprobe"], env=env, cwd=build, log_path=work / "make.log")
    for name in ("ffmpeg", "ffprobe"):
        shutil.copy2(build / name, stage / name)
        (stage / name).chmod(0o755)
    inspection = inspect_runtime(stage, env)
    capabilities = check_capabilities(stage, env, evidence)
    smoke = smoke_test(stage, env, work)
    for name in DOWNLOADS:
        shutil.copy2(downloads / name, evidence / name)
    for name in ("LICENSE.md", "COPYING.LGPLv2.1", "COPYING.LGPLv3", "CREDITS"):
        shutil.copy2(source / name, evidence / name)
    if sha256(__file__) != recipe_sha:
        raise RuntimeError("Build recipe changed during execution; preserve this build and rerun the current recipe.")
    shutil.copy2(__file__, evidence / "prepare-ffmpeg-runtime.py")
    for original, name in [(build / "config.h", "config.h"), (build / "ffbuild" / "config.mak", "config.mak"),
                           (work / "configure.log", "configure.log")]:
        (evidence / name).write_text(public_copy_text(original.read_text(encoding="utf-8"), work), encoding="utf-8")
    if signature["verified"]:
        (evidence / "signature-verification.txt").write_text(
            public_copy_text((work / "signature-verification.txt").read_text(encoding="utf-8"), work), encoding="utf-8")
    write_json(evidence / "smoke-test.json", json.loads(public_copy_text(json.dumps(smoke), work)))
    write_json(evidence / "build-configuration.json", {"configure": [str(item) for item in command],
               "build": ["/usr/bin/make", f"-j{args.jobs}", "ffmpeg", "ffprobe"],
               "deploymentTarget": DEPLOYMENT_TARGET, "pathNormalization": "/tmp/motionboard-ffmpeg-build denotes the original isolated build root",
               "compiler": public_copy_text(run([compiler, "--version"], env=env), work), "sourceModifications": []})
    (evidence / "REBUILD.md").write_text(
        f"# FFmpeg {VERSION} runtime\n\n"
        "MotionBoard Studio runs these independent FFmpeg and FFprobe command-line tools as subprocesses. "
        "The application is not linked against FFmpeg libraries. The tools statically include FFmpeg's own libraries "
        "and link only to macOS system libraries and Apple frameworks. No GPL, nonfree, libx264, or third-party external libraries are enabled.\n\n"
        "FFmpeg is Copyright (c) the FFmpeg developers and is distributed under the GNU Lesser General Public License, "
        "version 2.1 or later. See LICENSE.md, COPYING.LGPLv2.1, CREDITS, and the complete accompanying source archive. "
        "This software is based in part on the work of the Independent JPEG Group. No upstream source files were modified.\n\n"
        "The exact upstream source archive, its detached signature, public signing key, build recipe, configure arguments, "
        "generated configuration and verification records are included in this directory. See build-configuration.json "
        "for the original compiler and SDK. Private paths in the generated configuration and verification records "
        "are normalized to /tmp/motionboard-ffmpeg-build or /Users/BUILD_USER; raw logs remain only on the build machine.\n\n"
        "To rebuild on the same architecture with Python 3.9 or newer and Xcode installed, run from this directory:\n\n"
        "```sh\npython3 prepare-ffmpeg-runtime.py --cache-dir ./rebuilt-runtime --offline\n```\n\n"
        "GPG, when installed, verifies the signature using an isolated temporary keyring. Every build checks pinned "
        "SHA256 values for the archive, signature and public key even when GPG is unavailable. Build logs and source "
        "remain in a unique /tmp/motionboard-ffmpeg-* directory. The script prints the completed runtime directory. "
        "No Homebrew libraries are required to build or run the tools. Xcode's Python or another Python 3.9+ can run this script.\n\n"
        "Replace the ffmpeg and ffprobe executables in the application bundle's Contents/MacOS directory "
        "to use rebuilt versions. Changing a signed app bundle invalidates its code signature; rebuilding and signing "
        "the application produces a new signature. There is no technical lock preventing replacement of these tools.\n\n"
        "Official sources: https://ffmpeg.org/download.html and https://ffmpeg.org/legal.html\n",
        encoding="utf-8",
    )
    receipt = {"version": VERSION, "architecture": architecture, "deploymentTarget": DEPLOYMENT_TARGET,
               "startedAt": started, "finishedAt": now(), "recipeSHA256": recipe_sha,
               "archiveSHA256": DOWNLOADS[f"ffmpeg-{VERSION}.tar.xz"][1],
               "sources": {name: {"url": url, "sha256": digest} for name, (url, digest) in DOWNLOADS.items()},
               "signature": signature, "sourceModifications": [], "buildDirectory": str(work),
               "license": "LGPL-2.1-or-later", "capabilities": capabilities, **inspection,
               "binarySHA256": {name: sha256(stage / name) for name in ("ffmpeg", "ffprobe")}}
    public_receipt = dict(receipt)
    public_receipt.pop("buildDirectory")
    write_json(evidence / "provenance.json", public_receipt)
    receipt["fileSHA256"] = {str(path.relative_to(stage)): sha256(path) for path in sorted(stage.rglob("*")) if path.is_file()}
    write_json(stage / "receipt.json", receipt)
    # Copy through an invocation-owned staging directory; expose a completed cache atomically.
    publishing = destination.with_name(destination.name + "." + uuid.uuid4().hex + ".staging")
    shutil.copytree(stage, publishing)
    publishing.rename(destination)
    log(f"Verified LGPL runtime ready: {destination}")
    print(destination)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        log(f"FFmpeg runtime preparation failed: {error}")
        raise SystemExit(1)
