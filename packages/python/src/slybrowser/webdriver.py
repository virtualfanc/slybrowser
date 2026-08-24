"""Project-built W3C WebDriver backend used by the default Python launcher."""

from __future__ import annotations

import json
import http.client
import os
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

from .errors import ConfigurationError, WebDriverError
from .launcher import prepare_launch, wait_for_native_ready

ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf"
DEFAULT_EXCLUDED_SWITCHES = ("enable-automation", "enable-unsafe-swiftshader")


def _json_object(value: object) -> Mapping[str, Any] | None:
    return value if isinstance(value, Mapping) else None


def _parse_signed_lease_claims(lease: str | bytes | Mapping[str, Any]) -> Mapping[str, Any] | None:
    import base64

    envelope: object
    try:
        if isinstance(lease, Mapping):
            envelope = lease
        elif isinstance(lease, bytes):
            envelope = json.loads(lease.decode("utf-8"))
        else:
            envelope = json.loads(lease)
    except (UnicodeDecodeError, ValueError, TypeError):
        return None
    payload = _json_object(envelope).get("payload") if _json_object(envelope) is not None else None
    if not isinstance(payload, str) or not payload:
        return None
    try:
        padded = payload + "=" * (-len(payload) % 4)
        return _json_object(json.loads(base64.urlsafe_b64decode(padded).decode("utf-8")))
    except (UnicodeDecodeError, ValueError, TypeError):
        return None


def derive_release_root(browser_executable: str | Path, artifact_browser_executable: object) -> Path | None:
    if not isinstance(artifact_browser_executable, str) or not artifact_browser_executable.strip():
        return None
    expected_parts = [part for part in artifact_browser_executable.replace("\\", "/").split("/") if part]
    if not expected_parts:
        return None
    actual_path = Path(browser_executable).expanduser().resolve()
    actual_parts = [part.lower() for part in actual_path.parts]
    expected_lower = [part.lower() for part in expected_parts]
    if len(actual_parts) < len(expected_lower) or actual_parts[-len(expected_lower):] != expected_lower:
        return None
    release_root = actual_path
    for _ in expected_parts:
        release_root = release_root.parent
    return release_root


def _release_root_from_lease(browser_executable: str | Path, lease: str | bytes | Mapping[str, Any]) -> Path | None:
    claims = _parse_signed_lease_claims(lease)
    artifact = _json_object(claims.get("artifact")) if claims is not None else None
    return derive_release_root(browser_executable, artifact.get("browserExecutable") if artifact is not None else None)


def _validate_mobile_persona(value: Mapping[str, Any]) -> dict[str, Any]:
    user_agent = value.get("userAgent")
    metrics = value.get("deviceMetrics")
    hints = value.get("clientHints")
    valid_metrics = isinstance(metrics, Mapping) and (
        isinstance(metrics.get("width"), int) and 320 <= metrics["width"] <= 4096
        and isinstance(metrics.get("height"), int) and 240 <= metrics["height"] <= 4096
        and isinstance(metrics.get("pixelRatio"), (int, float)) and 0.5 <= metrics["pixelRatio"] <= 8
        and metrics.get("mobile") is True and metrics.get("touch") is True
    )
    if (
        not isinstance(user_agent, str) or not user_agent
        or not valid_metrics
        or not isinstance(hints, Mapping)
        or not isinstance(hints.get("platform"), str) or not hints.get("platform")
        or hints.get("mobile") is not True
    ):
        raise ConfigurationError(
            "Mobile persona must provide one coherent UA, metrics, touch and client-hint set",
            code="mobile_persona_invalid",
        )
    return {
        "userAgent": user_agent,
        "deviceMetrics": dict(metrics),  # type: ignore[arg-type]
        "clientHints": dict(hints),
    }


def _native_profile(profile: Mapping[str, Any] | None, mobile_persona: Mapping[str, Any] | None) -> dict[str, Any]:
    result = dict(profile or {})
    if mobile_persona is None:
        return result
    persona = _validate_mobile_persona(mobile_persona)
    metrics = persona["deviceMetrics"]
    screen = {"width": metrics["width"], "height": metrics["height"]}
    if "userAgent" in result and result["userAgent"] != persona["userAgent"]:
        raise ConfigurationError("Mobile persona conflicts with profile.userAgent", code="mobile_persona_conflict")
    if "screen" in result and result["screen"] != screen:
        raise ConfigurationError("Mobile persona conflicts with profile.screen", code="mobile_persona_conflict")
    result["userAgent"] = persona["userAgent"]
    result["screen"] = screen
    hints = persona["clientHints"]
    if "clientHints" not in result and isinstance(hints.get("brands"), list):
        result["clientHints"] = hints["brands"]
    if "osVersion" not in result and isinstance(hints.get("platformVersion"), str) and hints["platformVersion"]:
        result["osVersion"] = hints["platformVersion"]
    return result


