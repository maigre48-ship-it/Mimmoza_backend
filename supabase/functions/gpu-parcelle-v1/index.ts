// supabase/functions/gpu-parcelle-v1/index.ts
// Mimmoza — Urbanisme réglementaire au point, via API Carto GPU (IGN, TOKEN-FREE)
// -----------------------------------------------------------------------------
// Rend le copilot AUTONOME sur l'urbanisme : jusqu'ici get_parcel_plu ne savait
// répondre que si un règlement avait été importé à la main sur la page Foncier
// (ctx.plu). Sans import, aucune donnée d'urbanisme. Cette fonction interroge
// directement le Géoportail de l'urbanisme au point demandé.
//
// COUCHES INTERROGÉES (toutes vérifiées en réel le 04/08/2026) :
//   municipality      → name, insee, is_rnu, is_coastline
//   zone-urba         → libelle, libelong, typezone (U/AU/A/N), idurba, nomfic, datvalid
//   prescription-surf → libelle, typepsc, stypepsc   (surfaciques)
//   prescription-lin  → idem                          (linéaires)
//   prescription-pct  → idem                          (ponctuelles)
//   info-surf         → libelle, typeinf, stypeinf    (informations, ex. zonage assainissement)
//
// ⚠️ CE QUE LE GPU NE PORTE PAS : le droit de préemption urbain (DPU) et les ZAD
//   ne sont PAS des couches du standard CNIG et ne sont donc pas interrogeables
//   ici. Toute question de préemption doit être renvoyée à la mairie / au service
//   foncier. Ne jamais laisser croire que l'absence de résultat vaut absence de DPU.
//
// ⚠️ NON-EXHAUSTIVITÉ : le GPU ne contient que ce que la collectivité a numérisé
//   et publié. Une absence de résultat n'est JAMAIS une preuve d'absence de règle.
//
// Contrat compact { status, summary, stats, items }, HTTP 200 toujours.
// -----------------------------------------------------------------------------

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
};

const APICARTO = 'https://apicarto.ign.fr/api/gpu';
const TIMEOUT_MS = 9000;

type Couche =
  | 'municipality' | 'zone-urba'
  | 'prescription-surf' | 'prescription-lin' | 'prescription-pct'
  | 'info-surf';

const COUCHES_DEFAUT: Couche[] = ['municipality', 'zone-urba'];

interface Body {
  latitude?: number;
  longitude?: number;
  couches?: string[];
  limite?: number;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: CORS });
}
function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) { const n = Number(v); return Number.isFinite(n) ? n : null; }
  return null;
}
function s(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t ? t : null;
}

// Libellé métier des grands types de zone (standard CNIG, stable).
const TYPEZONE_SENS: Record<string, string> = {
  U: 'zone urbaine — constructible sous conditions du règlement',
  AU: "zone à urbaniser — constructibilité différée ou conditionnée (souvent OAP et/ou modification du PLU requise)",
  AUc: "zone à urbaniser ouverte (constructible) — sous conditions du règlement et des OAP",
  AUs: "zone à urbaniser fermée (stricte) — NON constructible en l'état, une procédure de modification du PLU est nécessaire",
  A: 'zone agricole — constructibilité très restreinte, réservée pour l\'essentiel à l\'exploitation agricole',
  N: 'zone naturelle et forestière — constructibilité très restreinte',
};

// Repérage HEURISTIQUE des prescriptions à fort impact opérationnel, par mots-clés
// sur le LIBELLÉ OFFICIEL (les codes typepsc ne sont pas décodés : on ne devine pas).
const MOTS_CLES_IMPACT: Array<{ motif: RegExp; enjeu: string }> = [
  { motif: /espace[s]? bois[ée]/i, enjeu: 'Espace boisé classé : coupe et défrichement soumis à autorisation, constructibilité quasi nulle' },
  { motif: /emplacement r[ée]serv/i, enjeu: 'Emplacement réservé : le terrain est grevé au profit d\'une collectivité' },
  { motif: /(mixit[ée] sociale|logement social|accession sociale)/i, enjeu: 'Servitude de mixité sociale : part de logements sociaux ou abordables imposée' },
  { motif: /hauteur/i, enjeu: 'Prescription de hauteur : plafond opposable au projet' },
  { motif: /stationnement/i, enjeu: 'Règle de stationnement spécifique (majorée ou modérée)' },
  { motif: /(pr[ée]emption|zad)/i, enjeu: 'Mention de préemption : à faire confirmer en mairie, le GPU n\'est pas la source de référence du DPU' },
  { motif: /(patrimoine|prot[ée]g[ée]|paysage|site)/i, enjeu: 'Protection patrimoniale ou paysagère : avis ou prescriptions architecturales probables' },
  { motif: /(recul|marge|alignement)/i, enjeu: 'Recul ou alignement imposé : emprise constructible réduite' },
  { motif: /(risque|inondation|al[ée]a)/i, enjeu: 'Prescription liée à un risque : croiser avec les risques Géorisques' },
  { motif: /(v[ée]g[ée]talis|arbre|jardin)/i, enjeu: 'Obligation de pleine terre ou de végétalisation : emprise au sol réduite' },
];

