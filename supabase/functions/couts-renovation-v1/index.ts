// supabase/functions/couts-renovation-v1/index.ts
// =============================================================
// Mimmoza — Coûts de RÉNOVATION (barème hypothèse, poste par poste)
// Pendant de couts-construction-v1, mais pour le bâti EXISTANT.
//
// Calcul 100 % DÉTERMINISTE : le LLM lit l'état sur les photos et
// transmet la liste des postes + quantités ; cette fonction applique
// les ratios du barème et renvoie une décomposition chiffrée. Aucun
// accès externe, barème statique (à recalibrer périodiquement).
//
// Contrat de sortie (aligné sur couts-construction-v1) :
//   { status: 'ok' | 'no_data' | 'error', summary, stats, source }
//   - ok      : chiffrage produit
//   - no_data : rien de chiffrable (aucun poste reconnu, ni niveau global)
//   - error   : entrée illisible
//
// Secret d'activation côté copilot-chat : COPILOT_FN_COUTS_RENOVATION
// =============================================================

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ─── Barème global (€/m² habitable) — cohérent avec le prompt Mimmoza ───
const NIVEAUX_GLOBAUX: Record<string, { bas: number; haut: number }> = {
  rafraichissement: { bas: 250,  haut: 500 },
  partielle:        { bas: 500,  haut: 900 },
  moyenne:          { bas: 900,  haut: 1400 },
  lourde:           { bas: 1400, haut: 2100 },
  complete:         { bas: 2100, haut: 3200 },
};

// ─── Catalogue des postes ───
type Unite = 'forfait' | 'm2_habitable' | 'm2' | 'm2_toiture' | 'm2_facade' | 'ouverture';
interface PosteDef { libelle: string; unite: Unite; bas: number; haut: number; }

const CATALOGUE: Record<string, PosteDef> = {
  cuisine:            { libelle: 'Cuisine équipée',                     unite: 'forfait',      bas: 5000,  haut: 15000 },
  salle_de_bains:     { libelle: 'Salle de bains complète',            unite: 'forfait',      bas: 5000,  haut: 12000 },
  wc:                 { libelle: 'WC',                                 unite: 'forfait',      bas: 1500,  haut: 3500  },
  chauffage_pac:      { libelle: 'Chauffage (PAC/chaudière + émetteurs)', unite: 'forfait',   bas: 10000, haut: 20000 },
  cuve_fioul:         { libelle: 'Neutralisation/dépose cuve fioul',   unite: 'forfait',      bas: 1000,  haut: 2500  },
  assainissement:     { libelle: 'Assainissement individuel',          unite: 'forfait',      bas: 8000,  haut: 15000 },
  electricite:        { libelle: 'Électricité (mise aux normes)',      unite: 'm2_habitable', bas: 90,    haut: 130   },
  plomberie:          { libelle: 'Plomberie (reprise complète)',       unite: 'm2_habitable', bas: 80,    haut: 120   },
  sols:               { libelle: 'Sols (dépose + pose)',               unite: 'm2',           bas: 50,    haut: 110   },
  peinture:           { libelle: 'Peinture (murs + plafonds)',         unite: 'm2',           bas: 30,    haut: 50    },
  isolation_combles:  { libelle: 'Isolation combles',                  unite: 'm2',           bas: 25,    haut: 60    },
  isolation_murs_iti: { libelle: 'Isolation murs (ITI)',               unite: 'm2',           bas: 50,    haut: 90    },
  toiture:            { libelle: 'Toiture (réfection couverture)',     unite: 'm2_toiture',   bas: 120,   haut: 250   },
  ravalement:         { libelle: 'Ravalement façade',                  unite: 'm2_facade',    bas: 50,    haut: 110   },
  menuiseries:        { libelle: 'Menuiseries ext. (double vitrage)',  unite: 'ouverture',    bas: 500,   haut: 900   },
  piscine:            { libelle: 'Piscine (remise en état / rénovation)', unite: 'forfait',   bas: 8000,  haut: 25000 },
  amenagements_ext:   { libelle: 'Aménagements extérieurs (VRD, clôture, abords)', unite: 'forfait', bas: 5000, haut: 30000 },
};

