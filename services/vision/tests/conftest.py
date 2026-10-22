from pathlib import Path

import pytest

from helpers import write_photo


@pytest.fixture
def photo(tmp_path: Path) -> Path:
    return write_photo(tmp_path)
