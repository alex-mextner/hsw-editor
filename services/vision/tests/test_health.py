from fastapi.testclient import TestClient

from hsw_vision.app import create_app


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
