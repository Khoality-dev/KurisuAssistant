"""API client for KurisuAssistant server communication."""

import json
import logging
import time
import requests
from typing import Optional, Dict, List, Generator
from config import API_BASE_URL, STREAM_TIMEOUT

# Configure logging
logger = logging.getLogger(__name__)
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)


class RequestHandler:
    """Handles HTTP requests with automatic logging and error handling."""

    def __init__(self):
        self.logger = logger

    def _sanitize_headers(self, headers: Optional[Dict]) -> Dict:
        """Sanitize headers by redacting sensitive information."""
        if not headers:
            return {}
        safe_headers = headers.copy()
        if "Authorization" in safe_headers:
            safe_headers["Authorization"] = "Bearer ***REDACTED***"
        return safe_headers

    def _sanitize_data(self, data: Optional[Dict]) -> Dict:
        """Sanitize data by redacting sensitive information."""
        if not data:
            return {}
        safe_data = data.copy()
        if "password" in safe_data:
            safe_data["password"] = "***REDACTED***"
        return safe_data

    def _log_request(
        self,
        method: str,
        url: str,
        headers: Optional[Dict] = None,
        data: Optional[Dict] = None,
        params: Optional[Dict] = None,
    ):
        """Log outgoing request details."""
        self.logger.info(f"REQUEST: {method} {url}")

        safe_headers = self._sanitize_headers(headers)
        safe_data = self._sanitize_data(data)

        if safe_headers:
            self.logger.debug(f"  Headers: {safe_headers}")
        if params:
            self.logger.debug(f"  Params: {params}")
        if safe_data:
            self.logger.debug(f"  Data: {safe_data}")

    def _log_response(
        self,
        method: str,
        url: str,
        status_code: int,
        elapsed: float,
        response_body: Optional[str] = None,
    ):
        """Log response details."""
        self.logger.info(
            f"RESPONSE: {method} {url} - Status: {status_code} - Time: {elapsed:.3f}s"
        )

        # Log error responses with body content
        if status_code >= 400 and response_body:
            self.logger.error(f"  Error response body: {response_body}")

    def request(
        self,
        method: str,
        url: str,
        headers: Optional[Dict] = None,
        data: Optional[Dict] = None,
        params: Optional[Dict] = None,
        files: Optional[list] = None,
        stream: bool = False,
        timeout: Optional[int] = None,
    ) -> Optional[requests.Response]:
        """Execute HTTP request with logging and error handling.

        Args:
            method: HTTP method (GET, POST, DELETE, etc.)
            url: Request URL
            headers: Optional request headers
            data: Optional request data
            params: Optional query parameters
            files: Optional files for multipart upload
            stream: Whether to stream the response
            timeout: Optional request timeout

        Returns:
            Response object or None on error
        """
        self._log_request(method, url, headers, data, params)

        try:
            start_time = time.time()
            response = requests.request(
                method=method,
                url=url,
                headers=headers,
                data=data,
                params=params,
                files=files,
                stream=stream,
                timeout=timeout,
            )
            elapsed = time.time() - start_time

            # Get response body for error logging (only for non-streaming responses)
            response_body = None
            if response.status_code >= 400 and not stream:
                try:
                    response_body = response.text[:500]  # Limit to 500 chars
                except Exception:
                    response_body = "<unable to read response body>"

            self._log_response(method, url, response.status_code, elapsed, response_body)
            return response
        except requests.exceptions.Timeout as e:
            self.logger.error(f"Request timeout: {method} {url} - {e}")
            return None
        except requests.exceptions.ConnectionError as e:
            self.logger.error(f"Connection error: {method} {url} - {e}")
            return None
        except Exception as e:
            self.logger.error(f"Request error: {method} {url} - {e}", exc_info=True)
            return None


