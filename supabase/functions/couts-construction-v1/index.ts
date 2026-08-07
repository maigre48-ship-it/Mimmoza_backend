// supabase/functions/couts-construction-v1/index.ts
// =============================================================
// Mimmoza — COÛT DE CONSTRUCTION INDEXÉ
//
// Rôle : renvoyer un coût de construction chiffré à partir du barème interne
// Mimmoza, ajusté de la tension du marché local (zonage ABC) et réindexé sur
// l'index BT01 de l'INSEE.
//
//   coût €/m² SDP = barème(typologie, gamme)
//                 × coefficient_zone(zone ABC)
//                 × BT01(dernière période) / BT01(période de calibration)
//
// DÉTERMINISTE PAR CONSTRUCTION : aucun chiffre n'est produit par un LLM. La
// fonction expose toutes les valeurs intermédiaires pour que MimmozIA puisse
// restituer le calcul au lieu de l'inventer.
//
// ⚠️ NATURE DE LA DONNÉE — À RELAYER SYSTÉMATIQUEMENT
// Le barème est une HYPOTHÈSE INTERNE Mimmoza, pas une donnée de marché
// sourcée : il n'existe aucune API nationale gratuite de coûts au m². Seul
// l'index BT01 est officiel, et il ne mesure qu'une ÉVOLUTION. Tout montant
// renvoyé doit être présenté comme un ordre de grandeur à confirmer par devis.
//
// HORS PÉRIMÈTRE (v1) : les typologies spécifiques (médico-social/EHPAD,
// hôtellerie, santé) ne sont PAS couvertes par le barème. Une demande de ce
// type doit recevoir un refus explicite, pas un rabattement sur 'tertiaire'.
//
// Déploiement : Dashboard, nom STRICTEMENT « couts-construction-v1 »
// (⚠️ vérifier le champ nom : pas de suffixe -index).
// Secret à créer : COPILOT_FN_COUTS=couts-construction-v1
//
// Contrat : { status, summary, stats, items } — toujours HTTP 200.
// =============================================================

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

const GEO_API = 'https://geo.api.gouv.fr/communes';

// ── Helpers ──────────────────────────────────────────────────
function cors(): HeadersInit {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}
function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...cors(), 'Content-Type': 'application/json; charset=utf-8' },
  });
}
function normStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : undefined;
}
function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}
function readFirstJsonKey(raw: string | undefined | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed === 'object') {
      const first = Object.values(parsed).find((v) => typeof v === 'string');
      if (typeof first === 'string') return first;
    }
  } catch { return raw; }
  return null;
}
function admin(): SupabaseClient {
  // ⚠️ JWT Signing Keys : SUPABASE_SECRET_KEYS en priorité (la legacy → 401).
  const key = readFirstJsonKey(Deno.env.get('SUPABASE_SECRET_KEYS'))
    ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    ?? Deno.env.get('SERVICE_ROLE_KEY');
  const url = Deno.env.get('SUPABASE_URL');
  if (!url || !key) throw new Error('Missing SUPABASE_URL / service role key env');
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'public' },
  });
}

// ── Vocabulaire accepté ──────────────────────────────────────
const TYPOLOGIES = ['maison_individuelle', 'collectif_r2', 'collectif_r4', 'tertiaire'] as const;
const GAMMES = ['economique', 'standard', 'premium'] as const;

/** Synonymes tolérés côté LLM → typologie du barème. */
const ALIAS_TYPOLOGIE: Record<string, string> = {
  maison: 'maison_individuelle', maison_individuelle: 'maison_individuelle',
  pavillon: 'maison_individuelle', villa: 'maison_individuelle',
  collectif: 'collectif_r2', petit_collectif: 'collectif_r2', immeuble: 'collectif_r2',
  collectif_r2: 'collectif_r2', 'r+2': 'collectif_r2',
  collectif_r4: 'collectif_r4', 'r+4': 'collectif_r4', grand_collectif: 'collectif_r4',
  tertiaire: 'tertiaire', bureaux: 'tertiaire', bureau: 'tertiaire', activite: 'tertiaire',
};
/** Typologies EXPLICITEMENT hors barème : on refuse plutôt que d'approximer. */
const HORS_BAREME = [
  'ehpad', 'maison_de_retraite', 'medico_social', 'residence_senior',
  'hopital', 'clinique', 'hotel', 'ecole', 'erp',
];

const ALIAS_GAMME: Record<string, string> = {
  economique: 'economique', eco: 'economique', entree_de_gamme: 'economique',
  standard: 'standard', courant: 'standard', moyen: 'standard',
  premium: 'premium', haut_de_gamme: 'premium', luxe: 'premium',
};

