"""Configuration for KurisuAssistant Qt Client."""

# Server configuration
DEFAULT_SERVER_HOST = "localhost"
DEFAULT_SERVER_PORT = 15597
API_BASE_URL = f"http://{DEFAULT_SERVER_HOST}:{DEFAULT_SERVER_PORT}"

# Client settings
APP_NAME = "KurisuAssistant"
APP_VERSION = "1.0.0"
WINDOW_WIDTH = 1200
WINDOW_HEIGHT = 800

# Chat settings
MAX_MESSAGE_LENGTH = 10000
CHUNK_SIZE = 1024
STREAM_TIMEOUT = 300  # seconds
