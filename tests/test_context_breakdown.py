"""Integration tests for context breakdown endpoint.

Tests verify that GET /conversations/{id}/context-breakdown returns
complete token breakdown matching what goes into the LLM context.
"""

import pytest
import httpx

# Skip all tests if API not available
pytestmark = pytest.mark.integration

BASE_URL = "https://localhost:15597"


@pytest.fixture
def auth_headers():
    """Get auth token for test user. Skips if the backend isn't reachable."""
    with httpx.Client(verify=False) as client:
        try:
            response = client.post(
                f"{BASE_URL}/login",
                data={"username": "testuser", "password": "testpass123"},
            )
        except httpx.ConnectError:
            pytest.skip(f"Backend not reachable at {BASE_URL}")
        if response.status_code != 200:
            pytest.skip("Test user not available")
        token = response.json()["access_token"]
        return {"Authorization": f"Bearer {token}"}


class TestContextBreakdownEndpoint:
    """Integration tests for context breakdown endpoint."""

    def test_returns_all_required_fields(self, auth_headers):
        """Endpoint returns all fields needed to understand LLM context composition."""
        with httpx.Client(verify=False) as client:
            # First create a conversation by getting agents
            agents_resp = client.get(f"{BASE_URL}/agents", headers=auth_headers)
            if agents_resp.status_code != 200 or not agents_resp.json():
                pytest.skip("No agents available")

            # Get or create a conversation
            convs_resp = client.get(f"{BASE_URL}/conversations", headers=auth_headers)
            assert convs_resp.status_code == 200

            conversations = convs_resp.json()
            if not conversations:
                pytest.skip("No conversations available for testing")

            conv_id = conversations[0]["id"]

            # Get context breakdown
            response = client.get(
                f"{BASE_URL}/conversations/{conv_id}/context-breakdown",
                headers=auth_headers
            )

            assert response.status_code == 200
            data = response.json()

            # Verify all required fields representing LLM context components
            required_fields = {
                # Identifiers
                "conversation_id": int,
                "agent_id": int,
                "agent_name": str,
                # Token counts for each context component
                "system_prompt_tokens": int,  # Base agent prompt + user prefs
                "memory_tokens": int,          # Agent memory if enabled
                "compacted_context_tokens": int,  # Summarized old messages
                "skills_tokens": int,          # Skill system prompt
                "tools_guidance_tokens": int,  # Deferred tools prompt
                "other_agents_tokens": int,    # Multi-agent routing info
                "message_history_tokens": int, # Recent messages
                "tool_schemas_tokens": int,    # Tool definitions JSON
                # Counts
                "message_count": int,
                "tool_count": int,
                # Totals
                "total_tokens": int,
                "context_limit": int,
                # Lists for debugging
                "loaded_tools": list,
                "loaded_skills": list,
            }

            for field, expected_type in required_fields.items():
                assert field in data, f"Missing required field: {field}"
                assert isinstance(data[field], expected_type), \
                    f"Field {field} should be {expected_type.__name__}, got {type(data[field]).__name__}"

    def test_total_equals_sum_of_components(self, auth_headers):
        """total_tokens equals sum of all component token counts."""
        with httpx.Client(verify=False) as client:
            convs_resp = client.get(f"{BASE_URL}/conversations", headers=auth_headers)
            conversations = convs_resp.json()
            if not conversations:
                pytest.skip("No conversations available")

            conv_id = conversations[0]["id"]
            response = client.get(
                f"{BASE_URL}/conversations/{conv_id}/context-breakdown",
                headers=auth_headers
            )

            assert response.status_code == 200
            data = response.json()

            expected_total = (
                data["system_prompt_tokens"] +
                data["memory_tokens"] +
                data["compacted_context_tokens"] +
                data["skills_tokens"] +
                data["tools_guidance_tokens"] +
                data["other_agents_tokens"] +
                data["message_history_tokens"] +
                data["tool_schemas_tokens"]
            )

            assert data["total_tokens"] == expected_total, \
                f"total_tokens ({data['total_tokens']}) != sum of components ({expected_total})"

    def test_tool_count_matches_loaded_tools(self, auth_headers):
        """tool_count matches length of loaded_tools list."""
        with httpx.Client(verify=False) as client:
            convs_resp = client.get(f"{BASE_URL}/conversations", headers=auth_headers)
            conversations = convs_resp.json()
            if not conversations:
                pytest.skip("No conversations available")

            conv_id = conversations[0]["id"]
            response = client.get(
                f"{BASE_URL}/conversations/{conv_id}/context-breakdown",
                headers=auth_headers
            )

            assert response.status_code == 200
            data = response.json()
            assert data["tool_count"] == len(data["loaded_tools"])

    def test_system_prompt_tokens_always_present(self, auth_headers):
        """System prompt should always have some tokens (agent name at minimum)."""
        with httpx.Client(verify=False) as client:
            convs_resp = client.get(f"{BASE_URL}/conversations", headers=auth_headers)
            conversations = convs_resp.json()
            if not conversations:
                pytest.skip("No conversations available")

            conv_id = conversations[0]["id"]
            response = client.get(
                f"{BASE_URL}/conversations/{conv_id}/context-breakdown",
                headers=auth_headers
            )

            assert response.status_code == 200
            data = response.json()
            assert data["system_prompt_tokens"] > 0, \
                "system_prompt_tokens should be > 0 (at least 'You are {agent_name}')"

    def test_context_limit_is_reasonable(self, auth_headers):
        """context_limit should be a reasonable value (not 0 or negative)."""
        with httpx.Client(verify=False) as client:
            convs_resp = client.get(f"{BASE_URL}/conversations", headers=auth_headers)
            conversations = convs_resp.json()
            if not conversations:
                pytest.skip("No conversations available")

            conv_id = conversations[0]["id"]
            response = client.get(
                f"{BASE_URL}/conversations/{conv_id}/context-breakdown",
                headers=auth_headers
            )

            assert response.status_code == 200
            data = response.json()
            assert data["context_limit"] >= 2048, \
                f"context_limit ({data['context_limit']}) seems too low"

    def test_returns_404_for_nonexistent_conversation(self, auth_headers):
        """Returns 404 for conversation that doesn't exist."""
        with httpx.Client(verify=False) as client:
            response = client.get(
                f"{BASE_URL}/conversations/99999999/context-breakdown",
                headers=auth_headers
            )
            assert response.status_code == 404

    def test_agent_id_parameter_works(self, auth_headers):
        """Can specify agent_id parameter to get breakdown for specific agent."""
        with httpx.Client(verify=False) as client:
            # Get agents
            agents_resp = client.get(f"{BASE_URL}/agents", headers=auth_headers)
            if agents_resp.status_code != 200:
                pytest.skip("Cannot get agents")
            agents = agents_resp.json()
            if not agents:
                pytest.skip("No agents available")

            # Get conversations
            convs_resp = client.get(f"{BASE_URL}/conversations", headers=auth_headers)
            conversations = convs_resp.json()
            if not conversations:
                pytest.skip("No conversations available")

            conv_id = conversations[0]["id"]
            agent_id = agents[0]["id"]

            response = client.get(
                f"{BASE_URL}/conversations/{conv_id}/context-breakdown",
                params={"agent_id": agent_id},
                headers=auth_headers
            )

            assert response.status_code == 200
            data = response.json()
            assert data["agent_id"] == agent_id
