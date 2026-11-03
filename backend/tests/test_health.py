"""The API's name, where it shows: /health and the OpenAPI page (#159).

The service called itself "LLM Hub" for as long as it existed, a name the
project never chose. Nothing consumes the `service` field, but it is the one
string with a contract-shaped surface, so it is pinned here — change it in the
three documents that quote it in the same commit.
"""

from fastapi.testclient import TestClient


def test_health_names_the_service():
    from amadeus.main import app

    response = TestClient(app).get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "amadeus"}


def test_openapi_title_is_the_project_name():
    from amadeus.main import app

    assert app.title == "Amadeus API"
    assert "LLM" not in app.description