@dataclass(frozen=True, slots=True)
class WebDriverVersions:
    browser_version: str
    driver_version: str
    browser_major: int


@dataclass(frozen=True, slots=True)
class HumanizeConfig:
    mouse_steps_min: int
    mouse_steps_max: int
    mouse_step_delay_min: int
    mouse_step_delay_max: int
    click_hold_min: int
    click_hold_max: int
    key_delay_min: int
    key_delay_max: int
    think_delay_min: int
    think_delay_max: int


_HUMAN_PRESETS = {
    "default": HumanizeConfig(10, 16, 7, 18, 45, 105, 35, 115, 120, 360),
    "careful": HumanizeConfig(10, 16, 8, 24, 65, 145, 55, 155, 220, 620),
}

_HUMAN_ALIASES = {
    "mouseStepsMin": "mouse_steps_min",
    "mouseStepsMax": "mouse_steps_max",
    "mouseStepDelayMin": "mouse_step_delay_min",
    "mouseStepDelayMax": "mouse_step_delay_max",
    "clickHoldMin": "click_hold_min",
    "clickHoldMax": "click_hold_max",
    "keyDelayMin": "key_delay_min",
    "keyDelayMax": "key_delay_max",
    "thinkDelayMin": "think_delay_min",
    "thinkDelayMax": "think_delay_max",
}


def resolve_humanize_config(
    preset: str = "default",
    overrides: Mapping[str, int | float] | None = None,
) -> HumanizeConfig:
    if preset not in _HUMAN_PRESETS:
        raise ConfigurationError(f"Unknown Humanize preset: {preset}", code="humanize_preset_invalid")
    values = {
        field: getattr(_HUMAN_PRESETS[preset], field)
        for field in HumanizeConfig.__dataclass_fields__
    }
    for raw_name, value in (overrides or {}).items():
        name = _HUMAN_ALIASES.get(raw_name, raw_name)
        if name not in values or not isinstance(value, (int, float)) or value < 0:
            raise ConfigurationError(f"Invalid Humanize value for {raw_name}", code="humanize_config_invalid")
        values[name] = int(value)
    if values["mouse_steps_min"] < 6 or values["mouse_steps_max"] < values["mouse_steps_min"]:
        raise ConfigurationError("Humanize requires at least six mouse moves", code="humanize_config_invalid")
    return HumanizeConfig(**values)


def default_driver_executable(
    browser_executable: str | Path,
    explicit: str | Path | None = None,
) -> Path:
    configured = explicit or os.environ.get("SLYBROWSER_WEBDRIVER_PATH")
    if configured:
        return Path(configured).expanduser().resolve()
    name = "chromedriver.exe" if os.name == "nt" else "chromedriver"
    return Path(browser_executable).expanduser().resolve().parent / name


def describe_default_driver(
    browser_executable: str | Path,
    explicit: str | Path | None = None,
) -> dict[str, str]:
    source = "explicit" if explicit else "environment" if os.environ.get("SLYBROWSER_WEBDRIVER_PATH") else "sibling"
    return {
        "backend": "project-webdriver",
        "executable": str(default_driver_executable(browser_executable, explicit)),
        "source": source,
    }


def cdp_debugger_address(capabilities: Mapping[str, Any]) -> str:
    import urllib.parse

    chrome_options = capabilities.get("goog:chromeOptions")
    address = chrome_options.get("debuggerAddress") if isinstance(chrome_options, Mapping) else None
    if not isinstance(address, str) or not address:
        raise WebDriverError("Project WebDriver did not advertise a CDP debugger address", code="cdp_address_missing")
    parsed = urllib.parse.urlparse(f"http://{address}")
    if parsed.hostname not in {"127.0.0.1", "localhost", "::1"} or parsed.port is None or parsed.path not in {"", "/"}:
        raise WebDriverError("CDP debugger address must be loopback-only", code="cdp_address_unsafe")
    return parsed.netloc


