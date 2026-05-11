# Traçabilité Cacao — Ancrage EUDR sur Hyperledger Fabric

## Déploiement robuste sur VM (Patch Docker permanent)

### 1. Correction de dépendance persistante (Object.hasOwn → hasOwnProperty)

**Problème** : Microfab utilise Node.js 16.4, or la dépendance @so-ric/colorspace requiert Object.hasOwn (Node 16.9+). Sans patch, le chaincode crash.

**Solution** : On extrait le fichier corrigé du container et on le monte en volume Docker pour garantir la correction à chaque redémarrage, même après un `docker compose down -v`.

#### Étapes :

1. **Extraction du patch**

```bash
mkdir -p ./infra/docker_patches
docker cp microfab:/opt/microfab/chaincode/node_modules/@so-ric/colorspace/dist/index.cjs.js ./infra/docker_patches/index.cjs.js
```

2. **Ajout du volume dans docker-compose.yml**

```yaml
services:
  microfab:
   ...
   volumes:
    - ./infra/docker_patches/index.cjs.js:/opt/microfab/chaincode/node_modules/@so-ric/colorspace/dist/index.cjs.js
```

3. **Redémarrage complet**

```bash
docker compose down -v
docker compose up -d
```

4. **Vérification**

```bash
docker exec microfab grep hasOwnProperty.call /opt/microfab/chaincode/node_modules/@so-ric/colorspace/dist/index.cjs.js
# Doit retourner au moins une ligne
```

5. **Déploiement du chaincode**

```bash
./deploy-chaincode.sh
```

6. **Test API**

- POST /anchor ou /anchor/bag (voir exemples ci-dessous)
- GET /verify/:lotCodeHash

**Aucune modification n'est faite dans /chaincode : le code source reste portable et propre.**

## Architecture

```
Laravel  →  POST /anchor  →  API Node.js  →  Fabric Gateway  →  Microfab (Ledger)
QR Code  →  GET /verify   →  API Node.js  →  Fabric Gateway  →  Microfab (Ledger)
```

## Démarrage rapide

```bash
# 1. Lancer Microfab + API
docker-compose up -d

# 2. Attendre que Microfab soit healthy (~30s), puis déployer le chaincode
chmod +x deploy-chaincode.sh
./deploy-chaincode.sh

> Microfab déploie les smart contracts via le lifecycle Fabric v2 (package/install/approve/commit).
> Le script exécute le CLI `peer` directement dans le container Microfab via `docker exec`.

# 3. Vérifier la santé
curl http://localhost:3000/health
```

## Exemples d'utilisation

### Test complet API (VM Ready)

#### 1. Ancrage d'un lot

```bash
curl -X POST http://localhost:3000/anchor \
  -H "Content-Type: application/json" \
  -H "X-API-Key: mariuskym" \
  -d '{
    "lotCode": "LOT-FINAL-TEST",
    "quantity": 100,
    "origin": "Abidjan",
    "producer": "Kym Dev Corp",
    "event": "Test de Stabilisation",
    "prevEventHash": "genesis",
    "geoPolygon": {
      "type": "Polygon",
      "coordinates": [[[-4.0, 5.3], [-4.1, 5.4], [-4.1, 5.3], [-4.0, 5.3]]]
    }
  }'
```

#### 2. Vérification de l'ancrage

```bash
curl -X GET "http://localhost:3000/verify/<lotCodeHash>" -H "X-API-Key: mariuskym"
# Remplacer <lotCodeHash> par la valeur retournée lors de l'ancrage
```

#### 3. Test bag-level (EUDR)

```bash
curl -X POST http://localhost:3000/anchor/bag \
  -H "Content-Type: application/json" \
  -H "X-API-Key: mariuskym" \
  -d '{
    "lotCode": "LOT-FINAL-TEST",
    "bagId": "BAG-001-TEST",
    "event": {"type": "scan", "date": "2026-05-11"},
    "prevEventHash": "genesis",
    "geoPolygon": {"type": "Polygon", "coordinates": [[[-4.0, 5.3], [-4.1, 5.4], [-4.1, 5.3], [-4.0, 5.3]]]}
  }'
```

#### 4. Vérification bag-level

```bash
curl -X GET "http://localhost:3000/verify/bag/<lotCodeHash>/<bagIdHash>" -H "X-API-Key: mariuskym"
# Remplacer <lotCodeHash> et <bagIdHash> par les valeurs retournées
```

#### 5. Calcul de hash canonique

```bash
curl -X POST http://localhost:3000/hash/canonical \
  -H "Content-Type: application/json" \
  -H "X-API-Key: mariuskym" \
  -d '{"type": "Polygon", "coordinates": [[[-4.0, 5.3], [-4.1, 5.4], [-4.1, 5.3], [-4.0, 5.3]]]}'
```

### Ancrage d'un lot (depuis Laravel)

```bash
curl -X POST http://localhost:3000/anchor \
  -H "Content-Type: application/json" \
  -H "X-API-Key: mariuskym" \
  -d '{
    "lotCode": "LOT-CACAO-2024-001",
    "event": {
      "type": "creation",
      "farmerId": "HASH_DU_FARMER_ID",
      "weightKg": 250,
      "date": "2024-05-08"
    },
    "prevEventHash": "genesis",
    "geoPolygon": {
      "type": "Polygon",
      "coordinates": [[
        [-4.123, 5.456],
        [-4.120, 5.456],
        [-4.120, 5.453],
        [-4.123, 5.453],
        [-4.123, 5.456]
      ]]
    }
  }'
```

### Vérification publique (scan QR Code)

```bash
# Remplacer par le lotCodeHash retourné lors de l'ancrage
curl http://localhost:3000/verify/a1b2c3... \
  -H "X-API-Key: mariuskym"
```

### Calcul de hash canonique (utilitaire)

```bash
curl -X POST http://localhost:3000/hash/canonical \
  -H "Content-Type: application/json" \
  -H "X-API-Key: mariuskym" \
  -d '{"type": "Polygon", "coordinates": [[[-4.123, 5.456]]]}'
```

## Alignement EUDR

| Exigence EUDR            | Implémentation                                   |
| ------------------------ | ------------------------------------------------ |
| Traçabilité géographique | `geoHash` = SHA-256 du GeoJSON Polygon on-chain  |
| Immuabilité des preuves  | Ledger Fabric (append-only, horodatage certifié) |
| Pas de PII on-chain      | Uniquement des hashes — jamais de données brutes |
| Audit public             | `GET /verify/:lotCodeHash` — timeline complète   |
| Chaînage des événements  | `prevEventHash` — intégrité de la séquence       |
