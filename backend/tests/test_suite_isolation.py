"""The suite keeps its hands off the checkout it runs from (#307).

The server resolves ``data/`` from the package (``core/paths.py``), so a test
run from a checkout with real data used to write uploads among the real images
and — through ``DELETE /personas/{id}`` — remove
``data/character_assets/{id}`` for ids the test database numbers from 1: a real
persona's character files. ``conftest.py`` now points ``DATA_DIR`` at a
directory of the run's own before anything else from the package is imported.

And a suite that needs Postgres must not quietly skip on CI: that is how losing
the database would hide it.
"""

import re
from pathlib import Path

import pytest

from kurisuassistant.core import paths

TESTS = Path(__file__).resolve().parent
CHECKOUT_DATA = (paths.PROJECT_ROOT / "data").resolve()


def _outside_checkout_data(path: Path) -> bool:
    resolved = Path(path).resolve()
    return resolved != CHECKOUT_DATA and CHECKOUT_DATA not in resolved.parents


class TestTheSuiteHasItsOwnDataDirectory:
    def test_data_dir_is_not_the_checkouts(self):
        assert _outside_checkout_data(paths.DATA_DIR), (
            f"the suite is using the checkout's data directory {paths.DATA_DIR}"
        )

    @pytest.mark.parametrize(
        "module, name",
        [
            ("kurisuassistant.utils.images", "IMAGES_DIR"),
            ("kurisuassistant.character.paths", "CHAR_ASSETS_DIR"),
            ("kurisuassistant.utils.drive_storage", "DRIVE_DIR"),
            ("kurisuassistant.routers.tts", "VOICE_STORAGE_DIR"),
        ],
    )
    def test_every_store_follows_it(self, module, name):
        """A module that captured ``DATA_DIR`` before the suite moved it would
        still point at the checkout."""
        import importlib

        store = getattr(importlib.import_module(module), name)
        assert _outside_checkout_data(store), f"{module}.{name} is {store}"
        assert paths.DATA_DIR.resolve() in Path(store).resolve().parents

    @pytest.mark.parametrize(
        "source",
        [
            "kurisuassistant/models/face_recognition/insightface_provider.py",
            "kurisuassistant/models/gesture_detection/mediapipe_provider.py",
        ],
    )
    def test_no_store_is_relative_to_the_working_directory(self, source):
        """``data/…`` relative to the working directory is the checkout's
        ``data/`` whenever the suite runs from ``backend/`` — and a different
        one when the server is started from anywhere else."""
        text = (paths.PROJECT_ROOT / source).read_text()
        assert not re.search(r"""(?:Path|os\.path\.join)\(\s*["']data""", text), source
        assert "DATA_DIR" in text


class TestPostgresSuitesFailOnCI:
    def test_no_fixture_skips_for_a_missing_postgres_on_its_own(self):
        """Every "no Postgres" skip goes through ``require_postgres``, which
        raises when ``CI`` is set instead of skipping."""
        offenders = []
        for path in sorted(TESTS.glob("*.py")):
            if path.name in {"postgres.py", Path(__file__).name}:
                continue
            for number, line in enumerate(path.read_text().splitlines(), 1):
                if "pytest.skip(" in line and "Postgres" in line:
                    offenders.append(f"{path.name}:{number}")
        assert offenders == [], f"skip without the CI check: {offenders}"

    def test_the_helper_raises_on_ci_and_skips_elsewhere(self, monkeypatch):
        from tests.postgres import require_postgres

        monkeypatch.setenv("CI", "true")
        with pytest.raises(RuntimeError, match="no Postgres"):
            require_postgres(ConnectionError("refused"), "migration tests")
        monkeypatch.delenv("CI")
        with pytest.raises(pytest.skip.Exception):
            require_postgres(ConnectionError("refused"), "migration tests")
