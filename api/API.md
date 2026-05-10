# API de Traçabilité Cacao — Documentation Complète

## Vue d'ensemble

API Express faisant office de **passerelle sécurisée** entre l'application Laravel (ERP métier) et le réseau **Hyperledger Fabric** via **Microfab**. Elle permet d'ancrer des preuves cryptographiques on-chain et de vérifier l'historique des lots et sacs de cacao, en conformité avec le **Règlement EUDR 2023/1115** (zéro déforestation).

### Principes fondamentaux

- **Aucune donnée personnelle (PII) ni donnée métier brute** n'est stockée sur la blockchain
- Seules des **empreintes SHA-256** sont inscrites dans le ledger Fabric
- Le **hachage canonique** (tri des clés JSON) garantit la reproductibilité des hashs
- Chaque appel crée un **nouvel enregistrement** — l'historique est immuable et jamais écrasé
- L'authentification est assurée par une **clé API** (header `X-API-Key`)

---

## Table des routes

| Méthode | Route | Description |
|---------|-------|-------------|
| `POST` | `/anchor` | Ancrage on-chain d'un événement (niveau lot) |
| `POST` | `/anchor/bag` | Ancrage granulaire par sac individuel |
| `GET` | `/verify/:lotCodeHash` | Vérification de l'historique d'un lot |
| `GET` | `/verify/bag/:lotCodeHash/:bagIdHash` | Vérification de l'historique d'un sac |
| `POST` | `/hash/canonical` | Utilitaire de calcul de hash canonique |
| `GET` | `/health` | Statut de l'API et de la connexion Fabric |

---

## Authentification

Toutes les routes **sauf `/health`** nécessitent une clé API transmise via le header HTTP :

```
X-API-Key: votrealexiclee
```

La clé est configurée via la variable d'environnement `BLOCKCHAIN_API_KEY` dans Docker Compose.

### Codes d'erreur d'authentification

| Code | Message | Cause |
|------|---------|-------|
| `500` | `BLOCKCHAIN_API_KEY non configurée.` | Variable d'env manquante |
| `401` | `Authentification requise. Envoyez le header X-API-Key.` | Header absent |
| `403` | `Clé API invalide.` | Clé fournie ≠ clé configurée |

---

## Définition des types

### Objet GeoJSON (EUDR)