function enjeuDe(libelle: string | null): string | null {
  if (!libelle) return null;
  for (const k of MOTS_CLES_IMPACT) if (k.motif.test(libelle)) return k.enjeu;
  return null;
}

async function couche(nom: Couche, lon: number, lat: number): Promise<any[] | null> {
  const geom = encodeURIComponent(JSON.stringify({ type: 'Point', coordinates: [lon, lat] }));
  const url = `${APICARTO}/${nom}?geom=${geom}`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: ac.signal });
    if (!r.ok) {
      console.error('[gpu]', nom, 'HTTP', r.status);
      return null;
    }
    const fc = await r.json();
    return Array.isArray(fc?.features) ? fc.features : [];
  } catch (e) {
    console.error('[gpu]', nom, 'fail', e instanceof Error ? e.message : String(e));
    return null;   // null = couche en échec ; [] = couche interrogée, rien trouvé
  } finally {
    clearTimeout(t);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ status: 'error', error: 'POST only' }, 405);

  let body: Body;
  try { body = await req.json(); }
  catch { return json({ status: 'error', summary: 'Corps JSON invalide.' }, 200); }

  const lat = num(body.latitude);
  const lon = num(body.longitude);
  if (lat === null || lon === null) {
    return json({
      status: 'no_localization',
      summary: "Coordonnées (latitude/longitude) requises : le zonage d'urbanisme se lit au point, jamais à la commune.",
    }, 200);
  }

  const demandees = Array.isArray(body.couches) && body.couches.length
    ? (body.couches.filter((c) => [
        'municipality', 'zone-urba', 'prescription-surf', 'prescription-lin',
        'prescription-pct', 'info-surf',
      ].includes(c)) as Couche[])
    : COUCHES_DEFAUT;

  // municipality est toujours interrogée : is_rnu et is_coastline conditionnent
  // la lecture de tout le reste.
  const aInterroger: Couche[] = Array.from(new Set<Couche>(['municipality', ...demandees]));
  const limite = Math.min(40, Math.max(1, Math.trunc(num(body.limite) ?? 25)));

  const resultats = await Promise.all(
    aInterroger.map(async (c) => [c, await couche(c, lon, lat)] as const),
  );
  const parCouche = new Map<Couche, any[] | null>(resultats);

  const echecs = aInterroger.filter((c) => parCouche.get(c) === null);

  // ── Commune ──────────────────────────────────────────────────
  const muni = (parCouche.get('municipality') ?? [])?.[0]?.properties ?? null;
  const commune = {
    nom: s(muni?.name),
    code_insee: s(muni?.insee),
    // is_rnu : la commune n'a PAS de document d'urbanisme → Règlement National
    // d'Urbanisme, règle de constructibilité limitée aux parties urbanisées.
    au_rnu: muni?.is_rnu === true,
    commune_littorale: muni?.is_coastline === true,
  };

  // ── Zone d'urbanisme ─────────────────────────────────────────
  const zonesRaw = parCouche.get('zone-urba');
  const zones = (zonesRaw ?? []).map((f: any) => {
    const p = f?.properties ?? {};
    const tz = s(p.typezone);
    return {
      zone: s(p.libelle),
      libelle_long: s(p.libelong),
      type_zone: tz,
      sens_type_zone: tz ? (TYPEZONE_SENS[tz] ?? null) : null,
      document_urbanisme: s(p.idurba),
      reglement_fichier: s(p.nomfic),
      date_validite: s(p.datvalid),
      statut_gpu: s(p.gpu_status),
    };
  });

  // ── Prescriptions (surfaciques / linéaires / ponctuelles) ────
  const prescriptions: any[] = [];
  for (const c of ['prescription-surf', 'prescription-lin', 'prescription-pct'] as Couche[]) {
    for (const f of (parCouche.get(c) ?? [])) {
      const p = f?.properties ?? {};
      const lib = s(p.libelle);
      prescriptions.push({
        libelle: lib,
        portee: c === 'prescription-surf' ? 'surfacique' : c === 'prescription-lin' ? 'linéaire' : 'ponctuelle',
        // Codes CNIG relayés BRUTS : on ne prétend pas les décoder.
        typepsc: s(p.typepsc),
        stypepsc: s(p.stypepsc),
        enjeu_probable: enjeuDe(lib),
      });
    }
  }
  prescriptions.sort((a, b) =>
    (b.enjeu_probable ? 1 : 0) - (a.enjeu_probable ? 1 : 0));

  // ── Informations (non opposables directement) ────────────────
  const infos = (parCouche.get('info-surf') ?? []).map((f: any) => {
    const p = f?.properties ?? {};
    return { libelle: s(p.libelle), typeinf: s(p.typeinf), stypeinf: s(p.stypeinf) };
  });

  // ── Statut global ────────────────────────────────────────────
  const rienDeTrouve = zones.length === 0 && prescriptions.length === 0 && infos.length === 0;
  const status = echecs.length === aInterroger.length
    ? 'error'
    : rienDeTrouve ? 'no_data' : 'ok';

  if (status === 'error') {
    return json({
      status: 'error',
      summary: "API Carto GPU injoignable : impossible de lire le zonage d'urbanisme. Ne conclus rien sur la constructibilité.",
      stats: { couches_en_echec: echecs },
      items: [],
      source: 'Géoportail de l\'urbanisme via API Carto (IGN)',
    }, 200);
  }

  const ou = commune.nom ? `${commune.nom} (${commune.code_insee ?? '?'})` : 'ce point';
  const zonePrincipale = zones[0] ?? null;
  const impacts = prescriptions.filter((p) => p.enjeu_probable);

  const summary =
    (commune.au_rnu
      ? `${ou} est au RÈGLEMENT NATIONAL D'URBANISME (aucun PLU/PLUi opposable) : la constructibilité est régie par le RNU et, en principe, limitée aux parties actuellement urbanisées. `
      : zonePrincipale
      ? `Zone ${zonePrincipale.zone ?? '?'} (type ${zonePrincipale.type_zone ?? '?'}) à ${ou}` +
        (zonePrincipale.sens_type_zone ? ` — ${zonePrincipale.sens_type_zone}` : '') +
        `. Document : ${zonePrincipale.document_urbanisme ?? 'non précisé'}. `
      : `Aucun zonage d'urbanisme publié au GPU sur ce point à ${ou}. `) +
    (commune.commune_littorale
      ? `⚠️ Commune LITTORALE : la loi Littoral s'applique et prime sur le PLU (extension en continuité de l'urbanisation, bande des 100 m, espaces proches du rivage). `
      : '') +
    (prescriptions.length
      ? `${prescriptions.length} prescription(s) au point` +
        (impacts.length ? `, dont ${impacts.length} à impact opérationnel probable : ${impacts.slice(0, 4).map((p) => p.libelle).join(' ; ')}. ` : '. ')
      : 'Aucune prescription publiée au point. ') +
    (echecs.length ? `⚠️ Couche(s) non interrogée(s) faute de réponse : ${echecs.join(', ')}. ` : '') +
    `Le GPU ne contient que ce que la collectivité a numérisé : une absence de résultat n'est pas une preuve d'absence de règle. ` +
    `Le droit de préemption (DPU) et les ZAD ne sont PAS publiés dans ces couches — à vérifier en mairie.`;

  return json({
    status,
    summary,
    stats: {
      commune,
      zone_principale: zonePrincipale,
      nb_zones: zones.length,
      nb_prescriptions: prescriptions.length,
      nb_prescriptions_impactantes: impacts.length,
      nb_informations: infos.length,
      couches_interrogees: aInterroger,
      couches_en_echec: echecs,
    },
    items: {
      zones,
      prescriptions: prescriptions.slice(0, limite),
      informations: infos.slice(0, limite),
    },
    avertissement:
      "Géoportail de l'urbanisme : source de RÉFÉRENCE pour le zonage publié, mais NON EXHAUSTIVE " +
      "(une collectivité peut ne pas avoir numérisé tout ou partie de son document). Le zonage donne la " +
      "constructibilité de PRINCIPE, pas les règles chiffrées (hauteur, emprise, retraits) qui se lisent " +
      "dans le règlement écrit. Le DPU et les ZAD ne figurent pas dans ces couches.",
    source: "Géoportail de l'urbanisme via API Carto (IGN)",
  }, 200);
});
