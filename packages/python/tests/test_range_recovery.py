from __future__ import annotations

import hashlib
import http.server
import io
import os
import tempfile
import threading
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

from slybrowser import service
from slybrowser.errors import ArtifactError, LicenseServiceError
from slybrowser.manifest import ReleaseArtifact, verify_artifact


DATA = b"strict-signed-range-recovery"
URL = "https://downloads.slybrowser.com/archive"


class Response:
    def __init__(self, body, status=200, headers=None):
        self.stream = io.BytesIO(body)
        self.status = status
        self.headers = headers or {}

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.stream.close()

    def read(self, size):
        return self.stream.read(size)


def ranged(start, body=None, **headers):
    return Response(DATA[start:] if body is None else body, 206, {
        "Content-Range": f"bytes {start}-{len(DATA)-1}/{len(DATA)}", **headers,
    })


class RangeUnitTests(unittest.TestCase):
    def exercise(self, responses, *, success=True, headers=None):
        with tempfile.TemporaryDirectory() as folder, mock.patch.object(service.time, "sleep"):
            target = Path(folder) / "artifact.part"
            requests = []
            iterator = iter(responses)

            def open_response(request, **kwargs):
                requests.append((request, kwargs))
                result = next(iterator)
                if isinstance(result, BaseException):
                    raise result
                return result

            with mock.patch.object(service._NO_REDIRECT_OPENER, "open", side_effect=open_response):
                if success:
                    service._default_artifact_downloader(URL, headers or {}, target, expected_size=len(DATA))
                    self.assertEqual(target.read_bytes(), DATA)
                else:
                    with self.assertRaises(LicenseServiceError):
                        service._default_artifact_downloader(URL, headers or {}, target, expected_size=len(DATA))
                    self.assertFalse(target.exists())
            return requests

    def test_three_partial_responses_resume_at_exact_owned_offsets(self):
        calls = self.exercise([Response(DATA[:3]), ranged(3, DATA[3:8]), ranged(8)])
        self.assertEqual([r.get_header("Range") for r, _ in calls], [None, "bytes=3-", "bytes=8-"])

    def test_ignored_range_200_restarts_instead_of_concatenating(self):
        calls = self.exercise([Response(DATA[:3]), Response(DATA)])
        self.assertEqual(calls[1][0].get_header("Range"), "bytes=3-")

    def test_ignored_range_partial_resets_the_next_offset(self):
        calls = self.exercise([Response(DATA[:8]), Response(DATA[:3]), ranged(3)])
        self.assertEqual(calls[2][0].get_header("Range"), "bytes=3-")

    def test_range_header_must_match_start_end_total_and_length(self):
        invalid = [
            {"Content-Range": f"bytes 2-{len(DATA)-1}/{len(DATA)}"},
            {"Content-Range": f"bytes 3-{len(DATA)-2}/{len(DATA)}"},
            {"Content-Range": f"bytes 3-{len(DATA)-1}/{len(DATA)+1}"},
            {"Content-Range": "bytes */27"},
            {"Content-Range": "bytes 3-26/*"},
            {"Content-Range": "items 3-26/27"},
            {"Content-Range": "bytes 3-26/27 extra"},
            {"Content-Length": "not-an-integer"},
            {"Content-Length": str(len(DATA))},
            {"Content-Encoding": "gzip"},
        ]
        for headers in invalid:
            with self.subTest(headers=headers):
                calls = self.exercise([Response(DATA[:3]), ranged(3, **headers)], success=False)
                self.assertEqual(len(calls), 2)

    def test_missing_range_header_is_terminal(self):
        self.assertEqual(len(self.exercise([Response(DATA[:3]), Response(DATA[3:], 206)], success=False)), 2)

    def test_unsolicited_partial_response_is_terminal(self):
        self.assertEqual(len(self.exercise([ranged(0)], success=False)), 1)

    def test_full_response_cannot_carry_a_content_range(self):
        self.exercise([Response(DATA, headers={"Content-Range": f"bytes 0-{len(DATA)-1}/{len(DATA)}"})], success=False)

    def test_full_content_length_must_match_signed_size(self):
        self.exercise([Response(DATA, headers={"Content-Length": str(len(DATA)+1)})], success=False)

    def test_oversized_range_body_fails_without_another_attempt(self):
        calls = self.exercise([Response(DATA[:3]), ranged(3, DATA[3:] + b"extra")], success=False)
        self.assertEqual(len(calls), 2)

    def test_three_incomplete_ranges_fail_and_remove_owned_file(self):
        calls = self.exercise([Response(DATA[:3]), ranged(3, DATA[3:6]), ranged(6, DATA[6:9])], success=False)
        self.assertEqual(len(calls), 3)
        self.assertEqual(calls[-1][0].get_header("Range"), "bytes=6-")

    def test_retryable_http_error_preserves_offset_and_headers(self):
        retry = urllib.error.HTTPError(URL, 503, "busy", {}, io.BytesIO(b"{}"))
        calls = self.exercise([Response(DATA[:3]), retry, ranged(3)], headers={"Authorization": "Bearer fixture"})
        self.assertEqual([r.get_header("Range") for r, _ in calls], [None, "bytes=3-", "bytes=3-"])
        self.assertTrue(all(r.get_header("Authorization") == "Bearer fixture" for r, _ in calls))

    def test_range_not_satisfiable_is_terminal(self):
        error = urllib.error.HTTPError(URL, 416, "invalid range", {}, io.BytesIO(b"{}"))
        self.assertEqual(len(self.exercise([Response(DATA[:3]), error], success=False)), 2)

    def test_existing_destination_is_preserved(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "artifact.part"
            target.write_bytes(b"existing")
            with self.assertRaises(FileExistsError):
                service._default_artifact_downloader(URL, {}, target, expected_size=len(DATA))
            self.assertEqual(target.read_bytes(), b"existing")

    def test_total_deadline_is_not_reset_on_resume(self):
        with mock.patch.object(service.time, "monotonic", side_effect=iter(range(1000))):
            calls = self.exercise([Response(DATA[:3]), ranged(3)])
        self.assertEqual(calls[1][0].get_header("Range"), "bytes=3-")
        self.assertLess(calls[1][1]["timeout"], calls[0][1]["timeout"])

    def test_caller_cannot_supply_an_unsigned_range(self):
        self.exercise([], success=False, headers={"Range": "bytes=100-"})

    def test_resumed_bytes_still_require_final_signed_hash(self):
        with tempfile.TemporaryDirectory() as folder, mock.patch.object(service.time, "sleep"):
            target = Path(folder) / "artifact.part"
            with mock.patch.object(service._NO_REDIRECT_OPENER, "open", side_effect=[Response(DATA[:3]), ranged(3, b"x" * (len(DATA)-3))]):
                service._default_artifact_downloader(URL, {}, target, expected_size=len(DATA))
            value = ReleaseArtifact("windows", "x64", URL, hashlib.sha256(DATA).hexdigest(), len(DATA), "7z", "Browser.exe", "Driver.exe", "0"*64, "1"*64, (), ())
            with self.assertRaises(ArtifactError) as failure:
                verify_artifact(target, value)
            self.assertEqual(failure.exception.code, "artifact_hash_mismatch")


def real_transfer(test, payload, expected_sha256, first_end, second_end):
    seen = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            requested = self.headers.get("Range")
            start = int(requested.removeprefix("bytes=").removesuffix("-")) if requested else 0
            seen.append(start)
            self.send_response(206 if requested else 200)
            if requested:
                self.send_header("Content-Range", f"bytes {start}-{len(payload)-1}/{len(payload)}")
            self.send_header("Content-Length", str(len(payload)-start))
            self.end_headers()
            end = first_end if len(seen) == 1 else second_end if len(seen) == 2 else len(payload)
            self.wfile.write(payload[start:end])
            self.close_connection = True

        def log_message(self, *_):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        with tempfile.TemporaryDirectory() as folder, mock.patch.object(service.time, "sleep"):
            target = Path(folder) / "artifact.part"
            url = f"http://127.0.0.1:{server.server_port}/archive"
            service._default_artifact_downloader(url, {}, target, expected_size=len(payload))
            value = ReleaseArtifact("windows", "x64", url, expected_sha256, len(payload), "7z", "Browser.exe", "Driver.exe", "0"*64, "1"*64, (), ())
            verify_artifact(target, value)
            test.assertEqual(target.read_bytes(), payload)
            test.assertEqual(seen, [0, first_end, second_end])
    finally:
        server.shutdown()
        server.server_close()
        worker.join()


class RangeHTTPIntegrationTests(unittest.TestCase):
    def test_real_http_two_partial_closes_then_range_completion(self):
        payload = b"actual-http-range" * 4096
        real_transfer(self, payload, hashlib.sha256(payload).hexdigest(), 12000, 24000)


class RangeSignedArchiveE2ETests(unittest.TestCase):
    def test_real_http_official_archive_partial_transfer_then_exact_signed_hash(self):
        archive = os.environ.get("SLY_TEST_ARTIFACT")
        expected = os.environ.get("SLY_TEST_ARTIFACT_EXPECTED_SHA256")
        if not archive or not expected:
            self.skipTest("Requires an independently pinned official archive for the large transfer case")
        payload = Path(archive).read_bytes()
        self.assertEqual(hashlib.sha256(payload).hexdigest(), expected)
        self.assertGreater(len(payload), 32 * 1024 * 1024)
        real_transfer(self, payload, expected, len(payload)-20*1024*1024, len(payload)-8*1024*1024)
