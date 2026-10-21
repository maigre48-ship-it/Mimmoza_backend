// ============================================================================
// SYNTHESIS PROMOTEUR V1 - VERSION 1.1.0
// ============================================================================
// Génère une synthèse professionnelle pour comité d'investissement / banque
// Utilise Claude API avec clé depuis Supabase Secrets (Deno.env)
// ============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const VERSION = "1.1.0";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ============================================================================
// TYPES
// ============================================================================

interface ProjectInfo {
  name?: string;
  address?: string;
  city?: string;
  parcelId?: string;
  parcelIds?: string[];
  communeInsee?: string;
  surfaceM2?: number;
  lat?: number;
  lon?: number;
  projectType?: string;
}

interface ModuleData {
  ok?: boolean;
  summary?: string;
  data?: Record<string, unknown>;
}

interface SnapshotData {
  version?: string;
  projectInfo?: ProjectInfo;
  modules?: {
    foncier?: ModuleData;
    market?: ModuleData;
    risks?: ModuleData;
    implantation2d?: ModuleData;
    bilan?: ModuleData;
    plu?: ModuleData;
  };
}

interface SynthesisRequest {
  snapshot: SnapshotData;
  format: 'banque' | 'investisseur' | 'technique';
}

// ============================================================================
// HELPERS
// ============================================================================

function get(obj: unknown, path: string, defaultVal: unknown = null): unknown {
  const keys = path.split('.');
  let current: unknown = obj;
  for (const key of keys) {
    if (current == null || typeof current !== 'object') return defaultVal;
    current = (current as Record<string, unknown>)[key];
  }
  return current ?? defaultVal;
}

