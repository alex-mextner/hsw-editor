from fastapi.testclient import TestClient

from hsw_vision.app import app


def test_health() -> None:
    response = TestClient(app).get("/health")
    assert response.status_code == 200
    assert response.json()["ok"] is True
