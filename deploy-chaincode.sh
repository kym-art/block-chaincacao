#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# deploy-chaincode.sh — Déploiement du smart contract sur Microfab
# À exécuter UNE SEULE FOIS après le premier lancement de docker-compose up.
# Microfab simplifie drastiquement le déploiement : pas de lifecycle v2
# (approve, commit) requis pour les environnements de développement.
# ═══════════════════════════════════════════════════════════════════════════════

set -e

MICROFAB_URL="${MICROFAB_URL:-http://localhost:8080}"
CHANNEL="${CHANNEL:-cacao-channel}"
CHAINCODE_NAME="${CHAINCODE_NAME:-cacao-contract}"
CHAINCODE_DIR="./chaincode"

echo "══════════════════════════════════════════════"
echo " Déploiement du chaincode EUDR sur Microfab"
echo " Canal     : $CHANNEL"
echo " Chaincode : $CHAINCODE_NAME"
echo " Microfab  : $MICROFAB_URL"
echo "══════════════════════════════════════════════"

# Attendre que Microfab soit prêt
echo "[1/4] Attente de Microfab..."
until curl -sf "${MICROFAB_URL}/ak/api/v1/health" > /dev/null; do
  echo "      Microfab pas encore prêt, attente 5s..."
  sleep 5
done
echo "      ✓ Microfab est prêt"

# Installation des dépendances npm du chaincode
echo "[2/4] Installation des dépendances npm du chaincode..."
(cd "$CHAINCODE_DIR" && npm install --omit=dev)
echo "      ✓ Dépendances installées"

# Packaging du chaincode (tar.gz attendu par Microfab)
echo "[3/4] Packaging du chaincode..."
TMPDIR=$(mktemp -d)
PACKAGE_FILE="${TMPDIR}/${CHAINCODE_NAME}.tar.gz"

# Microfab accepte un tar.gz contenant les fichiers du chaincode à la racine
tar -czf "$PACKAGE_FILE" \
  --exclude="./node_modules/.cache" \
  --exclude="./.git" \
  -C "$CHAINCODE_DIR" .

echo "      ✓ Package créé: $PACKAGE_FILE ($(du -h "$PACKAGE_FILE" | cut -f1))"

# Déploiement via l'API REST Microfab
# Microfab gère automatiquement l'approbation et le commit sur le canal.
echo "[4/4] Déploiement sur le canal $CHANNEL..."

HTTP_CODE=$(curl -s -o /tmp/deploy-response.json -w "%{http_code}" \
  -X PUT \
  "${MICROFAB_URL}/ak/api/v1/channelcontracts/${CHANNEL}" \
  -H "Content-Type: application/octet-stream" \
  -H "X-Chaincode-Name: ${CHAINCODE_NAME}" \
  -H "X-Chaincode-Type: node" \
  --data-binary "@${PACKAGE_FILE}"
)

cat /tmp/deploy-response.json | python3 -m json.tool 2>/dev/null || cat /tmp/deploy-response.json
echo ""

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
  echo "      ✓ Chaincode déployé avec succès (HTTP $HTTP_CODE)"
else
  echo "      ✗ Échec du déploiement (HTTP $HTTP_CODE)"
  exit 1
fi

# Nettoyage
rm -rf "$TMPDIR"

echo ""
echo "══════════════════════════════════════════════"
echo " ✓ Déploiement terminé"
echo " Testez avec :"
echo "   curl http://localhost:3000/health"
echo "   curl -X POST http://localhost:3000/hash/canonical \\"
echo "     -H 'Content-Type: application/json' \\"
echo "     -d '{\"b\": 2, \"a\": 1}'"
echo "══════════════════════════════════════════════"