Conforme au standard [RFC 7946](https://tools.ietf.org/html/rfc7946). Doit être de type `Polygon` ou `MultiPolygon`.

```json
{
  "type": "Polygon",
  "coordinates": [[[lon, lat], [lon, lat], [lon, lat], [lon, lat]]]
}
```

### Hachage canonique `sortKeysDeep`

Fonction de normalisation qui trie récursivement les clés d'un objet JSON avant de calculer le SHA-256. Cela garantit que `{"b":1,"a":2}` et `{"a":2,"b":1}` produisent **le même hash**, indépendamment de l'ordre d'insertion.

---

## 1. POST /anchor

Ancrage on-chain d'un événement au **niveau lot** (compatibilité ascendante).

### Body de la requête

```json
{
  "lotCode": "LOT-2024-001",
  "event": {
    "type": "CREATION",
    "producteur": "Coopérative ABC",
    "quantite": 5000,
    "dateReception": "2024-03-15"
  },
  "prevEventHash": "genesis",
  "geoPolygon": {
    "type": "Polygon",
    "coordinates": [[[ -3.5, 4.2 ], [ -3.4, 4.2 ], [ -3.4, 4.3 ], [ -3.5, 4.3 ], [ -3.5, 4.2 ]]]
  }
}
```

### Champs obligatoires

| Champ | Type | Description |
|-------|------|-------------|
| `lotCode` | `string` | Identifiant métier du lot (sera haché canoniquement) |
| `event` | `object` | Données métier de l'événement (sera haché canoniquement) |
| `prevEventHash` | `string` | SHA-256 de l'événement précédent, ou `"genesis"` pour le premier |
| `geoPolygon` | `object` | **GeoJSON** Polygon/MultiPolygon de la parcelle (EUDR) |

### Réponse succès (HTTP 201)

```json
{
  "success": true,
  "computed": {
    "lotCodeHash": "a1b2c3d4e5f6...",
    "bagIdHash": "a1b2c3d4e5f6...",
    "eventHash": "f6e5d4c3b2a1...",
    "geoHash": "9a8b7c6d5e4f..."
  },
  "onChain": {
    "lotCodeHash": "a1b2c3d4e5f6...",
    "bagIdHash": "a1b2c3d4e5f6...",
    "eventHash": "f6e5d4c3b2a1...",
    "prevEventHash": "00000000...",
    "geoHash": "9a8b7c6d5e4f...",
    "txId": "tx-1234567890abcdef",
    "anchoredAt": "2024-03-15T10:30:00.000Z"
  },
  "txId": "tx-1234567890abcdef"
}
```

> **Note** : `bagIdHash` est égal à `lotCodeHash` pour cet endpoint (ancrage par lot, sans bagId).

### Erreurs possibles

| Code | Message | Cause |
|------|---------|-------|
| `400` | `Champs manquants: lotCode, event, ...` | Champ(s) obligatoire(s) absent(s) |
| `400` | `geoPolygon.type doit être 'Polygon' ou 'MultiPolygon'` | Type GeoJSON invalide |
| `400` | `prevEventHash doit être un SHA-256 valide (64 hex) ou 'genesis'.` | Format SHA-256 invalide |
| `500` | *(message d'erreur chaincode)* | Erreur Fabric ou autre |

---

## 2. POST /anchor/bag

**Nouveau.** Ancrage on-chain d'un événement au **niveau sac individuel** — traçabilité granulaire.

### Body de la requête

```json
{
  "lotCode": "LOT-2024-001",
  "bagId": "BAG-001-ABC123",
  "event": {
    "type": "SCAN_ENTREE",
    "poids": 62.5,
    "qualite": "BIO",
    "operateur": "Jean Kouamé"
  },
  "prevEventHash": "genesis",
  "geoPolygon": {
    "type": "Polygon",
    "coordinates": [[[ -3.5, 4.2 ], [ -3.4, 4.2 ], [ -3.4, 4.3 ], [ -3.5, 4.3 ], [ -3.5, 4.2 ]]]
  }
}
```

### Champs obligatoires

| Champ | Type | Description |
|-------|------|-------------|
| `lotCode` | `string` | Identifiant métier du lot (sera haché canoniquement) |
| `bagId` | `string` | Identifiant unique du sac (sera haché canoniquement) |
| `event` | `object` | Données métier de l'événement (sera haché canoniquement) |
| `prevEventHash` | `string` | SHA-256 de l'événement précédent, ou `"genesis"` pour le premier |

### Validation EUDR stricte

- Si `prevEventHash === "genesis"` (premier ancrage du sac) :
  - **`geoPolygon` est obligatoire** — sert de preuve d'origine géographique (EUDR Art. 3)
  - Le type doit être `Polygon` ou `MultiPolygon`
  - Les `coordinates` doivent être un tableau non vide
- Si `prevEventHash ≠ "genesis"` (ancrage ultérieur) :
  - `geoPolygon` est **optionnel**
  - S'il est absent, le dernier `geoHash` connu du sac est automatiquement récupéré depuis l'historique on-chain
  - Si le sac n'a aucun historique préalable, une erreur est retournée

### Hachage du bagId

Le `bagId` est passé dans un objet `{ bagId: "BAG-001-ABC123" }` puis haché canoniquement :
```javascript
bagIdHash = canonicalHash({ bagId: "BAG-001-ABC123" });
```
Ce mécanisme garantit que le hash est **reproductible** côté Laravel (tri des clés identique).

### Réponse succès (HTTP 201)

```json
{
  "success": true,
  "computed": {
    "lotCodeHash": "a1b2c3d4e5f6...",
    "bagIdHash": "bag-xyz-987...",
    "eventHash": "f6e5d4c3b2a1...",
    "geoHash": "9a8b7c6d5e4f..."
  },
  "onChain": {
    "lotCodeHash": "a1b2c3d4e5f6...",
    "bagIdHash": "bag-xyz-987...",
    "eventHash": "f6e5d4c3b2a1...",
    "prevEventHash": "00000000...",
    "geoHash": "9a8b7c6d5e4f...",
    "txId": "tx-abcdef123456789",
    "anchoredAt": "2024-03-15T10:30:00.000Z"
  },
  "txId": "tx-abcdef123456789"
}
```

### Erreurs possibles

| Code | Message | Cause |
|------|---------|-------|
| `400` | `Champs manquants: bagId, ...` | Champ obligatoire absent |
| `400` | `prevEventHash doit être un SHA-256 valide (64 hex) ou 'genesis'.` | Format invalide |
| `400` | `EUDR: geoPolygon est obligatoire lors du premier ancrage d'un sac...` | Premier ancrage sans polygone |
| `400` | `geoPolygon.type doit être 'Polygon' ou 'MultiPolygon' (EUDR).` | Type GeoJSON invalide |
| `400` | `EUDR: geoPolygon.coordinates doit être un tableau non vide...` | Coordonnées manquantes |
| `400` | `anchorEvent: 'bagIdHash' n'est pas un SHA-256 valide (64 hex).` | Erreur hash côté chaincode |
| `500` | *(message d'erreur)* | Erreur interne |

---

## 3. GET /verify/:lotCodeHash

Récupère la **timeline complète** de tous les événements (tous sacs confondus) associés à un lot donné.

### Paramètre URL

| Paramètre | Type | Description |
|-----------|------|-------------|
| `lotCodeHash` | `string` | SHA-256 (64 hex) du code-lot |

### Exemple

```
GET /verify/a1b2c3d4e5f6...
```

### Réponse succès (HTTP 200)

```json
{
  "success": true,
  "lotCodeHash": "a1b2c3d4e5f6...",
  "historyCount": 3,
  "eudrVerificationNote": "Pour vérifier geoHash : calculez SHA-256 canonique du GeoJSON Polygon/MultiPolygon et comparez avec data.geoHash de chaque entrée.",
  "history": [
    {
      "key": "a1b2...__bag-...__1710493800000",
      "txId": "tx-111111...",
      "timestamp": "2024-03-15T10:30:00.000Z",
      "isDelete": false,
      "data": {
        "lotCodeHash": "a1b2...",
        "bagIdHash": "bag-...",
        "eventHash": "f6e5...",
        "prevEventHash": "0000...",
        "geoHash": "9a8b...",
        "txId": "tx-111111...",
        "anchoredAt": "2024-03-15T10:30:00.000Z"
      }
    }
  ]
}
```

### Erreurs possibles

| Code | Message | Cause |
|------|---------|-------|
| `400` | `lotCodeHash invalide — doit être un SHA-256 (64 hex).` | Format invalide |
| `404` | `getHistory: aucun enregistrement trouvé pour lotCodeHash=...` | Lot inconnu |

---

## 4. GET /verify/bag/:lotCodeHash/:bagIdHash

**Nouveau.** Récupère la **timeline complète** des événements d'un **sac spécifique**.

### Paramètres URL

| Paramètre | Type | Description |
|-----------|------|-------------|
| `lotCodeHash` | `string` | SHA-256 (64 hex) du code-lot |
| `bagIdHash` | `string` | SHA-256 (64 hex) du bag_id |

### Exemple

```
GET /verify/a1b2c3d4e5f6.../bag-xyz-987...
```

### Réponse succès (HTTP 200)

```json
{
  "success": true,
  "lotCodeHash": "a1b2c3d4e5f6...",
  "bagIdHash": "bag-xyz-987...",
  "historyCount": 2,
  "history": [
    {
      "key": "a1b2...__bag-xyz...__1710493800000",
      "txId": "tx-aaa...",
      "timestamp": "2024-03-15T10:30:00.000Z",
      "isDelete": false,
      "data": {
        "lotCodeHash": "a1b2...",
        "bagIdHash": "bag-xyz...",
        "eventHash": "f6e5...",
        "prevEventHash": "0000...",
        "geoHash": "9a8b...",
        "txId": "tx-aaa...",
        "anchoredAt": "2024-03-15T10:30:00.000Z"
      }
    }
  ]
}
```

### Erreurs possibles

| Code | Message | Cause |
|------|---------|-------|
| `400` | `lotCodeHash invalide — doit être un SHA-256 (64 hex).` | Format lotCodeHash invalide |
| `400` | `bagIdHash invalide — doit être un SHA-256 (64 hex).` | Format bagIdHash invalide |
| `404` | *(message chaincode)* | Sac inconnu |

---

## 5. POST /hash/canonical

Utilitaire permettant à Laravel (ou tout client) de **calculer un hash canonique** côté serveur avant d'envoyer une requête à `/anchor` ou `/anchor/bag`.

### Body de la requête

N'importe quel objet JSON :

```json
{
  "lotCode": "LOT-2024-001"
}
```

### Réponse succès (HTTP 200)

```json
{
  "hash": "a1b2c3d4e5f6...",
  "algorithm": "SHA-256-canonical"
}
```

### Utilisation typique

```javascript
// Côté Laravel — pré-calcul du lotCodeHash
const lotCodeHash = await axios.post(
  `${API_URL}/hash/canonical`,
  { lotCode: "LOT-2024-001" },
  { headers: { "X-API-Key": API_KEY } }
);
// lotCodeHash = "a1b2c3d4e5f6..."
```

---

## 6. GET /health

Endpoint public (sans authentification) pour les healthchecks Docker.

### Réponse (HTTP 200)

```json
{
  "status": "ok",
  "fabric": "connected",
  "channel": "cacao-channel",
  "chaincode": "cacao-contract",
  "timestamp": "2024-03-15T10:30:00.000Z"
}
```

---

## Structure des clés on-chain (Smart Contract)

### Clé composite

Format : `{lotCodeHash}__{bagIdHash}__{timestampMs}`

```
a1b2c3d4e5f6...__bag-xyz-987...__1710493800000
```

- `lotCodeHash` : SHA-256 canonique du code-lot
- `bagIdHash` : SHA-256 canonique du bag_id (ou = lotCodeHash pour `/anchor`)
- `timestampMs` : timestamp Unix en millisecondes (certifié par le réseau Fabric)

Cette structure garantit :
- L'**immuabilité** : chaque scan génère une nouvelle clé unique
- La **rétrocompatibilité** : `getHistory(lotCodeHash)` retrouve toutes les entrées via le préfixe
- La **traçabilité granulaire** : `getBagHistory(lotCodeHash, bagIdHash)` retrouve les entrées d'un sac via le préfixe `lotCodeHash__bagIdHash__`

### Enregistrement stocké

```json
{
  "lotCodeHash": "a1b2c3d4e5f6...",
  "bagIdHash": "bag-xyz-987...",
  "eventHash": "f6e5d4c3b2a1...",
  "prevEventHash": "00000000...",
  "geoHash": "9a8b7c6d5e4f...",
  "txId": "tx-abcdef123456789",
  "anchoredAt": "2024-03-15T10:30:00.000Z"
}
```

---

## Architecture de la clé composite

```
┌─────────────────────────────────────────────────────────┐
│                    Clé composite                         │
│  lotCodeHash  ││  bagIdHash  ││  timestampMs            │
│  (SHA-256)    ││  (SHA-256)  ││  (ms Unix)              │
├───────────────┼──────────────┼──────────────────────────┤
│ a1b2c3...     ││ bag-xyz...  ││ 1710493800000           │
└───────────────┴──────────────┴──────────────────────────┘
                     │                     │
                     ▼                     ▼
          getHistory(lotCodeHash)   getBagHistory(lotCodeHash, bagIdHash)
          (préfixe lotCodeHash__)   (préfixe lotCodeHash__bagIdHash__)
```

---

## Workflow d'intégration Laravel

### 1. Premier ancrage (création d'un sac)

```http
POST /anchor/bag
X-API-Key: sk-xxxxx

{
  "lotCode": "LOT-2024-001",
  "bagId": "BAG-001-ABC123",
  "event": {
    "type": "CREATION",
    "producteur": "Coopérative ABC",
    "poids": 62.5
  },
  "prevEventHash": "genesis",
  "geoPolygon": {
    "type": "Polygon",
    "coordinates": [[[-3.5, 4.2], [-3.4, 4.2], [-3.4, 4.3], [-3.5, 4.3], [-3.5, 4.2]]]
  }
}
```

### 2. Ancrage ultérieur (scan de suivi)

```http
POST /anchor/bag
X-API-Key: sk-xxxxx

{
  "lotCode": "LOT-2024-001",
  "bagId": "BAG-001-ABC123",
  "event": {
    "type": "SCAN_TRANSFERT",
    "destinataire": "Entrepôt Abidjan",
    "date": "2024-03-20"
  },
  "prevEventHash": "f6e5d4c3b2a1..."   // ← hash de l'event précédent
}
```

> `geoPolygon` est optionnel ici — le dernier geoHash connu sera automatiquement hérité de l'historique.

### 3. Stockage côté Laravel

Pour chaque transaction réussie, stocker en base :
- `lotCodeHash` (calculable côté Laravel via `/hash/canonical`)
- `bagIdHash` (calculable côté Laravel via `/hash/canonical`)
- `txId` (identifiant de la transaction Fabric)
- `eventHash` (pour le chaînage des `prevEventHash`)

---

## Codes d'erreur globaux

| Code HTTP | Signification |
|-----------|---------------|
| `200` | Succès (GET) |
| `201` | Succès (POST) |
| `400` | Erreur de validation (champ manquant, format invalide, contrainte EUDR) |
| `401` | Header `X-API-Key` absent |
| `403` | Clé API invalide |
| `404` | Ressource non trouvée (lot ou sac inconnu) |
| `500` | Erreur interne serveur ou Fabric |

---

## Configuration (variables d'environnement)

| Variable | Valeur par défaut | Description |
|----------|-------------------|-------------|
| `MICROFAB_URL` | `http://localhost:8080` | URL de l'API Microfab |
| `CHANNEL_NAME` | `cacao-channel` | Canal Fabric |
| `CHAINCODE_NAME` | `cacao-contract` | Nom du smart contract |
| `MSP_ID` | `CacaoOrgMSP` | Identifiant de l'organisation Fabric |
| `PORT` | `3000` | Port d'écoute HTTP |
| `BLOCKCHAIN_API_KEY` | `null` | Clé API (requise) |

---

## Exemples curl

### Ancrage d'un sac

```bash
curl -X POST http://localhost:3000/anchor/bag \
  -H "Content-Type: application/json" \
  -H "X-API-Key: votrealexiclee" \
  -d '{
    "lotCode": "LOT-2024-001",
    "bagId": "BAG-001-ABC123",
    "event": {"type": "CREATION", "producteur": "Coopérative ABC"},
    "prevEventHash": "genesis",
    "geoPolygon": {
      "type": "Polygon",
      "coordinates": [[[-3.5,4.2],[-3.4,4.2],[-3.4,4.3],[-3.5,4.3],[-3.5,4.2]]]
    }
  }'
```

### Vérification d'un lot

```bash
curl -X GET "http://localhost:3000/verify/a1b2c3d4e5f6..." \
  -H "X-API-Key: votrealexiclee"
```

### Vérification d'un sac

```bash
curl -X GET "http://localhost:3000/verify/bag/a1b2c3d4e5f6.../bag-xyz-987..." \
  -H "X-API-Key: votrealexiclee"
```

### Calcul d'un hash canonique

```bash
curl -X POST http://localhost:3000/hash/canonical \
  -H "Content-Type: application/json" \
  -H "X-API-Key: votrealexiclee" \
  -d '{"bagId": "BAG-001-ABC123"}'
```

### Healthcheck

```bash
curl http://localhost:3000/health
```

---

## Déploiement Docker

Les fichiers sont prêts pour le déploiement via le `docker-compose.yml` existant du projet. L'API est exposée sur le port configuré (`3000` par défaut) et se connecte automatiquement à Microfab au démarrage.

```yaml
# docker-compose.yml (extrait pertinent)
services:
  api:
    build: ./api
    ports:
      - "3000:3000"
    environment:
      - MICROFAB_URL=http://microfab:8080
      - CHANNEL_NAME=cacao-channel
      - CHAINCODE_NAME=cacao-contract
      - MSP_ID=CacaoOrgMSP
      - BLOCKCHAIN_API_KEY=${BLOCKCHAIN_API_KEY}
    depends_on:
      - microfab
```

> **Important** : La variable `BLOCKCHAIN_API_KEY` doit être définie dans l'environnement ou le fichier `.env` avant le déploiement.