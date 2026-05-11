"use strict";

// ═══════════════════════════════════════════════════════════════════════════════
// API Express — Passerelle Laravel ↔ Hyperledger Fabric
// Traçabilité Cacao / Conformité EUDR (Règlement UE 2023/1115)
// ═══════════════════════════════════════════════════════════════════════════════

const express = require("express");
const crypto = require("crypto");
const grpc = require("@grpc/grpc-js");
const { connect, hash, signers } = require("@hyperledger/fabric-gateway");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION (variables d'environnement injectées par Docker Compose)
// ─────────────────────────────────────────────────────────────────────────────
const MICROFAB_URL = process.env.MICROFAB_URL || "http://localhost:8080";
const CHANNEL_NAME = process.env.CHANNEL_NAME || "channel1";
const CHAINCODE_NAME = process.env.CHAINCODE_NAME || "cacao-contract";
const MSP_ID = process.env.MSP_ID || "Org1MSP";
// Optionnel (recommandé en Docker Compose): endpoint gRPC direct du peer
// Exemple: FABRIC_PEER_ENDPOINT=microfab:2004
const FABRIC_PEER_ENDPOINT = process.env.FABRIC_PEER_ENDPOINT || null;
// Optionnel: authority gRPC à forcer (utile si Microfab proxifie via :8080)
// Exemple: FABRIC_GRPC_AUTHORITY=org1peer-api.127-0-0-1.nip.io
const FABRIC_GRPC_AUTHORITY = process.env.FABRIC_GRPC_AUTHORITY || null;
const PORT = parseInt(process.env.PORT || "3000", 10);
const API_KEY = process.env.BLOCKCHAIN_API_KEY || null;

// Répertoire temporaire pour les identités récupérées depuis Microfab
const IDENTITY_DIR = "/tmp/cacao-fabric-identity";

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 0 : MIDDLEWARE D'AUTHENTIFICATION PAR API KEY
// ─────────────────────────────────────────────────────────────────────────────
// Vérifie la présence du header X-API-Key sur toutes les routes sauf /health.
// La clé est configurée via la variable d'environnement BLOCKCHAIN_API_KEY.
// ─────────────────────────────────────────────────────────────────────────────
function apiKeyMiddleware(req, res, next) {
  // Le endpoint /health reste public pour les healthchecks Docker
  if (req.path === "/health") {
    return next();
  }

  // Si aucune clé n'est configurée, on bloque tout par sécurité
  if (!API_KEY) {
    return res.status(500).json({
      error:
        "BLOCKCHAIN_API_KEY non configurée. " +
        "Définissez cette variable d'environnement avant d'utiliser l'API.",
    });
  }

  const providedKey = req.headers["x-api-key"];

  if (!providedKey) {
    return res.status(401).json({
      error: "Authentification requise. Envoyez le header X-API-Key.",
    });
  }

  if (providedKey !== API_KEY) {
    return res.status(403).json({
      error: "Clé API invalide.",
    });
  }

  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 : MIDDLEWARE DE HASHING CANONIQUE
// ─────────────────────────────────────────────────────────────────────────────
// Problème : JSON.stringify({"b":1,"a":2}) ≠ JSON.stringify({"a":2,"b":1})
// Solution : Tri récursif des clés avant sérialisation → SHA-256 déterministe.
// Cela garantit que deux représentations du même événement produisent
// toujours le même hash, indépendamment de l'ordre d'insertion des clés.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Trie récursivement les clés d'un objet JSON pour produire une
 * représentation canonique (RFC 8785 simplifié).
 *
 * @param {any} value - Valeur à normaliser (objet, tableau, primitif)
 * @returns {any}     - Structure avec clés triées à tous les niveaux
 */
function sortKeysDeep(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortKeysDeep(value[key]);
        return acc;
      }, {});
  }
  return value;
}

