# Traçabilité Cacao — Ancrage EUDR sur Hyperledger Fabric

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

# 3. Vérifier la santé
curl http://localhost:3000/health
```

## Exemples d'utilisation

### Ancrage d'un lot (depuis Laravel)

```bash
curl -X POST http://localhost:3000/anchor \
  -H "Content-Type: application/json" \
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
curl http://localhost:3000/verify/a1b2c3...
```

### Calcul de hash canonique (utilitaire)

```bash
curl -X POST http://localhost:3000/hash/canonical \
  -H "Content-Type: application/json" \
  -d '{"type": "Polygon", "coordinates": [[[-4.123, 5.456]]]}'
```

## Alignement EUDR

| Exigence EUDR               | Implémentation                                      |
|-----------------------------|----------------------------------------------------|
| Traçabilité géographique    | `geoHash` = SHA-256 du GeoJSON Polygon on-chain    |
| Immuabilité des preuves     | Ledger Fabric (append-only, horodatage certifié)   |
| Pas de PII on-chain         | Uniquement des hashes — jamais de données brutes   |
| Audit public                | `GET /verify/:lotCodeHash` — timeline complète     |
| Chaînage des événements     | `prevEventHash` — intégrité de la séquence         |