function num(val: unknown, decimals = 0): string {
  if (val == null || typeof val !== 'number' || isNaN(val)) return 'N/A';
  return val.toLocaleString('fr-FR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function pct(val: unknown): string {
  if (val == null || typeof val !== 'number' || isNaN(val)) return 'N/A';
  return `${val >= 0 ? '+' : ''}${val.toFixed(1)}%`;
}

// ============================================================================
// PROMPT BUILDER
// ============================================================================

function buildPrompt(snapshot: SnapshotData, format: string): string {
  const project = snapshot.projectInfo || {};
  const foncier = snapshot.modules?.foncier?.data;
  const market = snapshot.modules?.market?.data;
  const risks = snapshot.modules?.risks?.data;
  const implant = snapshot.modules?.implantation2d?.data;
  const bilan = snapshot.modules?.bilan?.data;
  const plu = snapshot.modules?.plu?.data;

  const formatInstructions: Record<string, string> = {
    banque: `Tu es un analyste crédit senior dans une banque. Tu rédiges un RAPPORT DE PRÉSENTATION pour le COMITÉ DE CRÉDIT.
Le ton est professionnel, factuel, orienté risques et garanties.

STRUCTURE OBLIGATOIRE:
## 1. RÉSUMÉ EXÉCUTIF
(5 lignes max: projet, localisation, montant, marge, avis)

## 2. PRÉSENTATION DU PROJET
- Localisation et description du terrain
- Nature de l'opération
- Programme envisagé

## 3. ANALYSE DU MARCHÉ LOCAL
- Dynamique des prix
- Tension offre/demande
- Commercialisation prévisible

## 4. CONFORMITÉ URBANISTIQUE
- Zone PLU et règles applicables
- Respect des contraintes (hauteur, CES, retraits)
- Alertes éventuelles

## 5. ANALYSE DES RISQUES
### 5.1 Risques naturels et technologiques
### 5.2 Risques de marché
### 5.3 Risques réglementaires

## 6. MONTAGE FINANCIER
- Investissement total
- Structure de financement
- Ratio LTV et garanties

## 7. RENTABILITÉ PRÉVISIONNELLE
| Indicateur | Valeur |
|------------|--------|
(tableau avec CA, marge €, marge %, TRI)

## 8. SYNTHÈSE
### ✅ Points forts
### ⚠️ Points de vigilance

## 9. RECOMMANDATION
**AVIS:** (Favorable / Favorable sous réserves / Défavorable)
**Conditions:** (si applicable)
**Motifs:**`,

    investisseur: `Tu es un analyste senior dans un fonds d'investissement immobilier. Tu rédiges un MÉMORANDUM D'INVESTISSEMENT pour le comité.
Le ton est professionnel, orienté création de valeur et rendement.

STRUCTURE OBLIGATOIRE:
## EXECUTIVE SUMMARY
## INVESTMENT HIGHLIGHTS
## LOCALISATION & MARCHÉ
## PROGRAMME IMMOBILIER
## BUSINESS PLAN
## ANALYSE DES RISQUES & MITIGANTS
## INDICATEURS CLÉS
## RECOMMANDATION D'INVESTISSEMENT`,

    technique: `Tu es un directeur de développement chez un promoteur. Tu rédiges une NOTE DE FAISABILITÉ TECHNIQUE.
Le ton est technique, précis, orienté conformité et constructibilité.

STRUCTURE OBLIGATOIRE:
## SYNTHÈSE TECHNIQUE
## SITUATION & DESSERTE
## ANALYSE URBANISTIQUE (PLU)
## CAPACITÉ CONSTRUCTIBLE
## ANALYSE DE MARCHÉ
## RISQUES & CONTRAINTES
## BILAN PRÉVISIONNEL
## CONCLUSION & GO/NO-GO`
  };

  // Build data context
  let dataContext = `
# DONNÉES DU PROJET

## Informations générales
- **Nom du projet:** ${project.name || project.address || 'Non renseigné'}
- **Adresse:** ${project.address || 'Non renseignée'}
- **Commune:** ${project.city || get(foncier, 'communeNom') || get(market, 'meta.commune_nom') || 'Non renseignée'}
- **Code INSEE:** ${project.communeInsee || get(foncier, 'communeInsee') || 'N/A'}
- **Département:** ${get(market, 'meta.departement') || get(risks, 'meta.departement') || 'N/A'}
- **Type de projet:** ${project.projectType || 'Logement collectif'}
- **Référence parcelle:** ${project.parcelId || get(foncier, 'focusParcel') || 'Non renseignée'}
- **Surface terrain:** ${project.surfaceM2 ? num(project.surfaceM2) + ' m²' : get(foncier, 'totalSurface') ? num(get(foncier, 'totalSurface') as number) + ' m²' : 'Non renseignée'}
`;

  // Foncier data
  if (foncier) {
    const parcels = get(foncier, 'parcels') as Array<{id?: string; area_m2?: number}> | null;
    if (parcels && parcels.length > 0) {
      dataContext += `
## Foncier
- Nombre de parcelles: ${parcels.length}
- Surface totale: ${num(get(foncier, 'totalSurface'))} m²
- Parcelles: ${parcels.map(p => p.id || 'N/A').join(', ')}
`;
    }
  }

  // Market data
  if (market) {
    dataContext += `
## Étude de marché
- **Score global marché:** ${num(get(market, 'scores.global'))}/100
- **Score demande:** ${num(get(market, 'scores.demande'))}/100
- **Score offre:** ${num(get(market, 'scores.offre'))}/100  
- **Score accessibilité:** ${num(get(market, 'scores.accessibilite'))}/100
- **Score environnement:** ${num(get(market, 'scores.environnement'))}/100

### DVF (Transactions immobilières)
- Nombre de transactions: ${num(get(market, 'core.dvf.nb_transactions'))}
- Prix médian/m²: ${num(get(market, 'core.dvf.prix_m2_median'))} €
- Prix moyen/m²: ${num(get(market, 'core.dvf.prix_m2_moyen'))} €
- Évolution 1 an: ${pct(get(market, 'core.dvf.evolution_prix_1an'))}

### Démographie (INSEE)
- Population: ${num(get(market, 'core.insee.population'))} habitants
- Densité: ${num(get(market, 'core.insee.densite'))} hab/km²
- Revenu médian: ${num(get(market, 'core.insee.revenu_median'))} €
- Taux de chômage: ${get(market, 'core.insee.taux_chomage') || 'N/A'}%
- Part propriétaires: ${get(market, 'core.insee.part_proprietaires') || 'N/A'}%
`;

    const marketInsights = get(market, 'insights') as Array<{type?: string; message?: string}> | null;
    if (marketInsights && Array.isArray(marketInsights) && marketInsights.length > 0) {
      dataContext += `\n### Insights marché\n`;
      marketInsights.slice(0, 8).forEach(i => {
        dataContext += `- [${i.type?.toUpperCase() || 'INFO'}] ${i.message}\n`;
      });
    }
  } else {
    dataContext += `\n## Étude de marché\n*Données non disponibles*\n`;
  }

  // Risk data
  if (risks) {
    dataContext += `
## Analyse des risques
- **Score risque global:** ${num(get(risks, 'scores.global'))}/100 *(0 = aucun risque, 100 = risque max)*
- **Risques naturels:** ${num(get(risks, 'scores.naturels'))}/100
- **Risques technologiques:** ${num(get(risks, 'scores.technologiques'))}/100
- **Pollution:** ${num(get(risks, 'scores.pollution'))}/100
- **Risques géotechniques:** ${num(get(risks, 'scores.geotechniques'))}/100

### Détail
- Zone sismique: ${get(risks, 'data.seisme.zone') || 'N/A'} - ${get(risks, 'data.seisme.libelle') || ''}
- PPRI: ${get(risks, 'data.inondation.ppri') ? '⚠️ OUI' : '✅ NON'}
- Niveau risque inondation: ${get(risks, 'data.inondation.risk_level') || 'N/A'}
- Arrêtés CATNAT: ${num(get(risks, 'data.gaspar.catnat_count'))}
- PPR actifs: ${num(get(risks, 'data.gaspar.ppr_count'))}
- Sites SEVESO seuil haut: ${num(get(risks, 'data.icpe.seveso_haut_count'))}
- Sites SEVESO seuil bas: ${num(get(risks, 'data.icpe.seveso_bas_count'))}
- Classe radon: ${get(risks, 'data.radon.classe_potentiel') || 'N/A'}
- Argiles: ${get(risks, 'data.argiles.niveau_alea') || 'N/A'}
`;

    const riskInsights = get(risks, 'insights') as Array<{type?: string; message?: string}> | null;
    if (riskInsights && Array.isArray(riskInsights) && riskInsights.length > 0) {
      dataContext += `\n### Alertes risques\n`;
      riskInsights.slice(0, 8).forEach(i => {
        dataContext += `- [${i.type?.toUpperCase() || 'INFO'}] ${i.message}\n`;
      });
    }
  } else {
    dataContext += `\n## Analyse des risques\n*Données non disponibles*\n`;
  }

  // PLU / Implantation 2D
  if (implant || plu) {
    dataContext += `
## Implantation & Urbanisme
### Parcelle
- Surface terrain: ${num(get(implant, 'parcelle.surface_m2') || get(implant, 'parcel.properties.contenance') || project.surfaceM2)} m²
- Emprise max constructible: ${num(get(implant, 'parcelle.emprise_max_m2'))} m²

### Règles PLU
- Zone: ${get(implant, 'plu.zone') || get(plu, 'zone') || get(plu, 'zone_code') || 'N/A'}
- Hauteur max: ${get(implant, 'plu.hauteur_max') || get(plu, 'hauteur_max_m') || 'N/A'} m
- CES max: ${get(implant, 'plu.ces_max') || get(plu, 'ces_max') ? (((get(implant, 'plu.ces_max') || get(plu, 'ces_max')) as number) * 100).toFixed(0) + '%' : 'N/A'}
- Recul voie: ${get(implant, 'plu.recul_voie') || get(plu, 'recul_voie_m') || 'N/A'} m
- Recul limites: ${get(implant, 'plu.recul_limites') || get(plu, 'recul_limites_m') || 'N/A'} m

### Bâtiment projeté
- Emprise au sol: ${num(get(implant, 'batiment.emprise_m2'))} m²
- Hauteur: ${get(implant, 'batiment.hauteur_m') || 'N/A'} m
- Nombre de niveaux: ${get(implant, 'batiment.niveaux') || 'N/A'}
- Surface de plancher: ${num(get(implant, 'batiment.surface_plancher_m2'))} m²

### Conformité
- **Statut:** ${get(implant, 'conformite.ok') ? '✅ CONFORME AU PLU' : '⚠️ À VÉRIFIER'}
`;
    const alertes = get(implant, 'conformite.alertes') as string[] | null;
    if (alertes && Array.isArray(alertes) && alertes.length > 0) {
      dataContext += `- Alertes: ${alertes.join('; ')}\n`;
    }
  } else {
    dataContext += `\n## Implantation & Urbanisme\n*Données non disponibles*\n`;
  }

  // Bilan financier
  if (bilan) {
    dataContext += `
## Bilan financier prévisionnel

### Investissement foncier
- Prix acquisition: ${num(get(bilan, 'foncier.prix_acquisition'))} €
- Frais de notaire: ${num(get(bilan, 'foncier.frais_notaire'))} €
- **Total foncier:** ${num(get(bilan, 'foncier.total_foncier'))} €

### Construction
- Surface plancher: ${num(get(bilan, 'construction.surface_plancher'))} m²
- Coût construction/m²: ${num(get(bilan, 'construction.cout_m2'))} €
- Coût construction: ${num(get(bilan, 'construction.cout_construction'))} €
- Honoraires: ${num(get(bilan, 'construction.honoraires'))} €
- Provision aléas: ${num(get(bilan, 'construction.aleas'))} €
- **Total construction:** ${num(get(bilan, 'construction.total_construction'))} €

### Financement
- Apport fonds propres: ${num(get(bilan, 'financement.apport'))} €
- Emprunt bancaire: ${num(get(bilan, 'financement.emprunt'))} €
- Taux d'intérêt: ${get(bilan, 'financement.taux') || 'N/A'}%
- Durée: ${get(bilan, 'financement.duree_mois') || 'N/A'} mois
- Frais financiers: ${num(get(bilan, 'financement.interets'))} €

### Commercialisation
- Nombre de lots: ${get(bilan, 'commercialisation.nb_lots') || 'N/A'}
- Prix de vente/m²: ${num(get(bilan, 'commercialisation.prix_m2_vente'))} €
- **Chiffre d'affaires total:** ${num(get(bilan, 'commercialisation.ca_total'))} €

### Résultats prévisionnels
| Indicateur | Valeur |
|------------|--------|
| Coût de revient total | ${num(get(bilan, 'resultats.cout_revient_total'))} € |
| **Marge brute** | ${num(get(bilan, 'resultats.marge_brute'))} € |
| **Taux de marge** | ${get(bilan, 'resultats.marge_pct') ? (get(bilan, 'resultats.marge_pct') as number).toFixed(1) + '%' : 'N/A'} |
| Rentabilité | ${get(bilan, 'resultats.rentabilite') ? (get(bilan, 'resultats.rentabilite') as number).toFixed(1) + '%' : 'N/A'} |
`;
  } else {
    dataContext += `\n## Bilan financier\n*Données non disponibles*\n`;
  }

  // Final prompt
  return `${formatInstructions[format] || formatInstructions.banque}

---

${dataContext}

---

## CONSIGNES DE RÉDACTION
1. Rédige entièrement en français professionnel
2. Utilise les données chiffrées fournies quand disponibles
3. Pour les données manquantes, indique "Non communiqué" ou "À préciser"
4. Sois factuel, objectif, sans superlatifs
5. La synthèse doit faire entre 800 et 1500 mots
6. Utilise le format Markdown avec titres ##, ###, listes et tableaux
7. OBLIGATOIRE: Termine par une recommandation claire et argumentée
8. Pour le format banque: sois conservateur dans l'analyse des risques`;
}

// ============================================================================
// CLAUDE API CALL
// ============================================================================

async function callClaude(prompt: string, apiKey: string): Promise<string> {
  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("[CLAUDE] API Error:", response.status, errorText);
    throw new Error(`Claude API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  
  if (!data.content || !data.content[0] || !data.content[0].text) {
    throw new Error("Invalid response from Claude API");
  }

  return data.content[0].text;
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const startTime = Date.now();

  try {
    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({ success: false, version: VERSION, error: "Method not allowed" }),
        { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ✅ Lire la clé API depuis les secrets Supabase (Deno.env)
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    
    if (!apiKey) {
      console.error("[SYNTHESIS] ANTHROPIC_API_KEY not found in environment");
      return new Response(
        JSON.stringify({ 
          success: false, 
          version: VERSION, 
          error: "Configuration serveur manquante: ANTHROPIC_API_KEY non définie dans les secrets Supabase" 
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const payload: SynthesisRequest = await req.json();

    if (!payload.snapshot) {
      return new Response(
        JSON.stringify({ success: false, version: VERSION, error: "Snapshot data required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const format = payload.format || 'banque';
    
    // Build prompt
    const prompt = buildPrompt(payload.snapshot, format);
    console.log("[SYNTHESIS] Calling Claude API with format:", format);
    console.log("[SYNTHESIS] Project:", payload.snapshot.projectInfo?.address || payload.snapshot.projectInfo?.parcelId);
    
    // Call Claude
    const synthesis = await callClaude(prompt, apiKey);
    
    const duration = Date.now() - startTime;
    console.log(`[SYNTHESIS] Generated in ${duration}ms`);

    // Extract summary metrics
    const project = payload.snapshot.projectInfo || {};
    const foncier = payload.snapshot.modules?.foncier?.data;
    const market = payload.snapshot.modules?.market?.data;
    const risks = payload.snapshot.modules?.risks?.data;
    const bilan = payload.snapshot.modules?.bilan?.data;

    const response = {
      success: true,
      version: VERSION,
      meta: {
        format,
        project_name: project.name || project.address || project.parcelId || "Projet immobilier",
        commune: project.city || get(foncier, 'communeNom') as string || get(market, 'meta.commune_nom') as string || project.communeInsee || undefined,
        generated_at: new Date().toISOString(),
        duration_ms: duration,
        modules_used: {
          foncier: !!foncier,
          market: !!market,
          risks: !!risks,
          implantation: !!payload.snapshot.modules?.implantation2d?.data,
          bilan: !!bilan,
          plu: !!payload.snapshot.modules?.plu?.data,
        },
      },
      summary: {
        market_score: get(market, 'scores.global') as number | null,
        risk_score: get(risks, 'scores.global') as number | null,
        marge_pct: get(bilan, 'resultats.marge_pct') as number | null,
        ca_total: get(bilan, 'commercialisation.ca_total') as number | null,
        surface_plancher: get(bilan, 'construction.surface_plancher') as number | null,
      },
      synthesis,
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("[SYNTHESIS] Error:", err);
    return new Response(
      JSON.stringify({ 
        success: false, 
        version: VERSION, 
        error: String(err),
        hint: "Vérifiez que ANTHROPIC_API_KEY est bien définie dans les secrets Supabase"
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});