// ── Handler ──────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
  if (req.method !== 'POST') {
    return json({ status: 'error', summary: 'POST only', stats: null, items: [] }, 405);
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* {} */ }

  const typoBrute = normStr(body.typologie) ?? '';
  const gammeBrute = normStr(body.gamme) ?? 'standard';
  const surfaceSdp = num(body.surface_sdp);
  let zone = normStr(body.zone_abc)?.toUpperCase();
  const codeInsee = normStr(body.code_insee);
  const commune = normStr(body.commune);

  // ── Refus explicite des typologies hors barème ──────────────
  const clefTypo = typoBrute.replace(/[\s'-]+/g, '_');
  if (HORS_BAREME.some((h) => clefTypo.includes(h))) {
    return json({
      status: 'no_data',
      summary:
        `Le barème Mimmoza ne couvre PAS la typologie « ${typoBrute} ». Il ne contient que ` +
        `maison individuelle, petit collectif (R+2), collectif (R+4) et tertiaire. ` +
        `Un établissement médico-social, hôtelier ou de santé relève de normes ERP et de ` +
        `lots techniques spécifiques : aucun chiffrage ne peut être approché depuis ce barème. ` +
        `Renvoyer vers un économiste de la construction.`,
      stats: { typologie_demandee: typoBrute, typologies_disponibles: TYPOLOGIES },
      items: [],
    });
  }

  const typologie = ALIAS_TYPOLOGIE[clefTypo];
  const gamme = ALIAS_GAMME[gammeBrute.replace(/[\s'-]+/g, '_')] ?? 'standard';

  if (!typologie) {
    return json({
      status: 'no_data',
      summary:
        `Typologie non reconnue${typoBrute ? ` (« ${typoBrute} »)` : ''}. ` +
        `Valeurs acceptées : ${TYPOLOGIES.join(', ')}.`,
      stats: { typologies_disponibles: TYPOLOGIES, gammes_disponibles: GAMMES },
      items: [],
    });
  }

  let db: SupabaseClient;
  try { db = admin(); }
  catch (e) { return json({ status: 'error', summary: String(e), stats: null, items: [] }); }

  // ── 1. Ligne de barème (millésime le plus récent) ───────────
  const { data: bareme, error: eBareme } = await db
    .from('couts_construction_reference')
    .select('typologie, gamme, millesime, cout_m2_sdp_ht, fourchette_min, fourchette_max, note, source, indice_ref_code, indice_ref_periode')
    .eq('typologie', typologie)
    .eq('gamme', gamme)
    .order('millesime', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (eBareme) console.error('[couts] lecture barème', eBareme.message);
  if (!bareme) {
    return json({
      status: 'no_data',
      summary: `Aucune ligne de barème pour ${typologie} / ${gamme}.`,
      stats: { typologie, gamme }, items: [],
    });
  }

  // ── 2. Zone ABC (fournie, sinon résolue depuis la commune) ──
  let zoneSource = 'fournie';
  if (!zone && (codeInsee || commune)) {
    let insee = codeInsee;
    if (!insee && commune) {
      try {
        const r = await fetch(
          `${GEO_API}?nom=${encodeURIComponent(commune)}&fields=code&limit=1`,
          { signal: AbortSignal.timeout(4000) },
        );
        if (r.ok) {
          const d = await r.json();
          if (Array.isArray(d) && d[0]?.code) insee = String(d[0].code);
        }
      } catch { /* geo.api injoignable */ }
    }
    if (insee) {
      const { data: z } = await db
        .from('zonage_abc').select('zone').eq('code_insee', insee).maybeSingle();
      // ⚠️ nom de colonne 'zone' SUPPOSÉ — à aligner sur la vraie table zonage_abc.
      if (z?.zone) { zone = String(z.zone).toUpperCase(); zoneSource = 'zonage_abc'; }
    }
  }

  let coefZone = 1;
  let zoneAppliquee: string | null = zone ?? null;
  if (zone) {
    const { data: c } = await db
      .from('couts_zone_coefficient')
      .select('coefficient, note')
      .eq('perimetre', 'zone_abc').eq('cle', zone)
      .order('millesime', { ascending: false }).limit(1).maybeSingle();
    if (c?.coefficient != null) coefZone = Number(c.coefficient);
    else zoneAppliquee = null; // zone inconnue du référentiel → pas d'ajustement
  }

  // ── 3. Indexation BT01 ──────────────────────────────────────
  const codeIndice = bareme.indice_ref_code ?? 'BT01';
  const { data: dernier } = await db
    .from('indices_construction')
    .select('periode, valeur, a_verifier')
    .eq('code_indice', codeIndice)
    .order('periode', { ascending: false }).limit(1).maybeSingle();

  const { data: reference } = await db
    .from('indices_construction')
    .select('periode, valeur')
    .eq('code_indice', codeIndice)
    .eq('periode', bareme.indice_ref_periode)
    .maybeSingle();

  let coefIndex = 1;
  let indexationDisponible = false;
  if (dernier?.valeur && reference?.valeur && Number(reference.valeur) > 0) {
    coefIndex = Number(dernier.valeur) / Number(reference.valeur);
    indexationDisponible = true;
  }

  // ── 4. Calcul ───────────────────────────────────────────────
  const base = Number(bareme.cout_m2_sdp_ht);
  const coutM2 = base * coefZone * coefIndex;
  const coutMin = bareme.fourchette_min != null
    ? Number(bareme.fourchette_min) * coefZone * coefIndex : null;
  const coutMax = bareme.fourchette_max != null
    ? Number(bareme.fourchette_max) * coefZone * coefIndex : null;

  const r2 = (n: number) => Math.round(n * 100) / 100;
  const r0 = (n: number) => Math.round(n);

  const total = surfaceSdp != null ? coutM2 * surfaceSdp : null;
  const totalMin = surfaceSdp != null && coutMin != null ? coutMin * surfaceSdp : null;
  const totalMax = surfaceSdp != null && coutMax != null ? coutMax * surfaceSdp : null;

  const avertissements: string[] = [
    "Barème INTERNE Mimmoza : hypothèse d'ordre de grandeur, PAS une donnée de marché sourcée. À confirmer par devis ou par un économiste de la construction.",
    "Montants HT, hors foncier, honoraires de maîtrise d'œuvre, VRD, raccordements, taxes d'urbanisme, frais financiers et aléas — ces postes s'ajoutent au coût travaux.",
  ];
  if (!indexationDisponible) {
    avertissements.push(
      `Indexation ${codeIndice} NON appliquée : indice de référence ou dernière valeur absents de la base. Le montant vaut au millésime ${bareme.millesime} sans réactualisation.`,
    );
  }
  if (dernier?.a_verifier) {
    avertissements.push(
      `La dernière valeur ${codeIndice} en base est marquée « à vérifier » (non recoupée avec la série officielle INSEE).`,
    );
  }
  if (!zoneAppliquee) {
    avertissements.push(
      "Aucune zone ABC appliquée : le coût n'est pas ajusté de la tension du marché local (coefficient neutre 1,00).",
    );
  }
  if (surfaceSdp == null) {
    avertissements.push(
      "Aucune surface de plancher fournie : seul le coût au m² est calculé, pas le montant total.",
    );
  }

  const summary =
    `Coût de construction ${typologie.replace(/_/g, ' ')} / gamme ${gamme} : ` +
    `${r0(coutM2).toLocaleString('fr-FR')} €/m² SDP HT` +
    (coutMin != null && coutMax != null
      ? ` (fourchette ${r0(coutMin).toLocaleString('fr-FR')} – ${r0(coutMax).toLocaleString('fr-FR')} €/m²)` : '') +
    (total != null ? `, soit ${r0(total).toLocaleString('fr-FR')} € HT pour ${surfaceSdp!.toLocaleString('fr-FR')} m² SDP` : '') +
    `. Base barème ${r0(base).toLocaleString('fr-FR')} €/m² (millésime ${bareme.millesime})` +
    (zoneAppliquee ? ` × coefficient zone ${zoneAppliquee} ${coefZone.toFixed(2)}` : '') +
    (indexationDisponible ? ` × indexation ${codeIndice} ${coefIndex.toFixed(4)}` : '') +
    `. ⚠️ Hypothèse Mimmoza, à confirmer par devis.`;

  return json({
    status: 'ok',
    summary,
    stats: {
      typologie, gamme,
      surface_sdp_m2: surfaceSdp ?? null,
      cout_m2_sdp_ht: r2(coutM2),
      cout_m2_min: coutMin != null ? r2(coutMin) : null,
      cout_m2_max: coutMax != null ? r2(coutMax) : null,
      cout_total_ht: total != null ? r0(total) : null,
      cout_total_min: totalMin != null ? r0(totalMin) : null,
      cout_total_max: totalMax != null ? r0(totalMax) : null,
      // Décomposition exposée : MimmozIA restitue le calcul, il ne le refait pas.
      calcul: {
        base_bareme_m2: r2(base),
        millesime_bareme: bareme.millesime,
        coefficient_zone: r2(coefZone),
        zone_abc: zoneAppliquee,
        zone_source: zoneAppliquee ? zoneSource : null,
        indice: codeIndice,
        indice_reference_periode: bareme.indice_ref_periode ?? null,
        indice_reference_valeur: reference?.valeur ?? null,
        indice_dernier_periode: dernier?.periode ?? null,
        indice_dernier_valeur: dernier?.valeur ?? null,
        coefficient_indexation: r2(coefIndex),
        formule: 'coût €/m² = base barème × coefficient zone × (indice dernier / indice référence)',
      },
      note_bareme: bareme.note ?? null,
      source: bareme.source ?? 'barème Mimmoza (hypothèse, à confirmer par devis)',
      avertissements,
      postes_non_inclus: [
        'foncier', 'honoraires de maîtrise d\'œuvre et bureaux d\'études',
        'VRD et raccordements', 'taxes d\'urbanisme', 'frais financiers', 'aléas',
      ],
    },
    items: [],
  });
});