// ─── Synonymes tolérés (le LLM n'emploie pas toujours la clé exacte) ───
const SYNONYMES: Record<string, string> = {
  cuisine_equipee: 'cuisine',
  salle_de_bain: 'salle_de_bains', sdb: 'salle_de_bains', sde: 'salle_de_bains', bain: 'salle_de_bains',
  toilettes: 'wc',
  chauffage: 'chauffage_pac', pac: 'chauffage_pac', pompe_a_chaleur: 'chauffage_pac', chaudiere: 'chauffage_pac',
  fioul: 'cuve_fioul', cuve: 'cuve_fioul',
  fosse: 'assainissement', anc: 'assainissement', assainissement_individuel: 'assainissement',
  elec: 'electricite', electrique: 'electricite',
  sol: 'sols', revetement_de_sol: 'sols', carrelage: 'sols', parquet: 'sols',
  peintures: 'peinture',
  combles: 'isolation_combles',
  iti: 'isolation_murs_iti', isolation_murs: 'isolation_murs_iti', isolation: 'isolation_murs_iti',
  couverture: 'toiture', charpente: 'toiture',
  facade: 'ravalement',
  fenetres: 'menuiseries', fenetre: 'menuiseries', menuiseries_exterieures: 'menuiseries',
  bassin: 'piscine',
  exterieurs: 'amenagements_ext', jardin: 'amenagements_ext', cloture: 'amenagements_ext', terrassement: 'amenagements_ext', vrd: 'amenagements_ext',
};

const GAMME_COEFF: Record<string, number> = { economique: 0.8, standard: 1.0, premium: 1.35 };

function normalizeKey(raw: string): string | null {
  const base = raw.toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // retire les accents
    .replace(/[^a-z0-9 _]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/ /g, '_');
  if (CATALOGUE[base]) return base;
  if (SYNONYMES[base]) return SYNONYMES[base];
  return null;
}

const round100 = (x: number) => Math.round(x / 100) * 100;
const round5   = (x: number) => Math.round(x / 5) * 5;

interface PosteInput { poste: string; quantite?: number; niveau?: string; hypothese?: string; }
interface Body {
  surface_habitable_m2?: number;
  gamme?: string;
  alea_pct?: number;
  restructuration?: boolean;
  niveau_global?: string;
  postes?: PosteInput[];
}

