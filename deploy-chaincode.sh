#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════=
# deploy-chaincode.sh — Déploiement du smart contract sur Microfab
#
# Objectif POC: déployer le minimum, de façon reproductible (VM-friendly).
#
# IMPORTANT:
# - Microfab ne déploie pas le chaincode via un endpoint REST.
# - La méthode la plus fiable est le lifecycle Fabric v2 (package → install →
#   approve → commit) via le CLI `peer`.
# - Ce script exécute le CLI `peer` *dans* le container Microfab via `docker exec`.
#   Donc pas besoin d'installer Fabric CLI sur la machine.
# ═════════════════════════════════════════════════════════════════════════════=

set -euo pipefail

MICROFAB_URL="${MICROFAB_URL:-http://localhost:8080}"
MICROFAB_CONTAINER="${MICROFAB_CONTAINER:-microfab}"

CHANNEL="${CHANNEL:-channel1}"

CHAINCODE_NAME="${CHAINCODE_NAME:-cacao-contract}"
CHAINCODE_VERSION="${CHAINCODE_VERSION:-1.0}"
CHAINCODE_SEQUENCE="${CHAINCODE_SEQUENCE:-1}"
CHAINCODE_LANG="${CHAINCODE_LANG:-node}"
CHAINCODE_PATH_IN_CONTAINER="${CHAINCODE_PATH_IN_CONTAINER:-/opt/microfab/chaincode}"

MSP_ID="${MSP_ID:-Org1MSP}"
MSP_CONFIG_PATH="${MSP_CONFIG_PATH:-/opt/microfab/data/admin-org1}"
FABRIC_CFG_PATH_IN_CONTAINER="${FABRIC_CFG_PATH_IN_CONTAINER:-/opt/microfab/data/peer-org1/config}"

# Ports internes Microfab (déduits des logs/config générés)
ORDERER_ADDRESS="${ORDERER_ADDRESS:-localhost:2002}"
PEER_ADDRESS="${PEER_ADDRESS:-localhost:2004}"

PACKAGE_LABEL="${PACKAGE_LABEL:-${CHAINCODE_NAME}_${CHAINCODE_VERSION}}"
PACKAGE_FILE_IN_CONTAINER="${PACKAGE_FILE_IN_CONTAINER:-/tmp/${CHAINCODE_NAME}.tar.gz}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "✗ Commande requise introuvable: $1" >&2
    exit 1
  fi
}

require_cmd docker
require_cmd curl

echo "══════════════════════════════════════════════"
echo " Déploiement chaincode sur Microfab (lifecycle v2)"
echo " Container  : ${MICROFAB_CONTAINER}"
echo " Microfab   : ${MICROFAB_URL}"
echo " Canal      : ${CHANNEL}"
echo " Chaincode  : ${CHAINCODE_NAME}"
echo " Version    : ${CHAINCODE_VERSION}"
echo " Séquence   : ${CHAINCODE_SEQUENCE}"
echo " Peer       : ${PEER_ADDRESS}"
echo " Orderer    : ${ORDERER_ADDRESS}"
echo "══════════════════════════════════════════════"

echo "[1/5] Attente de Microfab..."
until curl -sf "${MICROFAB_URL}/ak/api/v1/health" >/dev/null; do
  echo "      Microfab pas encore prêt, attente 2s..."
  sleep 2
done
echo "      ✓ Microfab est prêt"

if ! docker inspect "${MICROFAB_CONTAINER}" >/dev/null 2>&1; then
  echo "✗ Container Microfab introuvable: ${MICROFAB_CONTAINER}" >&2
  echo "  Lancez d'abord: docker compose up -d" >&2
  exit 1
fi

docker_peer() {
  docker exec \
    -e FABRIC_CFG_PATH="${FABRIC_CFG_PATH_IN_CONTAINER}" \
    -e CORE_PEER_LOCALMSPID="${MSP_ID}" \
    -e CORE_PEER_MSPCONFIGPATH="${MSP_CONFIG_PATH}" \
    -e CORE_PEER_ADDRESS="${PEER_ADDRESS}" \
    -e CORE_PEER_TLS_ENABLED=false \
    "${MICROFAB_CONTAINER}" \
    peer "$@"
}

echo "[2/5] Vérification: chaincode déjà commité ?"
if docker_peer lifecycle chaincode querycommitted --channelID "${CHANNEL}" --name "${CHAINCODE_NAME}" >/dev/null 2>&1; then
  echo "      ✓ Déjà commité sur ${CHANNEL}."
  docker_peer lifecycle chaincode querycommitted --channelID "${CHANNEL}" --name "${CHAINCODE_NAME}" || true
  exit 0
fi
echo "      → Non commité (on continue)"

echo "[3/5] Packaging du chaincode..."
docker exec "${MICROFAB_CONTAINER}" rm -f "${PACKAGE_FILE_IN_CONTAINER}" >/dev/null 2>&1 || true
docker_peer lifecycle chaincode package "${PACKAGE_FILE_IN_CONTAINER}" \
  --path "${CHAINCODE_PATH_IN_CONTAINER}" \
  --lang "${CHAINCODE_LANG}" \
  --label "${PACKAGE_LABEL}"
docker exec "${MICROFAB_CONTAINER}" ls -lh "${PACKAGE_FILE_IN_CONTAINER}" || true

echo "[4/5] Installation + approbation..."
docker_peer lifecycle chaincode install "${PACKAGE_FILE_IN_CONTAINER}"

PACKAGE_ID="$(docker_peer lifecycle chaincode calculatepackageid "${PACKAGE_FILE_IN_CONTAINER}")"
echo "      ✓ Package ID: ${PACKAGE_ID}"

docker_peer lifecycle chaincode approveformyorg \
  -o "${ORDERER_ADDRESS}" \
  --channelID "${CHANNEL}" \
  --name "${CHAINCODE_NAME}" \
  --version "${CHAINCODE_VERSION}" \
  --package-id "${PACKAGE_ID}" \
  --sequence "${CHAINCODE_SEQUENCE}"

echo "[5/5] Commit + vérification..."
docker_peer lifecycle chaincode commit \
  -o "${ORDERER_ADDRESS}" \
  --channelID "${CHANNEL}" \
  --name "${CHAINCODE_NAME}" \
  --version "${CHAINCODE_VERSION}" \
  --sequence "${CHAINCODE_SEQUENCE}" \
  --peerAddresses "${PEER_ADDRESS}"

docker_peer lifecycle chaincode querycommitted --channelID "${CHANNEL}" --name "${CHAINCODE_NAME}"

echo ""
echo "══════════════════════════════════════════════"
echo " ✓ Déploiement terminé"
echo " Test rapide:"
echo "   curl http://localhost:3000/health"
echo "   curl -X POST http://localhost:3000/anchor -H 'X-API-Key: mariuskym' -H 'Content-Type: application/json' -d '{"lotCode":"LOT-TEST-001","event":{"action":"creation"},"prevEventHash":"genesis","geoPolygon":{"type":"Polygon","coordinates":[[[-2.5,5.5],[-2.5,6.0],[-2.0,6.0],[-2.0,5.5],[-2.5,5.5]]]}}'"
echo "══════════════════════════════════════════════"
