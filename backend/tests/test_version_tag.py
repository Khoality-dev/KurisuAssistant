"""The release tag is the backend's version (#256).

One tag, ``vX.Y.Z``, releases everything: the root ``release.yml`` refuses a tag
whose number is not ``__version__``, and the clients take their version from
the tag at build time. That only works if ``__version__`` is a plain ``X.Y.Z``
the workflow's ``sed`` and Gradle's ``kurisu.releaseVersion`` parser both read
the same way — no ``-rc1``, no fourth component, no leading ``v``.
"""

import re
from pathlib import Path

from kurisuassistant import version

VERSION_PY = Path(version.__file__)
RELEASE_YML = VERSION_PY.parents[2] / ".github" / "workflows" / "release.yml"


def test_version_is_a_plain_x_y_z():
    assert re.fullmatch(r"\d+\.\d+\.\d+", version.__version__), version.__version__


def test_the_minor_and_patch_fit_the_android_versioncode_rule():
    # app/build.gradle.kts derives versionCode = X*10000 + Y*100 + Z.
    _, minor, patch = (int(p) for p in version.__version__.split("."))
    assert minor < 100 and patch < 100


def test_the_release_workflow_reads_the_line_the_way_this_module_writes_it():
    """The workflow greps ``__version__ = "..."`` with sed; keep the line greppable."""
    line = next(l for l in VERSION_PY.read_text().splitlines() if l.startswith("__version__"))
    assert re.fullmatch(r'__version__ = "\d+\.\d+\.\d+"', line), line
    assert 'sed -nE \'s/^__version__ = "([^"]+)".*/\\1/p\'' in RELEASE_YML.read_text()
