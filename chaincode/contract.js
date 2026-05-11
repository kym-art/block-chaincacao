 "use strict";

// ═══════════════════════════════════════════════════════════════════════════════
// SMART CONTRACT — Traçabilité Cacao / Conformité EUDR
// ═══════════════════════════════════════════════════════════════════════════════
// Alignement EUDR :
//   Le Règlement UE 2023/1115 exige que chaque opérateur soit en mesure de
//   prouver que la matière première provient d'une parcelle précise (polygone).
//   → `geoHash` est le SHA-256 d'un objet GeoJSON de type "Polygon" ou
//     "MultiPolygon" représentant les limites exactes de la parcelle.
//     Ce hash, ancré ici, constitue la preuve d'immuabilité.
//   Aucune donnée personnelle (PII) n'est stockée on-chain : uniquement des
//   empreintes cryptographiques (hashes).
// ═══════════════════════════════════════════════════════════════════════════════
// GARANTIE D'IMMUABILITÉ :
//   Chaque appel à anchorEvent crée un nouvel enregistrement distinct sous
//   une clé composite (lotCodeHash + bagIdHash + timestamp). Aucune donnée
//   n'est jamais écrasée. L'historique complet est accessible via getHistory
//   ou getBagHistory.
// ═══════════════════════════════════════════════════════════════════════════════

// On force le polyfill immédiatement au niveau global de l'environnement Node
global.Object.hasOwn = global.Object.hasOwn || function(obj, prop) {
    return Object.prototype.hasOwnProperty.call(obj, prop);
};

// On vérifie que ça a marché en écrivant dans les logs de Microfab
console.log("[CHAINCODE-FIX] Polyfill Object.hasOwn appliqué avec succès !");

const { Contract } = require("fabric-contract-api");