function compute(body: Body) {
  const surface = Number(body.surface_habitable_m2) || undefined;
  const gamme = (body.gamme ?? 'standard').toLowerCase();
  const coeff = GAMME_COEFF[gamme] ?? 1.0;
  const aleaPct = Math.min(30, Math.max(0, Number(body.alea_pct ?? 12)));

  const lignes: Array<Record<string, unknown>> = [];
  const inconnus: string[] = [];
  const ignores: Array<{ poste: string; motif: string }> = [];
  let sousBas = 0, sousHaut = 0;

  for (const p of Array.isArray(body.postes) ? body.postes : []) {
    if (!p || typeof p.poste !== 'string') continue;
    const key = normalizeKey(p.poste);
    if (!key || !CATALOGUE[key]) { inconnus.push(p.poste); continue; }
    const def = CATALOGUE[key];

    let qte = Number(p.quantite);
    if (!Number.isFinite(qte) || qte <= 0) {
      if (def.unite === 'forfait') qte = 1;                            // 1 exemplaire par défaut
      else if (def.unite === 'm2_habitable' && surface) qte = surface; // repli surface habitable
      else { ignores.push({ poste: def.libelle, motif: 'quantité manquante' }); continue; }
    }

    const bas  = round100(def.bas  * qte * coeff);
    const haut = round100(def.haut * qte * coeff);
    sousBas += bas; sousHaut += haut;
    lignes.push({
      poste: def.libelle, unite: def.unite, quantite: qte,
      niveau: p.niveau ?? null, hypothese: p.hypothese ?? null,
      cout_bas: bas, cout_haut: haut,
    });
  }

  // Mode global : aucun poste exploitable mais niveau + surface fournis.
  let modeGlobal = false;
  if (lignes.length === 0 && body.niveau_global && surface) {
    const n = NIVEAUX_GLOBAUX[String(body.niveau_global).toLowerCase()];
    if (n) {
      modeGlobal = true;
      sousBas  = round100(n.bas  * surface * coeff);
      sousHaut = round100(n.haut * surface * coeff);
      lignes.push({
        poste: `Rénovation ${body.niveau_global} (forfait global)`, unite: 'm2_habitable',
        quantite: surface, niveau: body.niveau_global, hypothese: null,
        cout_bas: sousBas, cout_haut: sousHaut,
        avertissement_mode:
          "FORFAIT GLOBAL, mode le moins précis (fourchette large). À n'utiliser que si aucun " +
          "poste n'est identifiable. Si des postes sont visibles, préférer le chiffrage poste par poste.",
      });
    }
  }

  if (lignes.length === 0) {
    return {
      status: 'no_data',
      summary: inconnus.length
        ? `Aucun poste reconnu au barème (${inconnus.join(', ')}).`
        : "Aucun poste chiffrable : fournis des postes avec quantité, ou un niveau_global + surface.",
      stats: { postes_inconnus: inconnus, postes_ignores: ignores },
    };
  }

  const aleaBas  = round100(sousBas  * aleaPct / 100);
  const aleaHaut = round100(sousHaut * aleaPct / 100);
  let totalBas  = sousBas  + aleaBas;
  let totalHaut = sousHaut + aleaHaut;

  let mo: Record<string, unknown> | null = null;
  if (body.restructuration) {
    const moBas  = round100(totalBas  * 0.08);
    const moHaut = round100(totalHaut * 0.12);
    mo = { pct: '8–12 %', mo_bas: moBas, mo_haut: moHaut };
    totalBas += moBas; totalHaut += moHaut;
  }

  let ratio: { bas: number; haut: number } | null = null;
  let coherence: string | null = null;
  if (surface) {
    ratio = { bas: round5(totalBas / surface), haut: round5(totalHaut / surface) };
    const rMed = (ratio.bas + ratio.haut) / 2;
    coherence =
      rMed < 500  ? 'rafraîchissement' :
      rMed < 900  ? 'rénovation partielle' :
      rMed < 1400 ? 'rénovation moyenne' :
      rMed < 2100 ? 'rénovation lourde' : 'rénovation complète / restructuration';
  }

  const nb = modeGlobal ? 1 : lignes.length;
  const summary =
    `Chiffrage rénovation ≈ ${totalBas.toLocaleString('fr-FR')} – ${totalHaut.toLocaleString('fr-FR')} € ` +
    `(${nb} poste${nb > 1 ? 's' : ''}, gamme ${gamme}${ratio ? `, ~${ratio.bas}–${ratio.haut} €/m²` : ''})` +
    (coherence ? ` — cohérent avec un profil « ${coherence} ».` : '.');

  return {
    status: 'ok',
    summary,
    stats: {
      surface_habitable_m2: surface ?? null,
      gamme,
      alea_pct: aleaPct,
      postes: lignes,
      sous_total_bas: sousBas,  sous_total_haut: sousHaut,
      alea_bas: aleaBas,        alea_haut: aleaHaut,          // MONTANT des aléas (pas le total)
      maitrise_oeuvre: mo,
      total_bas: totalBas,      total_haut: totalHaut,        // total TOUT COMPRIS
      ratio_implicite_eur_m2: ratio,
      coherence,
      postes_inconnus: inconnus,
      postes_ignores: ignores,
      avertissement:
        "Barème rénovation Mimmoza (hypothèse) : ordres de grandeur à confirmer par devis. " +
        "Montants hors taxes (TVA rénovation 5,5 % / 10 % / 20 % selon travaux, à ajouter), " +
        "hors désamiantage/plomb et hors aléas structurels non visibles sur photos." +
        (body.restructuration ? "" : " Honoraires de maîtrise d'œuvre non inclus (restructuration=true pour les provisionner)."),
    },
    source: 'barème rénovation Mimmoza',
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ status: 'error', summary: 'POST only' }), {
      status: 405, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
  try {
    const body = (await req.json()) as Body;
    const out = compute(body ?? {});
    return new Response(JSON.stringify(out), {
      status: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    // Entrée illisible : on renvoie 200 + status:'error' pour un traitement propre côté copilot.
    return new Response(JSON.stringify({
      status: 'error',
      summary: `Entrée illisible : ${e instanceof Error ? e.message : String(e)}`,
    }), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
});