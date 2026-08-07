// supabase/functions/copilot-fn-health/index.ts
// Mimmoza — vérificateur de câblage des sources du copilot
// -----------------------------------------------------------------------------
// Répond à UNE question : pour chaque source branchée au copilot, le secret
// COPILOT_FN_* est-il défini, et le slug qu'il désigne existe-t-il vraiment ?
//
// Raison d'être : le piège récurrent du projet est le couple secret/slug.
//   - secret absent  → l'outil répond "not_configured" et le modèle croit la
//     donnée indisponible ;
//   - slug erroné (typiquement "{slug}-index" créé par l'upload Dashboard, ou un
//     repli codé en dur qui n'existe pas) → 404 silencieux, 0 invocation.
// Les deux échouent SANS ERREUR VISIBLE côté chat. D'où ce contrôle explicite.
//
// GET ou POST, aucun corps requis. HTTP 200 toujours.
// -----------------------------------------------------------------------------

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
};

const env = (k: string) => Deno.env.get(k) ?? '';
const SUPABASE_URL = env('SUPABASE_URL');
const FN_AUTH = env('SUPABASE_SERVICE_ROLE_KEY') || env('SUPABASE_ANON_KEY');

// Registre des sources : secret attendu + libellé métier.
// À tenir à jour en même temps que INTERNAL_FUNCTIONS dans copilot-chat.
const REGISTRE: Array<{ secret: string; libelle: string }> = [
  { secret: 'COPILOT_FN_PARCEL', libelle: 'Parcelle (résumé)' },
  { secret: 'COPILOT_FN_PLU', libelle: 'PLU / zonage' },
  { secret: 'COPILOT_FN_DVF', libelle: 'DVF comparables' },
  { secret: 'COPILOT_FN_RISKS', libelle: 'Risques Géorisques' },
  { secret: 'COPILOT_FN_SMARTSCORE', libelle: 'SmartScore' },
  { secret: 'COPILOT_FN_DPE', libelle: 'DPE ADEME' },
  { secret: 'COPILOT_FN_MERIMEE', libelle: 'Monuments historiques' },
  { secret: 'COPILOT_FN_BDNB', libelle: 'Bâtiment BDNB' },
  { secret: 'COPILOT_FN_LOYERS', libelle: 'Loyers de référence' },
  { secret: 'COPILOT_FN_SERVITUDES', libelle: 'Servitudes GPU' },
  { secret: 'COPILOT_FN_SOLAIRE', libelle: 'Potentiel solaire' },
  { secret: 'COPILOT_FN_ZONAGE', libelle: 'Zonage ABC' },
  { secret: 'COPILOT_FN_TAXES', libelle: 'Taxes locales' },
  { secret: 'COPILOT_FN_PPR', libelle: 'PPR détaillés (parké)' },
  { secret: 'COPILOT_FN_ASSAINISSEMENT', libelle: 'Assainissement' },
  { secret: 'COPILOT_FN_ALTIMETRIE', libelle: 'Altimétrie / pente' },
  { secret: 'COPILOT_FN_BRUIT', libelle: 'Classement sonore' },
  { secret: 'COPILOT_FN_ETUDE', libelle: 'Étude parcelle (bundle)' },
  { secret: 'COPILOT_FN_MARKET', libelle: 'Étude de marché' },
  { secret: 'COPILOT_FN_COUTS', libelle: 'Coûts de construction' },
  { secret: 'COPILOT_FN_COUTS_RENOVATION', libelle: 'Coûts de rénovation' },
  { secret: 'COPILOT_FN_SITADEL', libelle: 'Permis récents (Sitadel)' },
  { secret: 'COPILOT_FN_SIRENE', libelle: 'Établissements SIRENE' },
  { secret: 'COPILOT_FN_BPE', libelle: 'Équipements et services (BPE)' },
  { secret: 'COPILOT_FN_SRU', libelle: 'Logement social / SRU' },
  { secret: 'COPILOT_FN_CONTEXTE', libelle: 'Contexte commune' },
  { secret: 'COPILOT_FN_DOSSIER', libelle: 'Dossier terrain (agrégateur)' },
];

// Un slug inexistant renvoie 404 sur /functions/v1/{slug}. Un slug existant
// renvoie autre chose (200, 400, 500…) selon ce qu'il fait d'un corps vide :
// on ne juge donc QUE le 404.
async function slugExiste(slug: string): Promise<{ existe: boolean; http: number | null; detail: string | null }> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(`${SUPABASE_URL}/functions/v1/${slug}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${FN_AUTH}`,
        apikey: FN_AUTH,
      },
      body: '{}',
      signal: ctrl.signal,
    });
    clearTimeout(t);
    return { existe: r.status !== 404, http: r.status, detail: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Timeout ≠ absence : la fonction existe mais met du temps sur un corps vide.
    return { existe: true, http: null, detail: `injoignable (${msg})` };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const t0 = Date.now();

  const lignes = await Promise.all(REGISTRE.map(async (r) => {
    const slug = env(r.secret);
    if (!slug) {
      return {
        source: r.libelle,
        secret: r.secret,
        slug: null,
        etat: 'secret_absent',
        diagnostic: "Le secret n'est pas défini : l'outil répondra « not_configured » et la source sera invisible dans le chat.",
      };
    }
    const p = await slugExiste(slug);
    if (!p.existe) {
      return {
        source: r.libelle,
        secret: r.secret,
        slug,
        etat: 'slug_introuvable',
        http: p.http,
        diagnostic: `Aucune Edge Function déployée sous le slug « ${slug} » (HTTP 404). Vérifier le champ « nom » à la création — l'upload Dashboard crée parfois « ${slug}-index ».`,
      };
    }
    return {
      source: r.libelle,
      secret: r.secret,
      slug,
      etat: 'ok',
      http: p.http,
      diagnostic: p.detail,
    };
  }));

  const ok = lignes.filter((l) => l.etat === 'ok');
  const sansSecret = lignes.filter((l) => l.etat === 'secret_absent');
  const slugKo = lignes.filter((l) => l.etat === 'slug_introuvable');

  const summary =
    `${ok.length}/${REGISTRE.length} source(s) correctement câblée(s). ` +
    (sansSecret.length ? `${sansSecret.length} sans secret : ${sansSecret.map((l) => l.secret).join(', ')}. ` : '') +
    (slugKo.length ? `⚠️ ${slugKo.length} secret(s) pointant sur un slug INEXISTANT : ${slugKo.map((l) => `${l.secret}→${l.slug}`).join(', ')}. ` : '') +
    (!sansSecret.length && !slugKo.length ? 'Aucune anomalie.' : '');

  return new Response(JSON.stringify({
    status: slugKo.length ? 'error' : sansSecret.length ? 'partial' : 'ok',
    summary,
    stats: {
      total: REGISTRE.length,
      cablees: ok.length,
      secret_absent: sansSecret.length,
      slug_introuvable: slugKo.length,
      duree_ms: Date.now() - t0,
    },
    items: lignes,
  }, null, 2), { status: 200, headers: CORS });
});
