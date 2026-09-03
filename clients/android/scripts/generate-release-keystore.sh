#!/usr/bin/env bash
#
# Generate the release signing keystore for the Android client.
#
# This is a one-time setup. The same keystore is reused for every release —
# losing it means you can't ship updates that auto-install over existing builds,
# so back it up somewhere safe (1Password, password manager) once it's created.
#
# Usage:
#   scripts/generate-release-keystore.sh                          # interactive prompts
#   scripts/generate-release-keystore.sh --out path/to/file.jks   # custom output path
#   scripts/generate-release-keystore.sh --alias my-alias         # custom alias
#
# Env vars (skip the matching prompt if set):
#   KEYSTORE_PASSWORD   — store password (also used for key password by default)
#   KEY_PASSWORD        — key password (defaults to KEYSTORE_PASSWORD)
#   DNAME               — full distinguished name, e.g. "CN=Kurisu, OU=Dev, O=Kurisu, L=City, ST=State, C=US"
#
# Requires `keytool` on PATH (ships with any JDK, e.g. the Android Studio JBR).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Defaults
OUT_PATH="${REPO_ROOT}/kurisu-release.jks"
ALIAS="kurisu"
VALIDITY_DAYS=10000  # ~27 years; Play Store recommends >= 25 years

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)
      OUT_PATH="$2"; shift 2 ;;
    --alias)
      ALIAS="$2"; shift 2 ;;
    --validity)
      VALIDITY_DAYS="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,20p' "$0"; exit 0 ;;
    *)
      echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# Sanity checks
if ! command -v keytool >/dev/null 2>&1; then
  echo "ERROR: keytool not found on PATH. Install a JDK or set JAVA_HOME and add \$JAVA_HOME/bin to PATH." >&2
  echo "       On Windows with Android Studio:" >&2
  echo "         export JAVA_HOME=\"/c/Program Files/Android/Android Studio/jbr\"" >&2
  echo "         export PATH=\"\$JAVA_HOME/bin:\$PATH\"" >&2
  exit 1
fi

if [[ -e "${OUT_PATH}" ]]; then
  echo "ERROR: ${OUT_PATH} already exists. Refusing to overwrite." >&2
  echo "       Move/delete it first if you really want to regenerate (this invalidates auto-update for existing users)." >&2
  exit 1
fi

# Prompt for passwords if not in env
if [[ -z "${KEYSTORE_PASSWORD:-}" ]]; then
  read -r -s -p "Keystore password (min 6 chars): " KEYSTORE_PASSWORD; echo
  read -r -s -p "Confirm keystore password:        " KEYSTORE_PASSWORD_CONFIRM; echo
  if [[ "${KEYSTORE_PASSWORD}" != "${KEYSTORE_PASSWORD_CONFIRM}" ]]; then
    echo "ERROR: passwords do not match." >&2; exit 1
  fi
fi
if [[ ${#KEYSTORE_PASSWORD} -lt 6 ]]; then
  echo "ERROR: keystore password must be at least 6 characters." >&2; exit 1
fi
KEY_PASSWORD="${KEY_PASSWORD:-${KEYSTORE_PASSWORD}}"

# Prompt for DN if not in env
if [[ -z "${DNAME:-}" ]]; then
  echo
  echo "Distinguished name for the certificate (used for identification, not validation)."
  echo "You can press Enter to accept the defaults — these don't need to be real."
  read -r -p "  Common Name (CN)              [Kurisu Assistant]: " CN
  read -r -p "  Organizational Unit (OU)      [Dev]:               " OU
  read -r -p "  Organization (O)              [Kurisu]:            " O
  read -r -p "  Locality / City (L)           [Unknown]:           " L
  read -r -p "  State / Province (ST)         [Unknown]:           " ST
  read -r -p "  Country (C, two-letter)       [US]:                " C
  CN="${CN:-Kurisu Assistant}"; OU="${OU:-Dev}"; O="${O:-Kurisu}"
  L="${L:-Unknown}"; ST="${ST:-Unknown}"; C="${C:-US}"
  DNAME="CN=${CN}, OU=${OU}, O=${O}, L=${L}, ST=${ST}, C=${C}"
fi

# Make sure output dir exists
mkdir -p "$(dirname "${OUT_PATH}")"

echo
echo "Generating keystore..."
echo "  out:      ${OUT_PATH}"
echo "  alias:    ${ALIAS}"
echo "  validity: ${VALIDITY_DAYS} days"
echo "  dname:    ${DNAME}"
echo

keytool -genkeypair -v \
  -keystore "${OUT_PATH}" \
  -alias "${ALIAS}" \
  -keyalg RSA -keysize 2048 \
  -validity "${VALIDITY_DAYS}" \
  -storetype PKCS12 \
  -storepass "${KEYSTORE_PASSWORD}" \
  -keypass "${KEY_PASSWORD}" \
  -dname "${DNAME}"

echo
echo "Keystore created: ${OUT_PATH}"
echo
echo "Fingerprint:"
keytool -list -v \
  -keystore "${OUT_PATH}" \
  -alias "${ALIAS}" \
  -storepass "${KEYSTORE_PASSWORD}" \
  | grep -E "SHA1|SHA256" | head -2

# Compute path relative to repo root for .env friendliness
REL_PATH="${OUT_PATH#${REPO_ROOT}/}"

cat <<EOF

Next:
1. Back up ${OUT_PATH} somewhere safe. If you lose this file you cannot ship
   updates that install over the current build.

2. Fill in <repo-root>/.env (copy from .env.template if it doesn't exist):
     KURISU_KEYSTORE=${REL_PATH}
     KURISU_KEYSTORE_PASSWORD=<the keystore password you just chose>
     KURISU_KEY_ALIAS=${ALIAS}
     KURISU_KEY_PASSWORD=<the key password you just chose>

3. Push the values to GitHub Actions:
     scripts/push-release-secrets.sh
EOF
