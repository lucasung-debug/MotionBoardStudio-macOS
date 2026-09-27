#!/usr/bin/env python3
"""Build and validate a Developer ID release; never publish an unchecked DMG.

Authentication is supplied through a named notarytool Keychain profile. This
script never reads its password. Apple submissions are recorded before waiting
and can be resumed without submitting the same archive again.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent
IDENTIFIER = 'io.github.lucasung-debug.motionboardstudio'
HELPERS = ('node', 'ffmpeg', 'ffprobe')


def run(*args, capture=False, env=None):
    return subprocess.run([str(arg) for arg in args], check=True, text=True,
                          capture_output=capture, env=env).stdout


def digest(path):
    result = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def write_json(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.replace(path)


def signing_identity(hint):
    output = run('/usr/bin/security', 'find-identity', '-v', '-p', 'codesigning', capture=True)
    identities = re.findall(r'([0-9A-Fa-f]{40}) "(Developer ID Application: [^"\n]+)"', output)
    if hint:
        identities = [item for item in identities if hint.lower() == item[0].lower() or hint == item[1]]
    if len(identities) != 1:
        raise RuntimeError(f'Expected one valid Developer ID Application identity; found {len(identities)}. '
                           'Create one in Xcode, or select an exact certificate SHA1 using --identity.')
    return identities[0][0]


def sign_bundle(app, identity, *, timestamp=True):
    # Used with an ad-hoc identity only by isolated hardened-runtime checks.
    # The release entry point always resolves a real Developer ID identity.
    options = ['--force', '--sign', identity, '--options', 'runtime']
    options += ['--timestamp'] if timestamp else ['--timestamp=none']
    for name in HELPERS:
        arguments = ['codesign', *options, '--identifier', f'{IDENTIFIER}.{name}']
        if name == 'node':
            arguments += ['--entitlements', ROOT / 'scripts/installer/Node-entitlements.plist']
        run(*arguments, app / 'Contents/MacOS' / name)
    write_json(app / 'Contents/Resources/packaged-binaries.json', {
        'description': 'SHA256 of helper executables after signing. Source/build receipts describe the unsigned inputs.',
        'binaries': {name: digest(app / 'Contents/MacOS' / name) for name in HELPERS},
    })
    run('codesign', *options, app)
    run('codesign', '--verify', '--deep', '--strict', app)


def verify_developer_id(app):
    requirement = 'anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists'
    team = None
    for name in ('MotionBoardStudio', *HELPERS):
        path = app if name == 'MotionBoardStudio' else app / 'Contents/MacOS' / name
        run('codesign', '--verify', '--strict', '--test-requirement', requirement, path)
        result = subprocess.run(['codesign', '-d', '--verbose=4', str(path)],
                                check=True, capture_output=True, text=True)
        details = result.stderr
        found_team = re.search(r'^TeamIdentifier=(\w+)$', details, re.M)
        flags = re.search(r'^CodeDirectory .*?flags=0x([0-9a-fA-F]+)', details, re.M)
        hardened = flags is not None and int(flags[1], 16) & 0x10000
        if not hardened or '\nTimestamp=' not in details or not found_team:
            raise RuntimeError(f'Missing hardened runtime, secure timestamp, or TeamIdentifier: {name}')
        if team and team != found_team[1]:
            raise RuntimeError('All executables must be signed by the same Developer ID team.')
        team = found_team[1]
        entitlements = subprocess.run(['codesign', '-d', '--entitlements', '-', '--xml', str(path)],
                                     check=True, capture_output=True).stdout
        values = plistlib.loads(entitlements) if entitlements.strip() else {}
        expected = {'com.apple.security.cs.allow-jit': True} if name == 'node' else {}
        if values != expected:
            raise RuntimeError(f'Unexpected production entitlements: {name}')
    run('codesign', '--verify', '--deep', '--strict', app)


def notarize(archive, label, work, state, save):
    key = label + '_submission'
    output = work / (label + '-submission.json')
    sha256 = digest(archive)
    if key not in state:
        if output.exists():
            # The marker is created before upload. A failed/ambiguous request
            # must be reconciled, never blindly repeated on --resume.
            try:
                submitted = json.loads(output.read_text())
                submission_id = submitted['id']
            except (ValueError, KeyError):
                raise RuntimeError(f'Upload result is unconfirmed: {output}. '
                                   'Check notarytool history before making another submission.')
        else:
            print(f'Submitting {label} to Apple…', flush=True)
            with output.open('x') as stream:
                subprocess.run(['xcrun', 'notarytool', 'submit', str(archive),
                                '--keychain-profile', state['profile'], '--no-wait',
                                '--output-format', 'json'], stdout=stream, check=True)
            submitted = json.loads(output.read_text())
            submission_id = submitted['id']
        state[key] = {'id': submission_id, 'sha256': sha256}
        save()
    submission = state[key]
    if submission['sha256'] != sha256:
        raise RuntimeError(f'The {label} archive changed after submission; refusing to continue.')
    deadline = time.monotonic() + 900
    while True:
        info = json.loads(run('xcrun', 'notarytool', 'info', submission['id'],
                              '--keychain-profile', state['profile'], '--output-format', 'json', capture=True))
        write_json(work / (label + '-status.json'), info)
        status = info.get('status')
        print(f'Apple {label} notarization: {status}', flush=True)
        if status != 'In Progress':
            log = run('xcrun', 'notarytool', 'log', submission['id'],
                      '--keychain-profile', state['profile'], capture=True)
            (work / (label + '-notary-log.json')).write_text(log)
        if status == 'Accepted':
            if json.loads(log).get('sha256', '').lower() != sha256:
                raise RuntimeError('The Apple notarization log does not match the submitted archive hash.')
            return
        if status != 'In Progress':
            raise RuntimeError(f'Apple did not accept {label}: {status}; submission {submission["id"]}.')
        if time.monotonic() >= deadline:
            raise RuntimeError('Apple is still processing. Resume this run later; no new upload is needed.')
        time.sleep(30)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', default='MotionBoardStudio', help='notarytool Keychain profile name')
    parser.add_argument('--identity', help='exact Developer ID Application name or SHA1')
    parser.add_argument('--build-number', type=int, default=4)
    parser.add_argument('--check', action='store_true', help='check signing identity and Apple login only')
    parser.add_argument('--resume', type=Path, help='resume the retained .local release work directory')
    args = parser.parse_args()
    os.chdir(ROOT)
    os.environ.setdefault('DEVELOPER_DIR', '/Applications/Xcode.app/Contents/Developer')
    if args.build_number < 1:
        parser.error('--build-number must be positive')
    if args.resume:
        work = args.resume.resolve()
        state = json.loads((work / 'release-state.json').read_text())
        identity = signing_identity(args.identity or state['identity'])
        if state['identity'] != identity:
            raise RuntimeError('The signing identity differs from the saved release run.')
    else:
        identity = signing_identity(args.identity)
        state = {'build_number': args.build_number, 'profile': args.profile, 'identity': identity}
    # notarytool authenticates directly with Apple; never print account history.
    run('xcrun', 'notarytool', 'history', '--keychain-profile', state['profile'],
        '--output-format', 'json', capture=True)
    if args.check:
        print('Developer ID identity and Apple notarization login are available.')
        return
    version = f'0.3.2-mac.{state["build_number"]}'
    filename = f'MotionBoardStudio-{version}-arm64.dmg'
    destination = ROOT / 'dist' / filename
    if (destination.exists() or destination.with_suffix('.dmg.sha256').exists()) and not state.get('export_sha256'):
        raise RuntimeError(f'Output already exists; use a new build number: {destination}')
    if not args.resume:
        (ROOT / '.local').mkdir(exist_ok=True)
        work = Path(tempfile.mkdtemp(prefix=f'release-{version}-', dir=ROOT / '.local'))
    print(f'Release work directory: {work}\nResume: python3 scripts/release-macos.py --resume "{work}"', flush=True)
    save = lambda: write_json(work / 'release-state.json', state)
    save()
    app = work / 'MotionBoard Studio.app'
    environment = os.environ.copy()
    environment['MOTION_BOARD_BUILD_NUMBER'] = str(state['build_number'])
    if not state.get('built'):
        if app.exists():
            app.rename(work / ('incomplete-' + uuid.uuid4().hex + '.app'))
        run(ROOT / 'scripts/build-app.sh', app, env=environment)
        state['built'] = True
        save()
    if not state.get('signed'):
        sign_bundle(app, identity)
        state['signed'] = True
        save()
    verify_developer_id(app)
    if not state.get('runtime_verified'):
        # The fixture mode isolates provider responses, user data, and Keychain.
        verification = Path(tempfile.mkdtemp(prefix='native-check-', dir=work)) / 'results'
        clean = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': str(Path.home())}
        run(app / 'Contents/MacOS/MotionBoardStudio', '--verify-original', '--full-size',
            '--output', verification, env=clean)
        state['runtime_verified'] = str(verification)
        save()
    if not state.get('app_stapled'):
        archive = work / 'application.zip'
        if not archive.exists():
            pending_archive = work / ('archive-' + uuid.uuid4().hex + '.zip')
            run('ditto', '-c', '-k', '--keepParent', app, pending_archive)
            os.link(pending_archive, archive)
        notarize(archive, 'app', work, state, save)
        run('xcrun', 'stapler', 'staple', app)
        state['app_stapled'] = True
        save()
    run('xcrun', 'stapler', 'validate', app)
    run('spctl', '--assess', '--type', 'execute', '--verbose=4', app)
    dmg = work / filename
    if not state.get('dmg_built'):
        if dmg.exists():
            dmg.rename(work / ('incomplete-' + uuid.uuid4().hex + '.dmg'))
        environment['MOTION_BOARD_NOTARIZED'] = '1'
        environment['MOTION_BOARD_DEFER_CHECKSUM'] = '1'
        run(ROOT / 'scripts/build-dmg.sh', app, dmg, env=environment)
        state['dmg_built'] = True
        save()
    if not state.get('dmg_signed'):
        run('codesign', '--force', '--sign', identity, '--timestamp',
            '--identifier', IDENTIFIER + '.dmg', dmg)
        state['dmg_signed'] = True
        save()
    # Keep Apple's submitted bytes immutable. Stapling changes the container;
    # a separate copy lets a resumed run still verify the original upload hash.
    stapled_dmg = work / 'stapled.dmg'
    if not state.get('dmg_stapled'):
        notarize(dmg, 'dmg', work, state, save)
        if not stapled_dmg.exists():
            pending_dmg = work / ('stapling-copy-' + uuid.uuid4().hex + '.dmg')
            run('ditto', dmg, pending_dmg)
            if digest(pending_dmg) != digest(dmg):
                raise RuntimeError('DMG copy checksum mismatch before stapling.')
            os.link(pending_dmg, stapled_dmg)
        run('xcrun', 'stapler', 'staple', stapled_dmg)
        state['dmg_stapled'] = True
        save()
    dmg = stapled_dmg
    run('xcrun', 'stapler', 'validate', dmg)
    run('codesign', '--verify', '--strict', dmg)
    run('hdiutil', 'verify', dmg)
    run('spctl', '--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', dmg)
    mount = Path(tempfile.mkdtemp(prefix='mounted-', dir=work))
    run('hdiutil', 'attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg)
    try:
        mounted_app = mount / 'MotionBoard Studio.app'
        verify_developer_id(mounted_app)
        run('xcrun', 'stapler', 'validate', mounted_app)
        run('spctl', '--assess', '--type', 'execute', '--verbose=4', mounted_app)
    finally:
        run('hdiutil', 'detach', mount)
    destination.parent.mkdir(exist_ok=True)
    sha256 = digest(dmg)
    state['export_sha256'] = sha256
    save()
    if destination.exists():
        if digest(destination) != sha256:
            raise RuntimeError('An existing final DMG differs from this verified release.')
    else:
        exported = work / ('export-' + uuid.uuid4().hex + '.dmg')
        with dmg.open('rb') as source, exported.open('xb') as target:
            shutil.copyfileobj(source, target)
        if digest(exported) != sha256:
            raise RuntimeError('Final DMG copy checksum mismatch.')
        # Atomic and exclusive publication inside this filesystem: recipients
        # never see a partially copied file, and existing outputs are preserved.
        os.link(exported, destination)
    checksum_path = destination.with_suffix('.dmg.sha256')
    expected_checksum = f'{sha256}  {filename}\n'
    if checksum_path.exists():
        if checksum_path.read_text() != expected_checksum:
            raise RuntimeError('An existing final checksum differs from this verified release.')
    else:
        pending_checksum = work / ('checksum-' + uuid.uuid4().hex + '.sha256')
        with pending_checksum.open('x') as checksum:
            checksum.write(expected_checksum)
        os.link(pending_checksum, checksum_path)
    state['verified_output'] = {'path': str(destination), 'sha256': sha256}
    save()
    print(f'Notarized DMG passed local distribution checks: {destination}\nSHA256: {sha256}\n'
          'No GitHub release has been created by this script. Download/install acceptance remains required.')


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, subprocess.CalledProcessError, OSError, ValueError) as error:
        print(f'Release stopped: {error}', file=sys.stderr)
        sys.exit(1)
