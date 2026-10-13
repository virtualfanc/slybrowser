from __future__ import annotations

import hashlib
import http.server
import io
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from slybrowser import service
from slybrowser.errors import LicenseServiceError
from slybrowser.manifest import ReleaseArtifact, verify_artifact

PAYLOAD = b"signed-artifact-fixture"
PUBLIC_URL = "https://downloads.slybrowser.com/github.com/virtualfanc/slybrowser/releases/download/sdk-v0.2.1/slybrowser-148.0.7778.179-win-x64.7z"


def artifact(url: str = PUBLIC_URL) -> ReleaseArtifact:
    digest = hashlib.sha256(PAYLOAD).hexdigest()
    return ReleaseArtifact("windows", "x64", url, digest, len(PAYLOAD), "7z", "Browser.exe", "Driver.exe", "0" * 64, "1" * 64, (), ())


def client(base: str = "https://api.slybrowser.com", downloader=None):
    result = service.LicenseServiceClient.__new__(service.LicenseServiceClient)
    result.authorization = SimpleNamespace(service_url=base)
    result._artifact_downloader = downloader or service._default_artifact_downloader
    return result


def runtime_grant():
    return SimpleNamespace(artifact=artifact(), browser_version="148.0.7778.179", download_ticket=SimpleNamespace(artifact_url=PUBLIC_URL))


class Response:
    status = 200

    def __init__(self, data):
        self.stream = io.BytesIO(data)

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.stream.close()

    def read(self, size):
        return self.stream.read(size)


class ShortStreamUnitTests(unittest.TestCase):
    def test_clean_short_eof_retries_then_returns_complete_signed_bytes(self):
        with tempfile.TemporaryDirectory() as root, mock.patch.object(service.time, "sleep"):
            target = Path(root) / "artifact.part"
            with mock.patch.object(service._NO_REDIRECT_OPENER, "open", side_effect=[Response(PAYLOAD[:3]), Response(PAYLOAD)]) as requests:
                client().download_runtime_artifact(runtime_grant(), target)
            self.assertEqual(target.read_bytes(), PAYLOAD)
            self.assertEqual(requests.call_count, 2)
            self.assertNotIn("Authorization", requests.call_args.args[0].headers)

    def test_three_short_eofs_fail_closed_and_remove_only_attempt_file(self):
        with tempfile.TemporaryDirectory() as root, mock.patch.object(service.time, "sleep"):
            target = Path(root) / "artifact.part"
            with mock.patch.object(service._NO_REDIRECT_OPENER, "open", side_effect=lambda *_a, **_k: Response(PAYLOAD[:3])) as requests:
                with self.assertRaises(LicenseServiceError) as error:
                    client().download_runtime_artifact(runtime_grant(), target)
            self.assertEqual(error.exception.code, "artifact_size_mismatch")
            self.assertEqual(requests.call_count, 3)
            self.assertFalse(target.exists())

    def test_oversized_body_is_terminal(self):
        with tempfile.TemporaryDirectory() as root, mock.patch.object(service.time, "sleep"):
            target = Path(root) / "artifact.part"
            with mock.patch.object(service._NO_REDIRECT_OPENER, "open", side_effect=lambda *_a, **_k: Response(PAYLOAD + b"extra")) as requests:
                with self.assertRaises(LicenseServiceError) as error:
                    client().download_runtime_artifact(runtime_grant(), target)
            self.assertEqual(error.exception.code, "artifact_size_mismatch")
            self.assertEqual(requests.call_count, 1)
            self.assertFalse(target.exists())

    def test_custom_downloader_keeps_three_argument_callback(self):
        calls = []

        def custom(url, headers, destination):
            calls.append((url, headers, destination))
            destination.write_bytes(PAYLOAD)

        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / "artifact.part"
            client(downloader=custom).download_runtime_artifact(runtime_grant(), target)
            self.assertEqual(target.read_bytes(), PAYLOAD)
            self.assertEqual(len(calls), 1)


class ShortStreamHTTPTests(unittest.TestCase):
    def test_real_http_clean_premature_close_recovers(self):
        self._exercise(False)

    def _exercise(self, verify):
        seen = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                seen.append(self.path)
                self.send_response(200)
                self.send_header("Content-Length", str(len(PAYLOAD)))
                self.end_headers()
                self.wfile.write(PAYLOAD[:3] if len(seen) == 1 else PAYLOAD)
                self.close_connection = True

            def log_message(self, *_args):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            with tempfile.TemporaryDirectory() as root, mock.patch.object(service.time, "sleep"):
                target = Path(root) / "artifact.part"
                base = f"http://127.0.0.1:{server.server_port}"
                value = artifact(base + "/archive")
                grant = SimpleNamespace(artifact=value, browser_version="148.0.7778.179", session_token="public-test-fixture")
                client(base).download_artifact(grant, target)
                if verify:
                    verify_artifact(target, value)
                self.assertEqual(target.read_bytes(), PAYLOAD)
                self.assertEqual(len(seen), 2)
        finally:
            server.shutdown()
            server.server_close()
            worker.join()


class ShortStreamDeliveryE2ETests(ShortStreamHTTPTests):
    def test_public_client_real_transfer_then_signed_size_and_hash_verification(self):
        self._exercise(True)