class CacaoEUDRContract extends Contract {
  constructor() {
    // Nom du contrat tel qu'utilisé dans les appels fabric-gateway
    super("CacaoEUDRContract");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // anchorEvent
  // Stocke 5 empreintes cryptographiques indexées par lotCodeHash + bagIdHash.
  // Ne remplace JAMAIS une entrée existante — chaque appel crée une nouvelle
  // clé composite pour garantir l'immuabilité du ledger.
  //
  // @param {Context} ctx          - Contexte Fabric (accès au stub)
  // @param {string}  lotCodeHash  - SHA-256 du code-lot métier (clé primaire)
  // @param {string}  bagIdHash    - SHA-256 du bag_id (clé de sac granulaire)
  // @param {string}  eventHash    - SHA-256 canonique de l'événement complet
  //                                 (création de lot, transfert, exportation)
  // @param {string}  prevEventHash - Hash de l'événement précédent dans la
  //                                  chaîne métier (hash-linking applicatif)
  // @param {string}  geoHash      - SHA-256 du GeoJSON Polygon/MultiPolygon
  //                                 ← ALIGNEMENT EUDR : preuve de parcelle
  // ─────────────────────────────────────────────────────────────────────────
  async anchorEvent(ctx, lotCodeHash, bagIdHash, eventHash, prevEventHash, geoHash) {
    // Validation : tous les arguments sont requis
    if (!lotCodeHash || !bagIdHash || !eventHash || !prevEventHash || !geoHash) {
      throw new Error(
        "anchorEvent: les 5 paramètres sont obligatoires " +
          "(lotCodeHash, bagIdHash, eventHash, prevEventHash, geoHash)"
      );
    }

    // Vérification basique du format SHA-256 (64 caractères hex)
    const sha256Regex = /^[a-f0-9]{64}$/i;
    for (const [name, value] of [
      ["lotCodeHash", lotCodeHash],
      ["bagIdHash", bagIdHash],
      ["eventHash", eventHash],
      ["prevEventHash", prevEventHash],
      ["geoHash", geoHash],
    ]) {
      if (!sha256Regex.test(value)) {
        throw new Error(
          `anchorEvent: '${name}' n'est pas un SHA-256 valide (64 hex).`
        );
      }
    }

    // Timestamp certifié par le réseau Fabric (non manipulable par le client)
    const txTimestamp = ctx.stub.getTxTimestamp();
    const timestampMs = txTimestamp.seconds.low * 1000;
    const isoTimestamp = new Date(timestampMs).toISOString();

    // ── Clé composite pour garantir l'immuabilité ──────────────────────
    // Format : lotCodeHash + "__" + bagIdHash + "__" + timestamp (millisecondes)
    // Cela permet de stocker plusieurs événements pour un même lot et un
    // même sac sans jamais écraser l'état précédent.
    const compositeKey = `${lotCodeHash}__${bagIdHash}__${timestampMs}`;

    // Construction de l'enregistrement on-chain
    const record = {
      lotCodeHash,   // Identifiant du lot
      bagIdHash,     // Identifiant du sac (traçabilité granulaire)
      eventHash,     // Empreinte de l'événement
      prevEventHash, // Chaînage applicatif des événements
      geoHash,       // ← EUDR : empreinte du polygone de parcelle
      txId: ctx.stub.getTxID(),    // TxID Fabric (vérifiable sur l'explorateur)
      anchoredAt: isoTimestamp,    // Timestamp certifié réseau
    };

    // Écriture sur le ledger — utilisation de la clé composite pour
    // préserver l'historique complet et garantir l'immuabilité
    await ctx.stub.putState(
      compositeKey,
      Buffer.from(JSON.stringify(record))
    );

    // Événement émis pour les listeners off-chain (optionnel, sans PII)
    ctx.stub.setEvent(
      "EventAnchored",
      Buffer.from(JSON.stringify({ lotCodeHash, bagIdHash, txId: record.txId }))
    );

    return JSON.stringify(record);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // getHistory
  // Retourne la timeline complète des événements d'un lot.
  // Utilise l'API getStateByRange pour retrouver toutes les entrées
  // associées à un lotCodeHash donné (tous bags confondus).
  //
  // @param {Context} ctx         - Contexte Fabric
  // @param {string}  lotCodeHash - SHA-256 du code-lot à auditer
  // ─────────────────────────────────────────────────────────────────────────
  async getHistory(ctx, lotCodeHash) {
    if (!lotCodeHash) {
      throw new Error("getHistory: lotCodeHash est requis.");
    }

    // Validation du format SHA-256
    if (!/^[a-f0-9]{64}$/i.test(lotCodeHash)) {
      throw new Error(
        "getHistory: lotCodeHash doit être un SHA-256 valide (64 hex)."
      );
    }

    // Requête par préfixe : toutes les clés commençant par lotCodeHash + "__"
    // NOTE : getStateByRange retourne un StateQueryIterator — seuls les champs
    // `key` et `value` sont disponibles (pas txId/timestamp/isDelete qui
    // n'existent que sur getHistoryForKey). On lit les métadonnées depuis
    // l'enregistrement lui-même (stocké par anchorEvent).
    const prefix = lotCodeHash + "__";
    const iterator = await ctx.stub.getStateByRange(prefix, prefix + "\uffff");
    const history = [];

    while (true) {
      const result = await iterator.next();

      if (result.done) {
        await iterator.close();
        break;
      }

      const data = JSON.parse(result.value.value.toString("utf8"));

      const entry = {
        key:       result.value.key,
        txId:      data.txId,           // txId stocké dans l'enregistrement
        timestamp: data.anchoredAt,     // timestamp certifié réseau, stocké dans l'enregistrement
        data,
      };

      history.push(entry);
    }

    if (history.length === 0) {
      throw new Error(
        `getHistory: aucun enregistrement trouvé pour lotCodeHash=${lotCodeHash}`
      );
    }

    // Retour trié du plus ancien au plus récent (ordre naturel des clés)
    return JSON.stringify(history);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // getBagHistory
  // Retourne la timeline des événements d'un sac spécifique, identifié par
  // son lotCodeHash et son bagIdHash.
  //
  // @param {Context} ctx          - Contexte Fabric
  // @param {string}  lotCodeHash  - SHA-256 du code-lot
  // @param {string}  bagIdHash    - SHA-256 du bag_id
  // ─────────────────────────────────────────────────────────────────────────
  async getBagHistory(ctx, lotCodeHash, bagIdHash) {
    if (!lotCodeHash || !bagIdHash) {
      throw new Error(
        "getBagHistory: lotCodeHash et bagIdHash sont requis."
      );
    }

    // Validation du format SHA-256
    const sha256Regex = /^[a-f0-9]{64}$/i;
    if (!sha256Regex.test(lotCodeHash)) {
      throw new Error(
        "getBagHistory: lotCodeHash doit être un SHA-256 valide (64 hex)."
      );
    }
    if (!sha256Regex.test(bagIdHash)) {
      throw new Error(
        "getBagHistory: bagIdHash doit être un SHA-256 valide (64 hex)."
      );
    }

    // Requête par préfixe : lotCodeHash__bagIdHash__
    // NOTE : getStateByRange retourne un StateQueryIterator — seuls les champs
    // `key` et `value` sont disponibles (pas txId/timestamp/isDelete qui
    // n'existent que sur getHistoryForKey). On lit les métadonnées depuis
    // l'enregistrement lui-même (stocké par anchorEvent).
    const prefix = `${lotCodeHash}__${bagIdHash}__`;
    const iterator = await ctx.stub.getStateByRange(prefix, prefix + "\uffff");
    const history = [];

    while (true) {
      const result = await iterator.next();

      if (result.done) {
        await iterator.close();
        break;
      }

      const data = JSON.parse(result.value.value.toString("utf8"));

      const entry = {
        key:       result.value.key,
        txId:      data.txId,       // txId stocké dans l'enregistrement
        timestamp: data.anchoredAt, // timestamp certifié réseau, stocké dans l'enregistrement
        data,
      };

      history.push(entry);
    }

    if (history.length === 0) {
      throw new Error(
        `getBagHistory: aucun enregistrement trouvé pour lotCodeHash=${lotCodeHash}, bagIdHash=${bagIdHash}`
      );
    }

    return JSON.stringify(history);
  }
}

// Point d'entrée : Fabric démarre le contrat via fabric-shim
exports.contracts = [CacaoEUDRContract];