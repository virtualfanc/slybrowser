from __future__ import annotations

import io
import http.server
import tempfile
import threading
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

from slybrowser import service
from slybrowser.errors import LicenseServiceError


class _Response:
    status = 200

    def __init__(self, data: bytes, fail_after_first_read: bool = False) -> None:
        self._stream = io.BytesIO(data)
        self._fail_after_first_read = fail_after_first_read
        self._reads = 0

    def __enter__(self) -> "_Response":
        return self

    def __exit__(self, *_args: object) -> None:
        self._stream.close()

    def read(self, size: int) -> bytes:
        self._reads += 1
        if self._fail_after_first_read and self._reads > 1:
            raise OSError("connection reset")
        return self._stream.read(size)


class ArtifactDownloadPolicyTests(unittest.TestCase):
    def test_destination_open_failure_is_terminal(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            destination = Path(root) / "artifact.part"
            with mock.patch.object(service._NO_REDIRECT_OPENER, "open", side_effect=lambda *_args, **_kwargs: _Response(b"ok")) as opener, mock.patch.object(Path, "open", side_effect=OSError("disk full")), mock.patch.object(service.time, "sleep"):
                with self.assertRaises(LicenseServiceError) as error:
                    service._default_artifact_downloader("https://api.slybrowser.test/archive", {}, destination)
            self.assertEqual(error.exception.code, "artifact_download_failed")
            self.assertEqual(opener.call_count, 1)
            self.assertFalse(destination.exists())

    def test_destination_write_failure_is_terminal(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            destination = Path(root) / "artifact.part"
            output = mock.Mock()
            output.write.side_effect = OSError("disk full")
            with mock.patch.object(service._NO_REDIRECT_OPENER, "open", side_effect=lambda *_args, **_kwargs: _Response(b"ok")) as opener, mock.patch.object(Path, "open", return_value=output), mock.patch.object(service.time, "sleep"):
                with self.assertRaises(LicenseServiceError) as error:
                    service._default_artifact_downloader("https://api.slybrowser.test/archive", {}, destination)
            self.assertEqual(error.exception.code, "artifact_download_failed")
            self.assertEqual(opener.call_count, 1)
            self.assertFalse(destination.exists())

    def test_real_http_boundary_retries_503_and_stops_on_403(self) -> None:
        statuses = [503, 200, 403]

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                status = statuses.pop(0)
                self.send_response(status)
                self.end_headers()
                self.wfile.write(b"verified" if status == 200 else b"{}")

            def log_message(self, *_args: object) -> None:
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            with tempfile.TemporaryDirectory() as root, mock.patch.object(service.time, "sleep"):
                destination = Path(root) / "artifact.part"
                url = f"http://127.0.0.1:{server.server_port}/archive"
                service._default_artifact_downloader(url, {}, destination)
                self.assertEqual(destination.read_bytes(), b"verified")
                destination.unlink()
                with self.assertRaises(LicenseServiceError) as error:
                    service._default_artifact_downloader(url, {}, destination)
                self.assertEqual(error.exception.status, 403)
                self.assertFalse(destination.exists())
                self.assertEqual(statuses, [])
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=5)

    def test_retry_replaces_partial_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            destination = Path(root) / "artifact.part"
            with mock.patch.object(service._NO_REDIRECT_OPENER, "open", side_effect=[
                _Response(b"old", fail_after_first_read=True), _Response(b"verified")
            ]) as opener, mock.patch.object(service.time, "sleep"):
                service._default_artifact_downloader("https://api.slybrowser.test/archive", {}, destination)
            self.assertEqual(destination.read_bytes(), b"verified")
            self.assertEqual(opener.call_count, 2)

    def test_retry_transient_http_but_not_denial(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            destination = Path(root) / "artifact.part"
            unavailable = urllib.error.HTTPError("https://api.slybrowser.test/archive", 503, "unavailable", {}, io.BytesIO(b"{}"))
            denied = urllib.error.HTTPError("https://api.slybrowser.test/archive", 403, "denied", {}, io.BytesIO(b"{}"))
            with mock.patch.object(service._NO_REDIRECT_OPENER, "open", side_effect=[unavailable, _Response(b"ok")]) as opener, mock.patch.object(service.time, "sleep"):
                service._default_artifact_downloader("https://api.slybrowser.test/archive", {}, destination)
            self.assertEqual(destination.read_bytes(), b"ok")
            self.assertEqual(opener.call_count, 2)
            destination.unlink()
            with mock.patch.object(service._NO_REDIRECT_OPENER, "open", side_effect=denied) as opener:
                with self.assertRaises(LicenseServiceError) as error:
                    service._default_artifact_downloader("https://api.slybrowser.test/archive", {}, destination)
            self.assertEqual(error.exception.status, 403)
            self.assertEqual(opener.call_count, 1)
            self.assertFalse(destination.exists())