class APIClient:
    """Client for interacting with KurisuAssistant API."""

    def __init__(self, base_url: Optional[str] = None):
        """Initialize API client.

        Args:
            base_url: Optional custom server URL. If not provided, uses default from config.
        """
        self.base_url = base_url if base_url else API_BASE_URL
        self.token: Optional[str] = None
        self.username: Optional[str] = None
        self.request_handler = RequestHandler()
        logger.info(f"APIClient initialized with server: {self.base_url}")

    def _get_headers(self) -> Dict[str, str]:
        """Get headers with authentication token."""
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        return headers

    def health_check(self) -> bool:
        """Check if server is reachable and healthy.

        Returns:
            True if server is healthy, False otherwise
        """
        url = f"{self.base_url}/health"

        response = self.request_handler.request("GET", url, timeout=5)
        if not response:
            logger.error("Health check failed: No response from server")
            return False

        if response.status_code == 200:
            try:
                data = response.json()
                if data.get("status") == "ok":
                    logger.info(f"Health check successful: {data.get('service', 'unknown service')}")
                    return True
            except Exception as e:
                logger.error(f"Health check failed to parse response: {e}")
                return False

        logger.error(f"Health check failed with status: {response.status_code}")
        return False

    def login(self, username: str, password: str) -> bool:
        """Login to the server.

        Args:
            username: Username
            password: Password

        Returns:
            True if login successful, False otherwise
        """
        url = f"{self.base_url}/login"
        request_data = {"username": username, "password": password}

        response = self.request_handler.request("POST", url, data=request_data)
        if not response:
            logger.error("Login failed: No response from server")
            return False

        if response.status_code == 200:
            data = response.json()
            self.token = data.get("access_token")
            self.username = username
            logger.info(f"Login successful for user: {username}")
            return True

        # Log detailed error information
        error_msg = f"Login failed with status: {response.status_code}"
        try:
            error_data = response.json()
            if "detail" in error_data:
                error_msg += f" - {error_data['detail']}"
            elif "message" in error_data:
                error_msg += f" - {error_data['message']}"
        except Exception:
            pass
        logger.error(error_msg)
        return False

    def register(self, username: str, password: str) -> bool:
        """Register a new user.

        Args:
            username: Username
            password: Password

        Returns:
            True if registration successful, False otherwise
        """
        url = f"{self.base_url}/register"
        request_data = {"username": username, "password": password}

        response = self.request_handler.request("POST", url, data=request_data)
        if not response:
            logger.error("Registration failed: No response from server")
            return False

        success = response.status_code == 200
        if success:
            logger.info(f"Registration successful for user: {username}")
        else:
            error_msg = f"Registration failed with status: {response.status_code}"
            try:
                error_data = response.json()
                if "detail" in error_data:
                    error_msg += f" - {error_data['detail']}"
                elif "message" in error_data:
                    error_msg += f" - {error_data['message']}"
            except Exception:
                pass
            logger.error(error_msg)
        return success

    def get_conversations(self, limit: int = 50) -> List[Dict]:
        """Get list of conversations.

        Args:
            limit: Maximum number of conversations to retrieve

        Returns:
            List of conversation dictionaries
        """
        url = f"{self.base_url}/conversations"
        headers = self._get_headers()
        params = {"limit": limit}

        response = self.request_handler.request("GET", url, headers=headers, params=params)
        if not response:
            logger.error("Get conversations failed: No response from server")
            return []

        if response.status_code == 200:
            conversations = response.json()
            if not isinstance(conversations, list):
                logger.error(f"Invalid response format: expected list, got {type(conversations).__name__}")
                raise ValueError(f"Backend returned invalid format: expected list, got {type(conversations).__name__}")
            logger.info(f"Retrieved {len(conversations)} conversations")
            return conversations

        error_msg = f"Get conversations failed with status: {response.status_code}"
        try:
            error_data = response.json()
            if "detail" in error_data:
                error_msg += f" - {error_data['detail']}"
        except Exception:
            pass
        logger.error(error_msg)
        return []

    def get_conversation(
        self, conversation_id: int, limit: int = 50, offset: int = 0
    ) -> Optional[Dict]:
        """Get conversation messages.

        Args:
            conversation_id: Conversation ID
            limit: Maximum number of messages
            offset: Offset for pagination

        Returns:
            Conversation data dictionary
        """
        url = f"{self.base_url}/conversations/{conversation_id}"
        headers = self._get_headers()
        params = {"limit": limit, "offset": offset}

        response = self.request_handler.request("GET", url, headers=headers, params=params)
        if not response:
            logger.error(f"Get conversation {conversation_id} failed: No response from server")
            return None

        if response.status_code == 200:
            logger.info(f"Retrieved conversation {conversation_id}")
            return response.json()

        error_msg = f"Get conversation {conversation_id} failed with status: {response.status_code}"
        try:
            error_data = response.json()
            if "detail" in error_data:
                error_msg += f" - {error_data['detail']}"
        except Exception:
            pass
        logger.error(error_msg)
        return None

    def delete_conversation(self, conversation_id: int) -> bool:
        """Delete a conversation.

        Args:
            conversation_id: Conversation ID

        Returns:
            True if successful, False otherwise
        """
        url = f"{self.base_url}/conversations/{conversation_id}"
        headers = self._get_headers()

        response = self.request_handler.request("DELETE", url, headers=headers)
        if not response:
            logger.error(f"Delete conversation {conversation_id} failed: No response from server")
            return False

        success = response.status_code == 200
        if success:
            logger.info(f"Deleted conversation {conversation_id}")
        else:
            error_msg = f"Delete conversation {conversation_id} failed with status: {response.status_code}"
            try:
                error_data = response.json()
                if "detail" in error_data:
                    error_msg += f" - {error_data['detail']}"
            except Exception:
                pass
            logger.error(error_msg)
        return success

    def get_models(self) -> List[str]:
        """Get available LLM models.

        Returns:
            List of model names
        """
        url = f"{self.base_url}/models"
        headers = self._get_headers()

        response = self.request_handler.request("GET", url, headers=headers)
        if not response:
            logger.error("Get models failed: No response from server")
            return []

        if response.status_code == 200:
            models = response.json().get("models", [])
            logger.info(f"Retrieved {len(models)} models")
            return models

        error_msg = f"Get models failed with status: {response.status_code}"
        try:
            error_data = response.json()
            if "detail" in error_data:
                error_msg += f" - {error_data['detail']}"
        except Exception:
            pass
        logger.error(error_msg)
        return []

    def chat_stream(
        self,
        conversation_id: Optional[int],
        text: str,
        model_name: str,
        chunk_id: Optional[int] = None,
        images: Optional[List[bytes]] = None,
    ) -> Generator[Dict, None, None]:
        """Send chat message and stream responses.

        Args:
            conversation_id: Conversation ID (None = create new conversation)
            text: Message text
            model_name: Model name to use
            chunk_id: Optional chunk ID (None = auto-resume)
            images: Optional list of image bytes

        Yields:
            Message dictionaries from streaming response
        """
        url = f"{self.base_url}/chat"

        # Prepare form data
        files = []
        data = {
            "text": text,
            "model_name": model_name,
        }

        # Add conversation_id if specified
        if conversation_id is not None:
            data["conversation_id"] = str(conversation_id)

        # Add chunk_id if specified
        if chunk_id is not None:
            data["chunk_id"] = str(chunk_id)

        # Add images if provided
        if images:
            for i, img_bytes in enumerate(images):
                files.append(("images", (f"image_{i}.png", img_bytes, "image/png")))

        # Prepare headers
        headers = {}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"

        logger.info(f"Starting chat stream for conversation {conversation_id} with model {model_name}")

        response = self.request_handler.request(
            "POST",
            url,
            data=data,
            files=files if files else None,
            headers=headers,
            stream=True,
            timeout=STREAM_TIMEOUT,
        )

        if not response:
            logger.error(f"Chat stream failed for conversation {conversation_id}: No response from server")
            yield {"error": "Request failed"}
            return

        if response.status_code == 200:
            # Parse streaming JSON lines
            line_count = 0
            for line in response.iter_lines():
                if line:
                    try:
                        data = json.loads(line.decode("utf-8"))
                        line_count += 1
                        yield data
                    except json.JSONDecodeError as e:
                        logger.warning(f"Failed to decode JSON line: {e}")
                        continue
            logger.info(f"Chat stream completed: {line_count} messages received")
        else:
            error_msg = f"Chat stream failed with status: {response.status_code}"
            try:
                error_data = response.json()
                if "detail" in error_data:
                    error_msg += f" - {error_data['detail']}"
            except Exception:
                pass
            logger.error(error_msg)
            yield {"error": f"HTTP {response.status_code}"}

    def get_user_profile(self) -> Optional[Dict]:
        """Get user profile information.

        Returns:
            User profile dictionary
        """
        url = f"{self.base_url}/users/me"
        headers = self._get_headers()

        response = self.request_handler.request("GET", url, headers=headers)
        if not response:
            logger.error("Get user profile failed: No response from server")
            return None

        if response.status_code == 200:
            logger.info("Retrieved user profile")
            return response.json()

        error_msg = f"Get user profile failed with status: {response.status_code}"
        try:
            error_data = response.json()
            if "detail" in error_data:
                error_msg += f" - {error_data['detail']}"
        except Exception:
            pass
        logger.error(error_msg)
        return None
