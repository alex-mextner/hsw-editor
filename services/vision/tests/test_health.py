import pytest
from fastapi.testclient import TestClient

from hsw_vision.app import create_app
from hsw_vision.cli import main


def client() -> TestClient:
    return TestClient(create_app(), base_url="http://127.0.0.1:8795")


def test_health() -> None:
    response = client().get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True and body["name"] == "hsw-vision"


def test_health_does_not_build_the_service_or_import_the_heavy_stack() -> None:
    # /health must answer instantly on a machine without torch: the service is created lazily.
    import sys

    client().get("/health")
    assert "torch" not in sys.modules


def test_non_loopback_host_is_refused() -> None:
    response = TestClient(create_app(), base_url="http://evil.example").get("/health")
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "forbidden_host"


def test_localhost_and_ipv6_loopback_hosts_are_accepted() -> None:
    for base in ("http://localhost:8795", "http://[::1]:8795"):
        assert TestClient(create_app(), base_url=base).get("/health").status_code == 200


def test_serve_refuses_hosts_other_than_ipv4_loopback(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    """`::1` is refused too: the port picker binds AF_INET sockets only (it would crash after the check)."""
    monkeypatch.delenv("HSW_VISION_PORT", raising=False)
    for host in ("0.0.0.0", "::1", "192.168.1.5"):
        assert main(["serve", "--host", host]) == 2
        err = capsys.readouterr().err
        assert '"code": "bad_request"' in err.replace('":"', '": "') and "127.0.0.1 or localhost" in err


def test_serve_accepts_localhost(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("HSW_VISION_PORT", raising=False)
    started: list[str] = []
    monkeypatch.setattr("hsw_vision.serve.serve", lambda config: started.append(config.host))
    assert main(["serve", "--host", "localhost"]) == 0
    assert started == ["localhost"]
