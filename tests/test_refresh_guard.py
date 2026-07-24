"""Tests for the CI publish guard on geocode_failures.json in refresh.yml.

The "Commit + push public aggregates if changed" step in
``.github/workflows/refresh.yml`` validates the staged ``geocode_failures.json``
against its KNOWN SCHEMA ``{name, address, reason}`` before committing. This
guard must:

  * PASS the file's own legitimate schema — including the expected ``address``
    field (geocoder.py appends ``{name, address, reason}`` per failure). A
    blocklist that treated ``address`` as PII would false-abort every nightly
    refresh that has >= 1 geocode failure.
  * ABORT when a ``name`` is not a single-token first name (a last name /
    multi-token value leaked), e.g. ``"Jane Smith"`` / ``"Bob De La Cruz"``.
  * ABORT when an entry carries any key outside the known schema (a genuinely
    unexpected PII key such as ``phone`` / ``last_name`` / ``street``).

To avoid drift, the test EXTRACTS the exact Python validator embedded in
refresh.yml (the ``<<'PY' ... PY`` heredoc in the guard section) and executes it
against a throwaway git repo with a staged ``geocode_failures.json`` fixture.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
WORKFLOW = ROOT / ".github" / "workflows" / "refresh.yml"


def _extract_guard_validator() -> str:
    """Pull the geocode_failures.json schema validator out of refresh.yml.

    The workflow embeds it as a here-doc:  python3 - <<'PY' ... PY  inside the
    guard section that mentions ALLOWED_KEYS. We locate the PY block that
    references ALLOWED_KEYS and de-indent it so it runs standalone.
    """
    text = WORKFLOW.read_text(encoding="utf-8")
    # Find the here-doc body: everything between `<<'PY'` (to end of line) and
    # a line whose stripped content is exactly `PY`.
    blocks = re.findall(r"<<'PY'[^\n]*\n(.*?)\n[ \t]*PY\b", text, flags=re.DOTALL)
    guard = next((b for b in blocks if "ALLOWED_KEYS" in b), None)
    assert guard is not None, "could not find the ALLOWED_KEYS validator in refresh.yml"
    # De-indent: strip the common leading whitespace (YAML block indentation).
    lines = guard.split("\n")
    indents = [len(ln) - len(ln.lstrip()) for ln in lines if ln.strip()]
    common = min(indents) if indents else 0
    return "\n".join(ln[common:] if len(ln) >= common else ln for ln in lines)


@pytest.fixture(scope="module")
def validator_src() -> str:
    return _extract_guard_validator()


def _extract_coordinators_validator() -> str:
    """Pull the coordinators.json structural validator out of refresh.yml.

    The workflow embeds it as a here-doc:  python3 - <<'PY' ... PY  inside the
    guard section that references coordinators.json (the block that opens with
    `git show :docs/data/coordinators.json`). We locate that PY block and
    de-indent it so it runs standalone.
    """
    text = WORKFLOW.read_text(encoding="utf-8")
    blocks = re.findall(r"<<'PY'[^\n]*\n(.*?)\n[ \t]*PY\b", text, flags=re.DOTALL)
    guard = next(
        (b for b in blocks if ":docs/data/coordinators.json" in b), None
    )
    assert guard is not None, \
        "could not find the coordinators.json validator in refresh.yml"
    lines = guard.split("\n")
    indents = [len(ln) - len(ln.lstrip()) for ln in lines if ln.strip()]
    common = min(indents) if indents else 0
    return "\n".join(ln[common:] if len(ln) >= common else ln for ln in lines)


@pytest.fixture(scope="module")
def coord_validator_src() -> str:
    return _extract_coordinators_validator()


def _run_coord_guard(
    tmp_path: Path, validator_src: str, payload
) -> subprocess.CompletedProcess:
    """Stage a docs/data/coordinators.json fixture and run the extracted validator.

    Returns the CompletedProcess (rc 0 => guard PASS, rc != 0 => guard ABORT).
    """
    repo = tmp_path
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "t@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "t"], cwd=repo, check=True)

    (repo / "docs" / "data").mkdir(parents=True, exist_ok=True)
    fpath = repo / "docs" / "data" / "coordinators.json"
    fpath.write_text(
        payload if isinstance(payload, str) else json.dumps(payload),
        encoding="utf-8",
    )
    subprocess.run(
        ["git", "add", "docs/data/coordinators.json"], cwd=repo, check=True
    )

    script = repo / "_coord_guard.py"
    script.write_text(validator_src, encoding="utf-8")
    return subprocess.run(
        [sys.executable, str(script)],
        cwd=repo,
        capture_output=True,
        text=True,
    )


def _run_guard(tmp_path: Path, validator_src: str, payload) -> subprocess.CompletedProcess:
    """Stage a geocode_failures.json fixture and run the extracted validator.

    Returns the CompletedProcess (rc 0 => guard PASS, rc != 0 => guard ABORT).
    """
    repo = tmp_path
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "t@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "t"], cwd=repo, check=True)

    fpath = repo / "geocode_failures.json"
    fpath.write_text(
        payload if isinstance(payload, str) else json.dumps(payload),
        encoding="utf-8",
    )
    subprocess.run(["git", "add", "geocode_failures.json"], cwd=repo, check=True)

    script = repo / "_guard.py"
    script.write_text(validator_src, encoding="utf-8")
    return subprocess.run(
        [sys.executable, str(script)],
        cwd=repo,
        capture_output=True,
        text=True,
    )


# ---------------------------------------------------------------------------
# PASS cases — the guard must NOT false-abort on the real, legitimate schema.
# ---------------------------------------------------------------------------


def test_guard_passes_real_failures_schema_with_address(tmp_path, validator_src):
    """The false-positive fix: {name(first), address, reason} must PASS.

    This is exactly what geocoder.py emits per failed entry — including the
    legitimate `address` field the old blocklist wrongly rejected.
    """
    payload = [
        {
            "name": "Bob",
            "address": "12 Oak St, Lancaster, PA, 17601",
            "reason": "No Census or Nominatim match",
        }
    ]
    res = _run_guard(tmp_path, validator_src, payload)
    assert res.returncode == 0, f"guard should PASS real schema; stderr={res.stderr}"
    # The published/committed failures artifact carries NO last name...
    assert "Smith" not in json.dumps(payload)
    # ...and its address is only a street/city debug string, never a full name.


def test_guard_passes_empty_array(tmp_path, validator_src):
    res = _run_guard(tmp_path, validator_src, [])
    assert res.returncode == 0, f"empty [] must PASS; stderr={res.stderr}"


# ---------------------------------------------------------------------------
# ABORT cases — last name / multi-token name.
# ---------------------------------------------------------------------------


def test_guard_aborts_on_two_token_last_name(tmp_path, validator_src):
    payload = [{"name": "Jane Smith", "address": "1 A St", "reason": "x"}]
    res = _run_guard(tmp_path, validator_src, payload)
    assert res.returncode != 0, "guard must ABORT on 'Jane Smith'"
    assert "single-token" in res.stderr or "multi-token" in res.stderr.lower() \
        or "ABORT" in res.stderr


def test_guard_aborts_on_multi_token_last_name(tmp_path, validator_src):
    payload = [{"name": "Bob De La Cruz", "address": "1 A St", "reason": "x"}]
    res = _run_guard(tmp_path, validator_src, payload)
    assert res.returncode != 0, "guard must ABORT on 'Bob De La Cruz'"


# ---------------------------------------------------------------------------
# ABORT cases — genuinely unexpected key outside the known schema.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("bad_key", ["phone", "email", "last_name", "full_name", "street", "zip"])
def test_guard_aborts_on_unexpected_pii_key(tmp_path, validator_src, bad_key):
    payload = [{"name": "Bob", "address": "x", "reason": "y", bad_key: "leak"}]
    res = _run_guard(tmp_path, validator_src, payload)
    assert res.returncode != 0, f"guard must ABORT on unexpected key {bad_key!r}"
    assert bad_key in res.stderr


# ---------------------------------------------------------------------------
# Cross-check the guard's schema matches what geocoder.py actually emits.
# ---------------------------------------------------------------------------


def test_geocoder_failure_schema_matches_guard_allowlist(tmp_path, validator_src):
    """A real geocoder failure entry must pass the guard unchanged.

    Guards against schema drift: if geocoder.py ever adds a new key, this test
    fails, forcing the guard's ALLOWED_KEYS to be updated deliberately.
    """
    sys.path.insert(0, str(ROOT))
    import geocoder  # noqa: E402
    from unittest import mock

    volunteers = [
        {"name": "Zoe Zimmerman", "street": "999 Nowhere", "city": "Nowhere",
         "state": "PA", "zip": "00000", "county": "Lancaster", "roles": ["C&T"]},
    ]
    with mock.patch.object(geocoder, "geocode_address", return_value=None), \
         mock.patch.object(geocoder, "geocode_address_nominatim", return_value=None):
        _out, failures = geocoder.batch_geocode_volunteers(volunteers)

    assert failures and set(failures[0].keys()) == {"name", "address", "reason"}
    # first-name only in the published entry
    assert failures[0]["name"] == "Zoe"
    res = _run_guard(tmp_path, validator_src, failures)
    assert res.returncode == 0, f"real geocoder failure must PASS guard; stderr={res.stderr}"
    # And the published artifact carries NO last name.
    assert "Zimmerman" not in json.dumps(failures)


# ---------------------------------------------------------------------------
# coordinators.json guard — public site dataset: STRUCTURAL first-name model.
# Values are curated FIRST NAMES published verbatim (multi-word allowed); the
# guard's job is now to (a) validate the {area -> first-name string} shape and
# (b) trip if the never-read Last_Name column id ever surfaces in the file.
# ---------------------------------------------------------------------------


def test_coord_guard_passes_all_first_names(tmp_path, coord_validator_src):
    payload = {
        "1": "Sue",
        "10": "Julia",
        "15N": "Jane",
        "15S": "Jane",
        "9": "Judith",
    }
    res = _run_coord_guard(tmp_path, coord_validator_src, payload)
    assert res.returncode == 0, \
        f"all-first-names must PASS; stderr={res.stderr}"


def test_coord_guard_passes_empty_object(tmp_path, coord_validator_src):
    res = _run_coord_guard(tmp_path, coord_validator_src, {})
    assert res.returncode == 0, f"empty {{}} must PASS; stderr={res.stderr}"


def test_coord_guard_passes_two_word_first_name(tmp_path, coord_validator_src):
    # VERBATIM model: a legit two-word / hyphenated FIRST name must NOT abort
    # (the old single-token guard false-aborted here).
    payload = {"6": "Mary Jane", "7": "Anne-Marie", "8": "Jo Ellen"}
    res = _run_coord_guard(tmp_path, coord_validator_src, payload)
    assert res.returncode == 0, \
        f"two-word first names must PASS under verbatim model; stderr={res.stderr}"


def test_coord_guard_aborts_when_last_name_column_id_present(tmp_path, coord_validator_src):
    # STRUCTURAL tripwire: the never-read Last_Name column id (text_mm5jhd0x)
    # must never appear in the published file. If a regression ever emitted the
    # last-name column (as a key or value), the guard must abort.
    payload = '{"1": "Sue", "text_mm5jhd0x": "Smith"}'
    res = _run_coord_guard(tmp_path, coord_validator_src, payload)
    assert res.returncode != 0, "guard must ABORT when Last_Name column id appears"
    assert "text_mm5jhd0x" in res.stderr or "Last_Name" in res.stderr


def test_coord_guard_aborts_on_last_name_column_id_as_value(tmp_path, coord_validator_src):
    payload = {"1": "text_mm5jhd0x"}
    res = _run_coord_guard(tmp_path, coord_validator_src, payload)
    assert res.returncode != 0, "guard must ABORT when col id leaks as a value"


def test_coord_guard_aborts_on_non_object(tmp_path, coord_validator_src):
    res = _run_coord_guard(tmp_path, coord_validator_src, ["Sue", "Julia"])
    assert res.returncode != 0, "guard must ABORT when JSON is not an object"


def test_coord_guard_matches_repo_coordinators_json(tmp_path, coord_validator_src):
    """The real committed coordinators.json must PASS the guard unchanged."""
    real = json.loads(
        (ROOT / "docs" / "data" / "coordinators.json").read_text(encoding="utf-8")
    )
    res = _run_coord_guard(tmp_path, coord_validator_src, real)
    assert res.returncode == 0, \
        f"repo coordinators.json must PASS guard; stderr={res.stderr}"