/**
 * Calcule le SHA-256 canonique d'un objet JSON.
 * → Utilisé pour eventHash ET pour geoHash (polygone GeoJSON EUDR).
 *
 * ALIGNEMENT EUDR :
 *   Pour un polygone GeoJSON, passer l'objet GeoJSON complet
 *   (type + coordinates) afin que le hash couvre la géométrie entière.
 *   Ex : { "type": "Polygon", "coordinates": [[[lon, lat], ...]] }
 *
 * @param {object} obj - Objet à hacher
 * @returns {string}   - SHA-256 hexadécimal (64 caractères)
 */
function canonicalHash(obj) {
  const sorted = sortKeysDeep(obj);
  const canonical = JSON.stringify(sorted);
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1b : FONCTIONS UTILITAIRES
// ─────────────────────────────────────────────────────────────────────────────
// Validation du format SHA-256 (64 hex)
const sha256Regex = /^[a-f0-9]{64}$/i;

/**
 * Valide qu'une chaîne est un SHA-256 valide (64 caractères hexadécimaux).
 * Retourne true/false.
 */
function isValidSha256(value) {
  return typeof value === "string" && sha256Regex.test(value);
}

/**
 * Résout le prevEventHash en convertissant "genesis" en hash nul.
 * Vérifie le format SHA-256 pour les autres valeurs.
 * Lance une Error si invalide.
 */
function resolvePrevEventHash(prevEventHash) {
  if (prevEventHash === "genesis") {
    return "0".repeat(64);
  }
  if (!isValidSha256(prevEventHash)) {
    throw new Error(
      "prevEventHash doit être un SHA-256 valide (64 hex) ou 'genesis'.",
    );
  }
  return prevEventHash;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 : BOOTSTRAP FABRIC — Récupération des identités via Microfab
// ─────────────────────────────────────────────────────────────────────────────
// Microfab expose une API REST qui retourne les identités (certificats + clés)
// au démarrage. On les récupère une seule fois et on les persiste sur disque.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Récupère les identités de l'organisation depuis l'API Microfab.
 * Écrit les fichiers cert.pem et key.pem dans IDENTITY_DIR.
 *
 * @returns {{ certPath: string, keyPath: string, peerEndpoint: string, peerGrpcOptions: object }}
 */
async function fetchMicrofabIdentity() {
  fs.mkdirSync(IDENTITY_DIR, { recursive: true });

  // Récupération de la liste des identités disponibles dans Microfab
  const { data: identities } = await axios.get(
    `${MICROFAB_URL}/ak/api/v1/components`,
  );

  // On cible l'admin de l'organisation (Org1 par défaut Microfab)
  const adminIdentity = identities.find(
    (id) =>
      id.msp_id === MSP_ID &&
      id.type === "identity" &&
      id.id === "org1admin",
  );

  if (!adminIdentity) {
    throw new Error(
      `Identité admin introuvable pour MSP_ID=${MSP_ID}. ` +
        "Vérifiez la configuration Microfab.",
    );
  }

  // Décodage Base64 des PEM
  const certPem = Buffer.from(adminIdentity.cert, "base64").toString("utf8");
  const keyPem = Buffer.from(adminIdentity.private_key, "base64").toString(
    "utf8",
  );

  const certPath = path.join(IDENTITY_DIR, "cert.pem");
  const keyPath = path.join(IDENTITY_DIR, "key.pem");

  fs.writeFileSync(certPath, certPem, { mode: 0o600 });
  fs.writeFileSync(keyPath, keyPem, { mode: 0o600 });

  // Récupération de l'endpoint gRPC du peer
  const { data: components } = await axios.get(
    `${MICROFAB_URL}/ak/api/v1/components`,
  );

  const peer = components.find(
    (c) => c.type === "fabric-peer" && c.msp_id === MSP_ID,
  );

  if (!peer) {
    throw new Error(`Peer introuvable pour MSP_ID=${MSP_ID}.`);
  }

  // Microfab expose souvent le Gateway via un reverse-proxy sur le même port
  // que la console (8080) et utilise le routage basé sur l'authority.
  // Le JSON `api_options` contient les channel options gRPC à appliquer.
  const peerApiOptions = peer.api_options || {};
  const peerGrpcOptions = {};
  if (peerApiOptions["grpc.default_authority"]) {
    peerGrpcOptions["grpc.default_authority"] =
      peerApiOptions["grpc.default_authority"];
  }
  if (peerApiOptions["grpc.ssl_target_name_override"]) {
    peerGrpcOptions["grpc.ssl_target_name_override"] =
      peerApiOptions["grpc.ssl_target_name_override"];
  }

  // Extraction du host:port depuis l'URL gRPC exposée par Microfab.
  // IMPORTANT — piège Docker : l'URL retournée peut contenir un hostname
  // "localhost" ou un nom DNS nip.io. Dans un container, ces hostnames
  // peuvent pointer vers le mauvais endroit. On force donc l'hôte à celui
  // de MICROFAB_URL (microfab en Docker Compose, localhost sur la machine).
  const microfabUrl = new URL(MICROFAB_URL);
  const microfabHost = microfabUrl.hostname;

  if (!peer.api_url || typeof peer.api_url !== "string") {
    throw new Error(
      "Microfab n'a pas fourni peer.api_url (URL gRPC). Vérifiez /ak/api/v1/components.",
    );
  }

  const peerUrl = new URL(peer.api_url);
  const peerPort = peerUrl.port || "8080";
  const peerEndpoint = (FABRIC_PEER_ENDPOINT || `${microfabHost}:${peerPort}`).replace(
    /^grpc?s?:\/\//,
    "",
  );

  // Fallback important : si on dial vers microfab:8080 (proxy) depuis Docker,
  // l'authority attendue par Microfab peut être un hostname nip.io. Si Microfab
  // ne fournit pas api_options, on tente de la déduire du hostname de peer.api_url.
  if (
    !peerGrpcOptions["grpc.default_authority"] &&
    !FABRIC_GRPC_AUTHORITY &&
    peerUrl.hostname &&
    peerUrl.hostname !== "localhost" &&
    peerUrl.hostname !== microfabHost
  ) {
    peerGrpcOptions["grpc.default_authority"] = peerUrl.hostname;
  }

  if (FABRIC_GRPC_AUTHORITY) {
    peerGrpcOptions["grpc.default_authority"] = FABRIC_GRPC_AUTHORITY;
  }

  console.log(`[Fabric] Peer endpoint (dial): ${peerEndpoint}`);
  if (peerGrpcOptions["grpc.default_authority"]) {
    console.log(
      `[Fabric] grpc.default_authority: ${peerGrpcOptions["grpc.default_authority"]}`,
    );
  }
  console.log(`[Fabric] Identité admin chargée pour: ${MSP_ID}`);

  return { certPath, keyPath, peerEndpoint, peerGrpcOptions };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 : INITIALISATION DU GATEWAY FABRIC
// ─────────────────────────────────────────────────────────────────────────────

let fabricGateway = null; // Connexion Gateway (singleton)
let fabricNetwork = null; // Référence au canal
let fabricContract = null; // Référence au smart contract

/**
 * Initialise la connexion Fabric Gateway (fabric-gateway v1.x).
 * Appelé une seule fois au démarrage de l'API.
 */
async function initFabricGateway() {
  const { certPath, keyPath, peerEndpoint, peerGrpcOptions } =
    await fetchMicrofabIdentity();

  const certPem = fs.readFileSync(certPath);
  const keyPem = fs.readFileSync(keyPath);

  // Création du client gRPC (sans TLS — Microfab en mode développement)
  const grpcClient = new grpc.Client(
    peerEndpoint,
    grpc.credentials.createInsecure(),
    peerGrpcOptions,
  );

  // Identity : certificat X.509 de l'admin
  const identity = {
    mspId: MSP_ID,
    credentials: certPem,
  };

  // Signer : clé privée ECDSA (P-256) de l'admin
  const privateKey = crypto.createPrivateKey(keyPem);
  const signer = signers.newPrivateKeySigner(privateKey);

  // Connexion au Gateway Fabric
  fabricGateway = connect({
    client: grpcClient,
    identity,
    signer,
    // Hash function utilisée pour les proposals (SHA-256 natif Node.js)
    hash: hash.sha256,
  });

  fabricNetwork = fabricGateway.getNetwork(CHANNEL_NAME);
  fabricContract = fabricNetwork.getContract(
    CHAINCODE_NAME
  );

  console.log(
    `[Fabric] Gateway connecté — canal: ${CHANNEL_NAME}, ` +
      `chaincode: ${CHAINCODE_NAME}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 : APPLICATION EXPRESS
// ─────────────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "1mb" }));

// Middleware de logging minimaliste
app.use((req, _res, next) => {
  console.log(`[API] ${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// Middleware d'authentification par API key
app.use(apiKeyMiddleware);

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT 1 : POST /anchor
// ─────────────────────────────────────────────────────────────────────────────
// Reçoit les données brutes de Laravel, calcule les hashes, ancre on-chain.
// Ce endpoint est conservé pour la compatibilité ascendante (ancrage par lot).
//
// Body JSON attendu :
// {
//   "lotCode"   : "LOT-2024-001",           // Code-lot métier (sera haché)
//   "event"     : { ... },                   // Données de l'événement (création/transfert/exportation)
//   "prevEventHash" : "abc123...",           // Hash de l'événement précédent (ou "genesis" pour le 1er)
//   "geoPolygon": { "type": "Polygon",       // ← ALIGNEMENT EUDR : polygone GeoJSON de la parcelle
//                   "coordinates": [...] }
// }
// ─────────────────────────────────────────────────────────────────────────────
app.post("/anchor", async (req, res) => {
  try {
    const { lotCode, event, prevEventHash, geoPolygon } = req.body;

    // ── Validation des entrées ─────────────────────────────────────────────
    const missing = [];
    if (!lotCode) missing.push("lotCode");
    if (!event) missing.push("event");
    if (!prevEventHash) missing.push("prevEventHash");
    if (!geoPolygon) missing.push("geoPolygon");
    if (missing.length > 0) {
      return res.status(400).json({
        error: `Champs manquants: ${missing.join(", ")}`,
      });
    }

    // Validation EUDR : le polygone doit être un GeoJSON Polygon ou MultiPolygon
    if (!["Polygon", "MultiPolygon"].includes(geoPolygon.type)) {
      return res.status(400).json({
        error: "geoPolygon.type doit être 'Polygon' ou 'MultiPolygon' (EUDR).",
      });
    }

    // ── Calcul des hashes canoniques ──────────────────────────────────────
    // lotCodeHash : hash du code-lot (évite d'exposer l'identifiant métier on-chain)
    const lotCodeHash = canonicalHash({ lotCode });

    // bagIdHash : hash par défaut "lot-level" pour compatibilité
    // On utilise le lotCodeHash comme bagIdHash puisque /anchor ne
    // reçoit pas de bagId individuel
    const bagIdHash = lotCodeHash;

    // eventHash : hash de l'événement complet (données métier sans PII)
    const eventHash = canonicalHash(event);

    // geoHash : hash du polygone GeoJSON
    const geoHash = canonicalHash(geoPolygon);

    // prevEventHash : résolution (genesis → hash nul)
    let resolvedPrevEventHash;
    try {
      resolvedPrevEventHash = resolvePrevEventHash(prevEventHash);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    // ── Soumission de la transaction Fabric ───────────────────────────────
    const resultBytes = await fabricContract.submitTransaction(
      "anchorEvent", // Nom de la fonction du chaincode
      lotCodeHash,
      bagIdHash,
      eventHash,
      resolvedPrevEventHash,
      geoHash,
    );

    const result = JSON.parse(Buffer.from(resultBytes).toString("utf8"));

    // ── Réponse ───────────────────────────────────────────────────────────
    return res.status(201).json({
      success: true,
      // Hashes calculés : à stocker par Laravel pour la vérification future
      computed: {
        lotCodeHash,
        bagIdHash,
        eventHash,
        geoHash,
      },
      onChain: result,
      txId: result.txId,
    });
  } catch (err) {
    console.error("[/anchor]", err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT 2 : POST /anchor/bag
// ─────────────────────────────────────────────────────────────────────────────
// Nouvel endpoint pour la traçabilité granulaire par sac individuel (bag).
// Chaque sac possède son propre bag_id qui est haché canoniquement pour
// générer un bagIdHash. La clé composite stockée est :
//   lotCodeHash__bagIdHash__timestamp
//
// Validation EUDR stricte :
//   Lors du premier ancrage d'un sac (prevEventHash === "genesis"),
//   geoPolygon est OBLIGATOIRE.
//
// Body JSON attendu :
// {
//   "lotCode"       : "LOT-2024-001",       // Code-lot métier (sera haché)
//   "bagId"         : "BAG-001-ABC123",     // Identifiant unique du sac
//   "event"         : { ... },              // Données métier de l'événement
//   "prevEventHash" : "abc123...",          // Hash de l'événement précédent (ou "genesis")
//   "geoPolygon"    : { "type": "Polygon",  // ← EUDR : obligatoire si premier ancrage
//                       "coordinates": [...] }
// }
// ─────────────────────────────────────────────────────────────────────────────
app.post("/anchor/bag", async (req, res) => {
  try {
    const { lotCode, bagId, event, prevEventHash, geoPolygon } = req.body;

    // ── Validation des entrées ─────────────────────────────────────────────
    const missing = [];
    if (!lotCode) missing.push("lotCode");
    if (!bagId) missing.push("bagId");
    if (!event) missing.push("event");
    if (!prevEventHash) missing.push("prevEventHash");
    if (missing.length > 0) {
      return res.status(400).json({
        error: `Champs manquants: ${missing.join(", ")}`,
      });
    }

    // ── Calcul des hashes canoniques ──────────────────────────────────────
    // lotCodeHash : hash canonique du code-lot
    const lotCodeHash = canonicalHash({ lotCode });

    // bagIdHash : hash canonique du bag_id (traçabilité granulaire)
    // Le tri canonique des clés garantit la reproductibilité du hash
    const bagIdHash = canonicalHash({ bagId });

    // eventHash : hash canonique de l'événement métier
    const eventHash = canonicalHash(event);

    // ── Résolution du prevEventHash ───────────────────────────────────────
    let resolvedPrevEventHash;
    try {
      resolvedPrevEventHash = resolvePrevEventHash(prevEventHash);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    // ── Validation EUDR stricte ──────────────────────────────────────────
    // Si c'est le premier ancrage du sac ("genesis"), geoPolygon est
    // OBLIGATOIRE pour prouver l'origine géographique (EUDR Art. 3)
    const isFirstAnchor = prevEventHash === "genesis";

    if (isFirstAnchor) {
      if (!geoPolygon) {
        return res.status(400).json({
          error:
            "EUDR: geoPolygon est obligatoire lors du premier ancrage d'un sac " +
            "(prevEventHash === 'genesis'). Fournissez un objet GeoJSON " +
            "Polygon ou MultiPolygon.",
        });
      }

      // Validation du type GeoJSON
      if (!["Polygon", "MultiPolygon"].includes(geoPolygon.type)) {
        return res.status(400).json({
          error:
            "geoPolygon.type doit être 'Polygon' ou 'MultiPolygon' (EUDR).",
        });
      }

      // Vérification basique des coordonnées
      if (
        !Array.isArray(geoPolygon.coordinates) ||
        geoPolygon.coordinates.length === 0
      ) {
        return res.status(400).json({
          error:
            "EUDR: geoPolygon.coordinates doit être un tableau non vide " +
            "contenant les coordonnées du polygone.",
        });
      }
    }

    // Calcul du geoHash (seulement si geoPolygon fourni)
    let geoHash = null;
    if (geoPolygon) {
      geoHash = canonicalHash(geoPolygon);
    } else {
      // Pour les ancrages ultérieurs sans nouveau polygone,
      // on récupère le dernier geoHash connu du sac
      // en interrogeant l'historique
      try {
        const historyBytes = await fabricContract.evaluateTransaction(
          "getBagHistory",
          lotCodeHash,
          bagIdHash,
        );
        const history = JSON.parse(Buffer.from(historyBytes).toString("utf8"));
        if (history.length > 0) {
          // Prendre le geoHash du dernier événement connu
          const lastEntry = history[history.length - 1];
          geoHash = lastEntry.data.geoHash;
        } else {
          return res.status(400).json({
            error:
              "EUDR: geoPolygon requis. Impossible de récupérer un " +
              "geoHash depuis l'historique du sac.",
          });
        }
      } catch (historyErr) {
        // Pas d'historique (sac inconnu) → geoPolygon requis
        return res.status(400).json({
          error:
            "EUDR: geoPolygon obligatoire. Le sac n'a pas d'ancrage " +
            "préalable et prevEventHash n'est pas 'genesis'.",
        });
      }
    }

    // ── Soumission de la transaction Fabric ───────────────────────────────
    const resultBytes = await fabricContract.submitTransaction(
      "anchorEvent",
      lotCodeHash,
      bagIdHash,
      eventHash,
      resolvedPrevEventHash,
      geoHash,
    );

    const result = JSON.parse(Buffer.from(resultBytes).toString("utf8"));

    // ── Réponse ───────────────────────────────────────────────────────────
    return res.status(201).json({
      success: true,
      computed: {
        lotCodeHash,
        bagIdHash,
        eventHash,
        geoHash,
      },
      onChain: result,
      txId: result.txId,
    });
  } catch (err) {
    console.error("[/anchor/bag]", err);

    // Propagation des erreurs explicites (hash invalide, champ manquant,
    // EUDR) telles que retournées par le chaincode ou la validation API
    if (
      err.message.includes("n'est pas un SHA-256") ||
      err.message.includes("paramètres sont obligatoires") ||
      err.message.includes("EUDR") ||
      err.message.includes("prevEventHash")
    ) {
      return res.status(400).json({ error: err.message });
    }

    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT 3 : GET /verify/:lotCodeHash
// ─────────────────────────────────────────────────────────────────────────────
// Récupère la timeline complète d'un lot depuis le ledger Fabric.
// Utilisé pour la vérification publique (ex : scan d'un QR Code EUDR).
//
// Paramètre URL :
//   lotCodeHash — SHA-256 du code-lot (64 hex)
//
// Réponse : tableau d'entrées historiques, chacune contenant txId,
//           timestamp, eventHash, geoHash (vérifiable par l'auditeur).
// ─────────────────────────────────────────────────────────────────────────────
app.get("/verify/:lotCodeHash", async (req, res) => {
  try {
    const { lotCodeHash } = req.params;

    // Validation du format
    if (!isValidSha256(lotCodeHash)) {
      return res.status(400).json({
        error: "lotCodeHash invalide — doit être un SHA-256 (64 hex).",
      });
    }

    // Appel en lecture seule (evaluateTransaction = pas de consensus requis)
    const resultBytes = await fabricContract.evaluateTransaction(
      "getHistory",
      lotCodeHash,
    );

    const history = JSON.parse(Buffer.from(resultBytes).toString("utf8"));

    // ── Instructions de vérification EUDR pour l'auditeur ────────────────
    return res.status(200).json({
      success: true,
      lotCodeHash,
      historyCount: history.length,
      eudrVerificationNote:
        "Pour vérifier geoHash : calculez SHA-256 canonique du GeoJSON " +
        "Polygon/MultiPolygon et comparez avec data.geoHash de chaque entrée.",
      history,
    });
  } catch (err) {
    // Cas lotCodeHash inconnu : le chaincode lève une erreur explicite
    if (err.message && err.message.includes("aucun enregistrement trouvé")) {
      return res.status(404).json({ error: err.message });
    }
    console.error("[/verify]", err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT 4 : GET /verify/bag/:lotCodeHash/:bagIdHash
// ─────────────────────────────────────────────────────────────────────────────
// Récupère la timeline complète d'un sac spécifique depuis le ledger Fabric.
//
// Paramètres URL :
//   lotCodeHash — SHA-256 du code-lot (64 hex)
//   bagIdHash   — SHA-256 du bag_id (64 hex)
//
// Réponse : tableau d'entrées historiques pour le sac demandé.
// ─────────────────────────────────────────────────────────────────────────────
app.get("/verify/bag/:lotCodeHash/:bagIdHash", async (req, res) => {
  try {
    const { lotCodeHash, bagIdHash } = req.params;

    // Validation du format
    if (!isValidSha256(lotCodeHash)) {
      return res.status(400).json({
        error: "lotCodeHash invalide — doit être un SHA-256 (64 hex).",
      });
    }
    if (!isValidSha256(bagIdHash)) {
      return res.status(400).json({
        error: "bagIdHash invalide — doit être un SHA-256 (64 hex).",
      });
    }

    // Appel en lecture seule
    const resultBytes = await fabricContract.evaluateTransaction(
      "getBagHistory",
      lotCodeHash,
      bagIdHash,
    );

    const history = JSON.parse(Buffer.from(resultBytes).toString("utf8"));

    return res.status(200).json({
      success: true,
      lotCodeHash,
      bagIdHash,
      historyCount: history.length,
      history,
    });
  } catch (err) {
    if (err.message && err.message.includes("aucun enregistrement trouvé")) {
      return res.status(404).json({ error: err.message });
    }
    console.error("[/verify/bag]", err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT 5 : GET /health
// Vérifie que l'API et la connexion Fabric sont opérationnelles.
// (Ce endpoint est public — pas d'API key requise)
// ─────────────────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    fabric: fabricGateway ? "connected" : "disconnected",
    channel: CHANNEL_NAME,
    chaincode: CHAINCODE_NAME,
    timestamp: new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT 6 : POST /hash/canonical  (utilitaire de développement)
// Permet à Laravel de calculer un hash canonique côté serveur
// pour pré-valider avant d'envoyer à /anchor ou /anchor/bag.
// ─────────────────────────────────────────────────────────────────────────────
app.post("/hash/canonical", (req, res) => {
  try {
    if (!req.body || typeof req.body !== "object") {
      return res.status(400).json({ error: "Body JSON requis." });
    }
    const result = canonicalHash(req.body);
    return res.json({ hash: result, algorithm: "SHA-256-canonical" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DÉMARRAGE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Séquence de démarrage :
 * 1. Connexion au Gateway Fabric (récupère identités depuis Microfab)
 * 2. Écoute HTTP
 */
async function main() {
  console.log("[API] Démarrage — Traçabilité Cacao EUDR");
  console.log(`[API] Connexion à Microfab: ${MICROFAB_URL}`);

  // Tentative avec retry exponentiel (max 5 tentatives, ~3 min total)
  const MAX_RETRIES = 5;
  let attempt = 0;

  while (attempt < MAX_RETRIES) {
    try {
      await initFabricGateway();
      break; // Succès → sortir de la boucle
    } catch (err) {
      attempt++;
      if (attempt >= MAX_RETRIES) {
        console.error(`[API] Échec après ${MAX_RETRIES} tentatives. Arrêt.`);
        throw err;
      }
      const delay = Math.min(attempt * 5000, 30000); // 5s, 10s, 15s, 20s, 25s
      console.error(
        `[API] Tentative ${attempt}/${MAX_RETRIES} échouée: ${err.message}`,
      );
      console.error(`[API] Nouvel essai dans ${delay / 1000}s...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  app.listen(PORT, () => {
    console.log(`[API] Serveur démarré sur http://0.0.0.0:${PORT}`);
    console.log(`[API] Endpoints disponibles:`);
    console.log(
      `        POST  /anchor                — Ancrage on-chain (lot)`,
    );
    console.log(
      `        POST  /anchor/bag            — Ancrage granulaire (sac)`,
    );
    console.log(
      `        GET   /verify/:lotCodeHash   — Vérification EUDR (lot)`,
    );
    console.log(
      `        GET   /verify/bag/:lotCodeHash/:bagIdHash — Vérification (sac)`,
    );
    console.log(`        POST  /hash/canonical        — Hash utilitaire`);
    console.log(`        GET   /health                — Statut`);
    console.log(`[API] Authentification: X-API-Key requis (sauf /health)`);
  });

  // Fermeture propre du Gateway à l'arrêt
  process.on("SIGTERM", () => {
    console.log("[API] SIGTERM — fermeture du Gateway Fabric");
    if (fabricGateway) fabricGateway.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[API] Erreur fatale:", err);
  process.exit(1);
});