def fetch_cdp_discovery(
    capabilities: Mapping[str, Any],
    *,
    opener: Callable[[str], Any] | None = None,
) -> dict[str, Any]:
    address = cdp_debugger_address(capabilities)
    request_url = f"http://{address}/json/version"
    try:
        response = (opener or urllib.request.urlopen)(request_url)
        with response:
            value = json.loads(response.read())
    except (OSError, ValueError, urllib.error.URLError) as error:
        raise WebDriverError("CDP discovery request failed", code="cdp_discovery_failed") from error
    if not isinstance(value, dict):
        raise WebDriverError("CDP discovery returned an invalid document", code="cdp_discovery_invalid")
    return value


def build_webdriver_session_payload(
    browser_executable: str | Path,
    *,
    handoff_arguments: Sequence[str] = (),
    arguments: Sequence[str] = (),
    headless: bool = True,
    viewport: tuple[int, int] | None = None,
    profile_dir: str | Path | None = None,
    profile_mode: str | None = None,
    exclude_switches: Sequence[str] = DEFAULT_EXCLUDED_SWITCHES,
    humanize: bool = False,
    human_preset: str = "default",
    human_config: Mapping[str, int | float] | None = None,
    human_seed: int | None = None,
    mobile_persona: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    persona = None if mobile_persona is None else _validate_mobile_persona(mobile_persona)
    args = ["--no-first-run", "--no-default-browser-check", *handoff_arguments, *arguments]
    if headless and not any(argument.startswith("--headless") for argument in args):
        args.append("--headless=new")
    resolved_viewport = viewport or (
        (persona["deviceMetrics"]["width"], persona["deviceMetrics"]["height"])
        if persona is not None else (1920, 947)
    )
    if not any(argument.startswith("--window-size") for argument in args):
        args.append(f"--window-size={resolved_viewport[0]},{resolved_viewport[1]}")
    resolved_profile_mode = profile_mode or ("persistent" if profile_dir else "ephemeral")
    if resolved_profile_mode not in {"ephemeral", "persistent"}:
        raise ConfigurationError("Profile mode must be ephemeral or persistent", code="profile_mode_invalid")
    if resolved_profile_mode == "persistent" and not profile_dir:
        raise ConfigurationError("Persistent profile mode requires profileDir", code="persistent_profile_dir_required")
    if profile_mode == "ephemeral" and profile_dir:
        raise ConfigurationError("Ephemeral profile mode cannot use profileDir", code="ephemeral_profile_dir_forbidden")
    if profile_dir and not any(argument.startswith("--user-data-dir") for argument in args):
        args.append(f"--user-data-dir={Path(profile_dir).expanduser().resolve()}")
    return {
        "capabilities": {
            "alwaysMatch": {
                "browserName": "chrome",
                "acceptInsecureCerts": False,
                "sly:options": {
                    "humanize": {
                        "enabled": humanize,
                        "preset": human_preset,
                        **({"config": dict(human_config)} if human_config is not None else {}),
                        **({"seed": human_seed} if human_seed is not None else {}),
                    }
                },
                "goog:chromeOptions": {
                    "binary": str(Path(browser_executable).expanduser().resolve()),
                    "args": args,
                    "excludeSwitches": list(exclude_switches),
                    **({"mobileEmulation": persona} if persona is not None else {}),
                },
            }
        }
    }


def _major_version(value: object) -> int | None:
    text = str(value or "").strip()
    first = text.split(".", 1)[0]
    return int(first) if first.isdigit() else None


def validate_webdriver_capabilities(capabilities: Mapping[str, Any]) -> WebDriverVersions:
    browser_version = str(capabilities.get("browserVersion") or "")
    chrome = capabilities.get("chrome")
    driver_value = chrome.get("chromedriverVersion") if isinstance(chrome, Mapping) else None
    driver_version = str(driver_value or "").split(maxsplit=1)[0]
    browser_major = _major_version(browser_version)
    driver_major = _major_version(driver_version)
    if browser_major is None or driver_major is None:
        raise WebDriverError(
            "The project WebDriver did not report browser and driver versions",
            code="webdriver_version_missing",
        )
    if browser_major != driver_major:
        raise WebDriverError(
            f"SlyBrowser {browser_version} and project WebDriver {driver_version} have different major versions",
            code="webdriver_version_mismatch",
        )
    return WebDriverVersions(browser_version, driver_version, browser_major)


_MISSING = object()


def _request_json(
    origin: str,
    method: str,
    path: str,
    body: object = _MISSING,
    *,
    timeout: float,
) -> object:
    data = None if body is _MISSING else json.dumps(body, separators=(",", ":")).encode("utf-8")
    headers = {} if data is None else {"Content-Type": "application/json"}
    request = urllib.request.Request(f"{origin}{path}", data=data, headers=headers, method=method)
    payload: object
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        try:
            payload = json.loads(error.read().decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            payload = {"value": {"error": "http error", "message": str(error)}}
        value = payload.get("value") if isinstance(payload, Mapping) else None
        message = value.get("message") if isinstance(value, Mapping) else str(payload)
        remote_error = value.get("error") if isinstance(value, Mapping) else error.code
        raise WebDriverError(
            f"{method} {path} failed: {remote_error}: {message}",
            code="webdriver_protocol_error",
            command=f"{method} {path}",
            status=error.code,
            payload=payload,
        ) from error
    except (TimeoutError, socket.timeout) as error:
        raise WebDriverError(
            f"{method} {path} exceeded {timeout:g} seconds",
            code="webdriver_command_timeout",
            command=f"{method} {path}",
        ) from error
    except urllib.error.URLError as error:
        raise WebDriverError(
            f"{method} {path} failed: {error.reason}",
            code="webdriver_connection_error",
            command=f"{method} {path}",
        ) from error
    if not isinstance(payload, Mapping):
        raise WebDriverError("WebDriver returned invalid JSON", code="webdriver_response_invalid")
    value = payload.get("value")
    if isinstance(value, Mapping) and value.get("error"):
        raise WebDriverError(
            f"{method} {path} failed: {value.get('error')}: {value.get('message')}",
            code="webdriver_protocol_error",
            command=f"{method} {path}",
            payload=payload,
        )
    return value


class SlyWebDriverElement:
    def __init__(self, session: SlyWebDriverSession, element_id: str) -> None:
        self.session = session
        self.id = element_id

    def click(self) -> None:
        self.session.click_element(self.id)

    def clear(self) -> None:
        self.session.clear_element(self.id)

    def send_keys(self, value: str) -> None:
        self.session.send_keys_to_element(self.id, value)

    def type(self, value: str, *, clear: bool = True) -> None:
        self.session.type_into_element(self.id, value, clear=clear)

    def rect(self) -> dict[str, float]:
        return self.session.element_rect(self.id)


class SlyWebDriverSession:
    def __init__(
        self,
        service: SlyWebDriverService,
        session_id: str,
        capabilities: Mapping[str, Any],
        browser_executable: str | Path,
        *,
        humanize: bool = False,
        human_preset: str = "default",
        human_config: Mapping[str, int | float] | None = None,
        human_seed: int | None = None,
    ) -> None:
        self._service = service
        self.session_id = session_id
        self.capabilities = dict(capabilities)
        self.versions = validate_webdriver_capabilities(capabilities)
        self.driver_executable = service.executable
        self.browser_executable = Path(browser_executable).resolve()
        self.humanize = humanize
        self.license_runtime: dict[str, object] | None = None
        self._close_callbacks: list[Callable[[], None]] = []
        if humanize:
            features = capabilities.get("sly:features")
            advertised = features.get("humanize") if isinstance(features, Mapping) else None
            if not isinstance(advertised, Mapping) or advertised.get("enabled") is not True or advertised.get("version") != 1:
                raise WebDriverError(
                    "Project WebDriver did not enable the requested Humanize capability",
                    code="humanize_not_supported",
                )
        self._closed = False

    def _path(self, suffix: str = "") -> str:
        return f"/session/{self.session_id}{suffix}"

    def _request(self, method: str, suffix: str, body: object = _MISSING) -> object:
        if self._closed:
            raise WebDriverError("The WebDriver session is closed", code="webdriver_session_closed")
        return self._service.request(method, self._path(suffix), body)

    @staticmethod
    def _reference(element_id: str) -> dict[str, str]:
        return {ELEMENT_KEY: element_id}

    def get(self, url: str) -> None:
        self._request("POST", "/url", {"url": url})

    @property
    def current_url(self) -> str:
        return str(self._request("GET", "/url"))

    @property
    def title(self) -> str:
        return str(self._request("GET", "/title"))

    def execute_script(self, script: str, *args: object) -> object:
        encoded = [self._reference(value.id) if isinstance(value, SlyWebDriverElement) else value for value in args]
        return self._request("POST", "/execute/sync", {"script": script, "args": encoded})

    def execute_async_script(self, script: str, *args: object) -> object:
        encoded = [self._reference(value.id) if isinstance(value, SlyWebDriverElement) else value for value in args]
        return self._request("POST", "/execute/async", {"script": script, "args": encoded})

    def find_element(self, selector: str, *, using: str = "css selector") -> SlyWebDriverElement:
        result = self._request("POST", "/element", {"using": using, "value": selector})
        if not isinstance(result, Mapping) or ELEMENT_KEY not in result:
            raise WebDriverError("WebDriver returned an invalid element", code="webdriver_response_invalid")
        return SlyWebDriverElement(self, str(result[ELEMENT_KEY]))

    def find_elements(self, selector: str, *, using: str = "css selector") -> list[SlyWebDriverElement]:
        results = self._request("POST", "/elements", {"using": using, "value": selector})
        if not isinstance(results, list):
            raise WebDriverError("WebDriver returned an invalid element list", code="webdriver_response_invalid")
        return [SlyWebDriverElement(self, str(result[ELEMENT_KEY])) for result in results if isinstance(result, Mapping)]

    def clear_element(self, element_id: str) -> None:
        self._request("POST", f"/element/{element_id}/clear", {})

    def send_keys_to_element(self, element_id: str, value: str) -> None:
        text = str(value)
        self._request("POST", f"/element/{element_id}/value", {"text": text, "value": list(text)})

    def element_rect(self, element_id: str) -> dict[str, float]:
        result = self.execute_script(
            """
            const element = arguments[0];
            element.scrollIntoView({block: 'center', inline: 'nearest', behavior: 'instant'});
            const rect = element.getBoundingClientRect();
            if (!rect.width || !rect.height) throw new Error('Element has an empty rectangle');
            return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
            """,
            SlyWebDriverElement(self, element_id),
        )
        if not isinstance(result, Mapping):
            raise WebDriverError("WebDriver returned an invalid rectangle", code="webdriver_response_invalid")
        return {name: float(result[name]) for name in ("x", "y", "width", "height")}

    def click_element(self, element_id: str) -> None:
        self._request("POST", f"/element/{element_id}/click", {})

    def type_into_element(self, element_id: str, value: str, *, clear: bool = True) -> None:
        if clear:
            try:
                self.clear_element(element_id)
            except WebDriverError:
                pass
        # The W3C element-value command focuses and scrolls the target before
        # the native driver emits Humanize key events. Avoid a redundant click
        # that can be intercepted by sticky page chrome.
        self.send_keys_to_element(element_id, value)

    def add_virtual_authenticator(self, options: Mapping[str, object] | None = None) -> str:
        value = self._request("POST", "/webauthn/authenticator", dict(options or {
            "protocol": "ctap2",
            "transport": "internal",
            "hasResidentKey": True,
            "hasUserVerification": True,
            "isUserConsenting": True,
            "isUserVerified": True,
        }))
        if not isinstance(value, str) or not value:
            raise WebDriverError("WebDriver returned an invalid virtual authenticator ID", code="webauthn_response_invalid")
        return value

    def remove_virtual_authenticator(self, authenticator_id: str) -> None:
        self._request("DELETE", f"/webauthn/authenticator/{authenticator_id}")

    def add_virtual_credential(self, authenticator_id: str, credential: Mapping[str, object]) -> None:
        self._request("POST", f"/webauthn/authenticator/{authenticator_id}/credential", dict(credential))

    def virtual_credentials(self, authenticator_id: str) -> list[dict[str, object]]:
        value = self._request("GET", f"/webauthn/authenticator/{authenticator_id}/credentials")
        if not isinstance(value, list) or not all(isinstance(item, Mapping) for item in value):
            raise WebDriverError("WebDriver returned an invalid credential list", code="webauthn_response_invalid")
        return [dict(item) for item in value]

    def window_handles(self) -> list[str]:
        value = self._request("GET", "/window/handles")
        if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
            raise WebDriverError("WebDriver returned invalid window handles", code="webdriver_response_invalid")
        return list(value)

    def current_window_handle(self) -> str:
        value = self._request("GET", "/window")
        if not isinstance(value, str) or not value:
            raise WebDriverError("WebDriver returned an invalid window handle", code="webdriver_response_invalid")
        return value

    def new_window(self, window_type: str = "tab") -> dict[str, str]:
        if window_type not in {"tab", "window"}:
            raise ConfigurationError("Window type must be tab or window", code="webdriver_window_type_invalid")
        value = self._request("POST", "/window/new", {"type": window_type})
        if not isinstance(value, Mapping) or not isinstance(value.get("handle"), str) or not isinstance(value.get("type"), str):
            raise WebDriverError("WebDriver returned an invalid new-window result", code="webdriver_response_invalid")
        return {"handle": value["handle"], "type": value["type"]}

    def switch_to_window(self, handle: str) -> None:
        self._request("POST", "/window", {"handle": handle})

    def window_rect(self) -> dict[str, int]:
        value = self._request("GET", "/window/rect")
        if not isinstance(value, Mapping):
            raise WebDriverError("WebDriver returned an invalid window rectangle", code="webdriver_response_invalid")
        return {name: int(value[name]) for name in ("x", "y", "width", "height")}

    def set_window_rect(
        self,
        *,
        x: int | None = None,
        y: int | None = None,
        width: int | None = None,
        height: int | None = None,
    ) -> dict[str, int]:
        values = {"x": x, "y": y, "width": width, "height": height}
        value = self._request("POST", "/window/rect", {name: field for name, field in values.items() if field is not None})
        if not isinstance(value, Mapping):
            raise WebDriverError("WebDriver returned an invalid window rectangle", code="webdriver_response_invalid")
        return {name: int(value[name]) for name in ("x", "y", "width", "height")}

    def close_window(self) -> list[str]:
        value = self._request("DELETE", "/window")
        if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
            raise WebDriverError("WebDriver returned invalid remaining window handles", code="webdriver_response_invalid")
        return list(value)

    def switch_to_frame(self, frame: int | SlyWebDriverElement | None) -> None:
        value: object = self._reference(frame.id) if isinstance(frame, SlyWebDriverElement) else frame
        self._request("POST", "/frame", {"id": value})

    def switch_to_parent_frame(self) -> None:
        self._request("POST", "/frame/parent", {})

    def alert_text(self) -> str:
        return str(self._request("GET", "/alert/text"))

    def accept_alert(self) -> None:
        self._request("POST", "/alert/accept", {})

    def dismiss_alert(self) -> None:
        self._request("POST", "/alert/dismiss", {})

    def send_alert_text(self, text: str) -> None:
        value = str(text)
        self._request("POST", "/alert/text", {"text": value, "value": list(value)})

    def perform_actions(self, actions: Sequence[Mapping[str, object]]) -> None:
        self._request("POST", "/actions", {"actions": list(actions)})

    def screenshot(self, path: str | Path | None = None) -> bytes:
        import base64
        data = base64.b64decode(str(self._request("GET", "/screenshot")))
        if path:
            Path(path).expanduser().resolve().write_bytes(data)
        return data

    def browser_logs(self) -> list[object]:
        value = self._request("POST", "/log", {"type": "browser"})
        if not isinstance(value, list):
            raise WebDriverError("WebDriver returned invalid browser logs", code="webdriver_response_invalid")
        return list(value)

    def set_timeouts(self, *, script: int | None = None, page_load: int | None = None, implicit: int | None = None) -> None:
        values = {"script": script, "pageLoad": page_load, "implicit": implicit}
        self._request("POST", "/timeouts", {name: value for name, value in values.items() if value is not None})

    def add_close_callback(self, callback: Callable[[], None]) -> None:
        if self._closed:
            raise WebDriverError("The WebDriver session is closed", code="webdriver_session_closed")
        self._close_callbacks.append(callback)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._service.request("DELETE", self._path())
        except WebDriverError:
            pass
        try:
            self._service.close()
        finally:
            for callback in self._close_callbacks:
                try:
                    callback()
                except Exception:
                    pass

    quit = close

    def __enter__(self) -> SlyWebDriverSession:
        return self

    def __exit__(self, _type: object, _value: object, _traceback: object) -> None:
        self.close()


class SlyWebDriverService:
    def __init__(
        self,
        executable: Path,
        origin: str,
        process: subprocess.Popen[bytes],
        log_file: Any,
        command_timeout: float,
    ) -> None:
        self.executable = executable
        self.origin = origin
        self._process = process
        self._log_file = log_file
        self.command_timeout = command_timeout
        self._connection = http.client.HTTPConnection("127.0.0.1", int(origin.rsplit(":", 1)[1]), timeout=command_timeout)
        self._connection_lock = threading.Lock()

    def request(self, method: str, path: str, body: object = _MISSING) -> object:
        data = None if body is _MISSING else json.dumps(body, separators=(",", ":")).encode("utf-8")
        headers = {} if data is None else {"Content-Type": "application/json"}
        with self._connection_lock:
            try:
                self._connection.request(method, path, body=data, headers=headers)
                response = self._connection.getresponse()
                raw = response.read()
            except (OSError, TimeoutError, http.client.HTTPException) as error:
                self._connection.close()
                raise WebDriverError(
                    f"{method} {path} failed: {error}",
                    code="webdriver_connection_error",
                    command=f"{method} {path}",
                ) from error
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as error:
            raise WebDriverError("WebDriver returned invalid JSON", code="webdriver_response_invalid") from error
        value = payload.get("value") if isinstance(payload, Mapping) else None
        if response.status >= 400 or isinstance(value, Mapping) and value.get("error"):
            message = value.get("message") if isinstance(value, Mapping) else str(payload)
            remote_error = value.get("error") if isinstance(value, Mapping) else response.status
            raise WebDriverError(
                f"{method} {path} failed: {remote_error}: {message}",
                code="webdriver_protocol_error",
                command=f"{method} {path}",
                status=response.status,
                payload=payload,
            )
        return value

    @classmethod
    def start(
        cls,
        executable: str | Path,
        *,
        start_timeout: float = 15,
        command_timeout: float = 60,
        license_file: str | Path | None = None,
        runtime_file: str | Path | None = None,
        release_root: str | Path | None = None,
    ) -> SlyWebDriverService:
        path = Path(executable).expanduser().resolve()
        if not path.is_file():
            raise ConfigurationError("Project WebDriver executable does not exist", code="webdriver_missing")
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
            server.bind(("127.0.0.1", 0))
            port = server.getsockname()[1]
        log_file = tempfile.TemporaryFile(mode="w+b")
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
        process = subprocess.Popen(
            [
                str(path),
                f"--port={port}",
                "--log-level=WARNING",
                *([f"--sly-license-file={Path(license_file).resolve()}"] if license_file is not None else []),
                *([f"--sly-release-root={Path(release_root).resolve()}"] if release_root is not None else []),
                *([f"--sly-runtime-file={Path(runtime_file).resolve()}"] if runtime_file is not None else []),
            ],
            stdin=subprocess.DEVNULL,
            stdout=log_file,
            stderr=subprocess.STDOUT,
            creationflags=creationflags,
        )
        origin = f"http://127.0.0.1:{port}"
        deadline = time.monotonic() + start_timeout
        while time.monotonic() < deadline:
            if process.poll() is not None:
                log_file.seek(0)
                output = log_file.read().decode("utf-8", "replace")
                log_file.close()
                raise WebDriverError(
                    f"Project WebDriver exited with {process.returncode}: {output}",
                    code="webdriver_start_failed",
                )
            try:
                status = _request_json(origin, "GET", "/status", timeout=1)
                if isinstance(status, Mapping) and status.get("ready") is True:
                    return cls(path, origin, process, log_file, command_timeout)
            except WebDriverError:
                pass
            time.sleep(0.1)
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
        log_file.seek(0)
        output = log_file.read().decode("utf-8", "replace")
        log_file.close()
        raise WebDriverError(f"Project WebDriver did not become ready: {output}", code="webdriver_start_timeout")

    def create_session(
        self,
        browser_executable: str | Path,
        *,
        handoff_arguments: Sequence[str] = (),
        arguments: Sequence[str] = (),
        headless: bool = True,
        viewport: tuple[int, int] | None = None,
        profile_dir: str | Path | None = None,
        profile_mode: str | None = None,
        exclude_switches: Sequence[str] = DEFAULT_EXCLUDED_SWITCHES,
        humanize: bool = False,
        human_preset: str = "default",
        human_config: Mapping[str, int | float] | None = None,
        human_seed: int | None = None,
        mobile_persona: Mapping[str, Any] | None = None,
    ) -> SlyWebDriverSession:
        payload = build_webdriver_session_payload(
            browser_executable,
            handoff_arguments=handoff_arguments,
            arguments=arguments,
            headless=headless,
            viewport=viewport,
            profile_dir=profile_dir,
            profile_mode=profile_mode,
            exclude_switches=exclude_switches,
            humanize=humanize,
            human_preset=human_preset,
            human_config=human_config,
            human_seed=human_seed,
            mobile_persona=mobile_persona,
        )
        value = self.request("POST", "/session", payload)
        if not isinstance(value, Mapping) or not value.get("sessionId"):
            raise WebDriverError("Project WebDriver did not return a session ID", code="webdriver_session_invalid")
        session_id = str(value["sessionId"])
        capabilities = value.get("capabilities", value)
        if not isinstance(capabilities, Mapping):
            raise WebDriverError("Project WebDriver returned invalid capabilities", code="webdriver_response_invalid")
        try:
            return SlyWebDriverSession(
                self,
                session_id,
                capabilities,
                browser_executable,
                humanize=humanize,
                human_preset=human_preset,
                human_config=human_config,
                human_seed=human_seed,
            )
        except BaseException:
            try:
                self.request("DELETE", f"/session/{session_id}")
            except WebDriverError:
                pass
            raise

    def close(self) -> None:
        try:
            _request_json(self.origin, "GET", "/shutdown", timeout=1)
        except WebDriverError:
            pass
        self._connection.close()
        if self._process.poll() is None:
            try:
                self._process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self._process.kill()
        self._log_file.close()


def launch(
    executable: str | Path,
    lease: str | bytes | Mapping[str, Any],
    *,
    driver_executable: str | Path | None = None,
    profile: Mapping[str, Any] | None = None,
    profile_dir: str | Path | None = None,
    profile_mode: str | None = None,
    arguments: Sequence[str] = (),
    headless: bool = True,
    viewport: tuple[int, int] | None = None,
    exclude_switches: Sequence[str] = DEFAULT_EXCLUDED_SWITCHES,
    humanize: bool = False,
    human_preset: str = "default",
    human_config: Mapping[str, int | float] | None = None,
    human_seed: int | None = None,
    mobile_persona: Mapping[str, Any] | None = None,
    runtime_handoff: Mapping[str, Any] | None = None,
    driver_runtime_handoff: Mapping[str, Any] | None = None,
    allow_runtime_activation_ticket: bool = False,
    native_ready: bool = False,
    native_ready_timeout: float = 15.0,
    temp_root: str | Path | None = None,
    release_root: str | Path | None = None,
    driver_start_timeout: int = 15_000,
    command_timeout: int = 60_000,
) -> SlyWebDriverSession:
    """Launch SlyBrowser through its sibling project WebDriver (the default backend)."""

    if driver_start_timeout < 1000 or command_timeout < 1000:
        raise ConfigurationError(
            "WebDriver timeouts must be at least 1000 milliseconds",
            code="config_invalid",
        )
    if native_ready and (not isinstance(native_ready_timeout, (int, float)) or native_ready_timeout <= 0):
        raise ConfigurationError("native_ready_timeout must be positive", code="config_invalid")
    browser_path = Path(executable).expanduser().resolve()
    driver_path = default_driver_executable(browser_path, driver_executable)
    selected_release_root = Path(release_root).expanduser().resolve() if release_root is not None else _release_root_from_lease(browser_path, lease)
    service: SlyWebDriverService | None = None
    with prepare_launch(
        browser_path,
        _native_profile(profile, mobile_persona),
        lease,
        temp_root=temp_root,
        release_root=selected_release_root,
        include_driver_lease=True,
        runtime_handoff=runtime_handoff,
        driver_runtime_handoff=driver_runtime_handoff,
        include_driver_runtime=runtime_handoff is not None,
        allow_runtime_activation_ticket=allow_runtime_activation_ticket,
        native_ready=native_ready,
    ) as plan:
        try:
            service = SlyWebDriverService.start(
                driver_path,
                start_timeout=driver_start_timeout / 1000,
                command_timeout=command_timeout / 1000,
                license_file=plan.driver_license_file,
                runtime_file=plan.driver_runtime_file,
                release_root=selected_release_root,
            )
            session = service.create_session(
                browser_path,
                handoff_arguments=plan.arguments,
                arguments=arguments,
                headless=headless,
                viewport=viewport,
                profile_dir=profile_dir,
                profile_mode=profile_mode,
                exclude_switches=exclude_switches,
                humanize=humanize,
                human_preset=human_preset,
                human_config=human_config,
                human_seed=human_seed,
                mobile_persona=mobile_persona,
            )
            try:
                if native_ready:
                    wait_for_native_ready(plan, timeout=native_ready_timeout)
                session.set_timeouts(script=command_timeout, page_load=command_timeout, implicit=0)
                return session
            except BaseException:
                session.close()
                raise
        except BaseException:
            if service is not None:
                service.close()
            raise


launch_webdriver = launch
