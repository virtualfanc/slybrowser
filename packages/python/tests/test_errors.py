import json
from pathlib import Path

from slybrowser import LICENSE_SERVICE_ERROR_CODES, is_license_service_error_code


def test_license_service_error_codes_match_shared_contract() -> None:
    contract_path = Path(__file__).resolve().parents[3] / "contracts" / "error-codes.json"
    contract = json.loads(contract_path.read_text(encoding="utf-8"))
    codes = [entry["code"] for entry in contract["codes"]]
    assert list(LICENSE_SERVICE_ERROR_CODES) == codes
    assert len(set(codes)) == len(codes)
    assert is_license_service_error_code("session_limit")
    assert not is_license_service_error_code("not_a_slybrowser_error")
