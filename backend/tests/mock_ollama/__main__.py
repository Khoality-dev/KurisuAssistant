"""``python -m tests.mock_ollama [--host H] [--port P] [--model NAME ...] [--no-auto-pull]``

Runs the mock as a plain process, so a backend started with
``LLM_API_URL=http://127.0.0.1:<port>`` talks to it and a client can be driven
against a real backend that never needs a GPU or a paid model. Script it over
HTTP through ``/_mock/*``.
"""

import argparse

import uvicorn

from .server import DEFAULT_MODEL, MockOllamaState, create_app


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m tests.mock_ollama", description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=11434)
    parser.add_argument("--model", action="append", dest="models", metavar="NAME",
                        help=f"a model to list from the start (repeatable; default {DEFAULT_MODEL})")
    parser.add_argument("--no-auto-pull", action="store_true",
                        help="refuse unknown models instead of adding them on /api/pull")
    args = parser.parse_args()

    state = MockOllamaState(models=args.models or (DEFAULT_MODEL,), auto_pull=not args.no_auto_pull)
    uvicorn.run(create_app(state), host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
