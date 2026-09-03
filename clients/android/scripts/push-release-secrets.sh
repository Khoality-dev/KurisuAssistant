#!/usr/bin/env bash
#
# Push release-signing secrets to the GitHub repo so the release workflow can sign
# APKs with the same keystore your local builds use.
#
# Reads <repo-root>/.env (created from .env.template) for:
#   KURISU_KEYSTORE             — path to the .jks file (relative to repo root)
#   KURISU_KEYSTORE_PASSWORD
#   KURISU_KEY_ALIAS
#   KURISU_KEY_PASSWORD
#
# Pushes these GitHub Actions secrets:
#   KURISU_KEYSTORE_BASE64      — the .jks file, base64-encoded
#   KURISU_KEYSTORE_PASSWORD
#   KURISU_KEY_ALIAS
#   KURISU_KEY_PASSWORD
#
# Requirements:
#   - GitHub CLI (gh) installed and authenticated (`gh auth status` should pass)
#   - You must be in a git checkout pointing at the right remote, or pass --repo
#
# Usage:
#   scripts/push-release-secrets.sh                # uses the current repo
#   scripts/push-release-secrets.sh --repo OWNER/REPO

set -euo pipefail

# Resolve repo root (one level up from this script)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

ENV_FILE="${REPO_ROOT}/.env"
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "ERROR: ${ENV_FILE} not found. Copy .env.template to .env and fill it in." >&2
  exit 1
fi

# Source .env in a controlled way (only KURISU_* keys, no quotes-stripping needed if values are unquoted)
# shellcheck disable=SC2046
set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

# Validate
require() {
  local name="$1"
  local value="${!name:-}"
  if [[ -z "${value}" ]]; then
    echo "ERROR: ${name} is empty in .env" >&2
    exit 1
  fi
}
require KURISU_KEYSTORE
require KURISU_KEYSTORE_PASSWORD
require KURISU_KEY_ALIAS
require KURISU_KEY_PASSWORD

# Resolve keystore path relative to repo root if not absolute
KEYSTORE_PATH="${KURISU_KEYSTORE}"
if [[ "${KEYSTORE_PATH}" != /* ]]; then
  KEYSTORE_PATH="${REPO_ROOT}/${KEYSTORE_PATH}"
fi
if [[ ! -f "${KEYSTORE_PATH}" ]]; then
  echo "ERROR: Keystore file not found at ${KEYSTORE_PATH}" >&2
  exit 1
fi

# Allow optional --repo OWNER/REPO override
GH_REPO_ARGS=()
if [[ "${1:-}" == "--repo" && -n "${2:-}" ]]; then
  GH_REPO_ARGS=(--repo "$2")
fi

# Sanity check: gh authenticated
if ! gh auth status >/dev/null 2>&1; then
  echo "ERROR: gh CLI is not authenticated. Run 'gh auth login' first." >&2
  exit 1
fi

echo "Encoding keystore: ${KEYSTORE_PATH}"
# Write base64 to a temp file rather than holding it in a shell var; some shells
# (Git Bash on Windows in particular) corrupt long binary-ish strings when piped
# through stdin to gh. `gh secret set --body-file` reads the file directly and
# preserves bytes exactly.
TMP_B64="$(mktemp)"
trap 'rm -f "${TMP_B64}"' EXIT
if base64 -w 0 "${KEYSTORE_PATH}" > "${TMP_B64}" 2>/dev/null; then
  : # GNU coreutils path
else
  base64 "${KEYSTORE_PATH}" | tr -d '\n\r' > "${TMP_B64}"
fi

# Sanity check: decode back and compare bytes to catch any local encoding bug
# before we waste a CI run debugging it.
DECODED_TMP="$(mktemp)"
base64 -d "${TMP_B64}" > "${DECODED_TMP}" 2>/dev/null
if ! cmp -s "${KEYSTORE_PATH}" "${DECODED_TMP}"; then
  rm -f "${DECODED_TMP}"
  echo "ERROR: base64 round-trip didn't match the keystore bytes. Aborting before push." >&2
  exit 1
fi
rm -f "${DECODED_TMP}"

push_secret_file() {
  local name="$1"
  local file="$2"
  echo "Setting ${name}..."
  gh secret set "${name}" "${GH_REPO_ARGS[@]}" < "${file}"
}
push_secret() {
  local name="$1"
  local value="$2"
  echo "Setting ${name}..."
  gh secret set "${name}" "${GH_REPO_ARGS[@]}" --body "${value}"
}

push_secret_file "KURISU_KEYSTORE_BASE64"     "${TMP_B64}"
push_secret      "KURISU_KEYSTORE_PASSWORD"   "${KURISU_KEYSTORE_PASSWORD}"
push_secret      "KURISU_KEY_ALIAS"           "${KURISU_KEY_ALIAS}"
push_secret      "KURISU_KEY_PASSWORD"        "${KURISU_KEY_PASSWORD}"

echo
echo "Done. The release workflow can now sign APKs from these secrets."
echo "Next step: trigger a release (or workflow_dispatch) to verify."
