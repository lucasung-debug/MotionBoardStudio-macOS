"""Offline regressions for release authorization and interrupted submissions."""
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('release_macos', Path(__file__).resolve().parents[1] / 'scripts/release-macos.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseGuards(unittest.TestCase):
    def test_development_certificate_cannot_authorize_distribution(self):
        with patch.object(release, 'run', return_value='1) ' + 'A' * 40 + ' "Apple Development: Example (TEST)"'):
            with self.assertRaisesRegex(RuntimeError, 'found 0'):
                release.signing_identity(None)

    def test_multiple_developer_teams_require_an_exact_identity(self):
        identities = ('1) ' + 'A' * 40 + ' "Developer ID Application: One (ONE)"\n'
                      '2) ' + 'B' * 40 + ' "Developer ID Application: Two (TWO)"')
        with patch.object(release, 'run', return_value=identities):
            with self.assertRaisesRegex(RuntimeError, 'found 2'):
                release.signing_identity(None)
            self.assertEqual(release.signing_identity('b' * 40), 'B' * 40)

    def test_path_named_runtime_does_not_satisfy_hardened_runtime_requirement(self):
        metadata = ('Executable=/tmp/runtime/MotionBoardStudio\n'
                    'CodeDirectory v=20400 size=100 flags=0x0(none) hashes=1+1\n'
                    'TeamIdentifier=EXAMPLE\nTimestamp=Sep 27, 2026\n')
        with patch.object(release, 'run'), patch.object(release.subprocess, 'run', return_value=SimpleNamespace(stderr=metadata)):
            with self.assertRaisesRegex(RuntimeError, 'Missing hardened runtime'):
                release.verify_developer_id(Path('/tmp/runtime/Test.app'))

    def test_unconfirmed_upload_is_preserved_without_resubmission(self):
        with tempfile.TemporaryDirectory() as temporary:
            work = Path(temporary)
            archive = work / 'app.zip'
            archive.write_bytes(b'fixture')
            marker = work / 'app-submission.json'
            marker.write_bytes(b'')
            with patch.object(release, 'run') as command, patch.object(release.subprocess, 'run') as upload:
                with self.assertRaisesRegex(RuntimeError, 'unconfirmed'):
                    release.notarize(archive, 'app', work, {'profile': 'fixture'}, lambda: None)
                command.assert_not_called()
                upload.assert_not_called()
            self.assertEqual(marker.read_bytes(), b'')

    def test_changed_submitted_archive_is_rejected_before_network_access(self):
        with tempfile.TemporaryDirectory() as temporary:
            work = Path(temporary)
            archive = work / 'app.zip'
            archive.write_bytes(b'changed')
            state = {'profile': 'fixture', 'app_submission': {'id': 'fixture-id', 'sha256': '0' * 64}}
            with patch.object(release, 'run') as command:
                with self.assertRaisesRegex(RuntimeError, 'changed after submission'):
                    release.notarize(archive, 'app', work, state, lambda: None)
                command.assert_not_called()

    def test_accepted_resume_uses_existing_submission_and_checks_apple_hash(self):
        with tempfile.TemporaryDirectory() as temporary:
            work = Path(temporary)
            archive = work / 'app.zip'
            archive.write_bytes(b'fixture')
            sha256 = release.digest(archive)
            state = {'profile': 'fixture', 'app_submission': {'id': 'fixture-id', 'sha256': sha256}}
            responses = [json.dumps({'status': 'Accepted'}), json.dumps({'sha256': sha256})]
            with patch.object(release, 'run', side_effect=responses) as command, patch.object(release.subprocess, 'run') as upload:
                release.notarize(archive, 'app', work, state, lambda: None)
                self.assertEqual([call.args[2] for call in command.call_args_list], ['info', 'log'])
                upload.assert_not_called()

    def test_accepted_status_for_wrong_bytes_cannot_complete_release(self):
        with tempfile.TemporaryDirectory() as temporary:
            work = Path(temporary)
            archive = work / 'app.zip'
            archive.write_bytes(b'fixture')
            state = {'profile': 'fixture', 'app_submission': {'id': 'fixture-id', 'sha256': release.digest(archive)}}
            responses = [json.dumps({'status': 'Accepted'}), json.dumps({'sha256': '0' * 64})]
            with patch.object(release, 'run', side_effect=responses):
                with self.assertRaisesRegex(RuntimeError, 'does not match'):
                    release.notarize(archive, 'app', work, state, lambda: None)

    def test_rejected_submission_preserves_apples_diagnostic_log(self):
        with tempfile.TemporaryDirectory() as temporary:
            work = Path(temporary)
            archive = work / 'app.zip'
            archive.write_bytes(b'fixture')
            state = {'profile': 'fixture', 'app_submission': {'id': 'fixture-id', 'sha256': release.digest(archive)}}
            diagnostic = {'status': 'Invalid', 'issues': [{'message': 'Fixture signing error'}]}
            with patch.object(release, 'run', side_effect=[json.dumps({'status': 'Invalid'}), json.dumps(diagnostic)]):
                with self.assertRaisesRegex(RuntimeError, 'did not accept'):
                    release.notarize(archive, 'app', work, state, lambda: None)
            self.assertEqual(json.loads((work / 'app-notary-log.json').read_text()), diagnostic)


if __name__ == '__main__':
    unittest.main()
