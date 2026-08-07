// supabase/functions/ao-watch-run-v1/index.ts
// =============================================================================
// Mimmoza — exécution des veilles « appels d'offres »
// -----------------------------------------------------------------------------
// Rejoue chaque veille active de public.ao_watches contre appels-offres-v1,
// détecte les avis JAMAIS encore signalés, et les enregistre dans
// public.ao_watch_events. Conçu pour être appelé par pg_cron une fois par jour.
//
// Deux garde-fous d'unicité, volontairement redondants :
//   1. ao_watches.last_seen_ids — évite l'écriture inutile ;
//   2. contrainte UNIQUE (watch_id, avis_id) — garantie par la base, seule à
//      tenir si deux exécutions se chevauchent.
//   Le premier est une optimisation, le second est la vérité.
//
// ENTRÉE (optionnelle) : { watch_id?: string, dry_run?: boolean }
//   watch_id  → ne joue qu'une veille (débogage)
//   dry_run   → calcule les nouveautés sans rien écrire
//
// AUTH : verify_jwt reste actif ; pg_cron présente la clé anon (JWT signé,
// publique). La lecture inter-utilisateurs se fait ensuite avec la clé de
// service, côté serveur uniquement.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
};

const env = (k: string) => Deno.env.get(k) ?? '';
const SUPABASE_URL = env('SUPABASE_URL');
const SERVICE_KEY = env('SUPABASE_SERVICE_ROLE_KEY');
const FN_AO = env('COPILOT_FN_APPELS_OFFRES') || 'appels-offres-v1';

const MAX_VEILLES = 200;      // garde-fou : au-delà, il faudra paginer
const MAX_PAR_VEILLE = 30;    // avis remontés par veille et par passage
const HISTORIQUE_IDS = 400;   // taille max de last_seen_ids conservée

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: CORS });
}

interface Veille {
  id: string; user_id: string; label: string;
  departements: string[]; categories: string[];
  texte: string | null; jours_min: number;
  last_seen_ids: string[] | null;
}

async function chercherAvis(v: Veille): Promise<Record<string, unknown>[]> {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/${FN_AO}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SERVICE_KEY}`,
      apikey: SERVICE_KEY,
    },
    body: JSON.stringify({
      departements: v.departements,
      categories: v.categories,
      texte: v.texte ?? undefined,
      jours_min: v.jours_min,
      limite: MAX_PAR_VEILLE,
    }),
    signal: AbortSignal.timeout(25000),
  });
  if (!r.ok) throw new Error(`appels-offres-v1 HTTP ${r.status}`);

  // Même piège que partout ailleurs : 200 + HTML = URL morte, pas panne.
  const ctype = r.headers.get('content-type') ?? '';
  if (!ctype.includes('json')) {
    throw new Error(`appels-offres-v1 a renvoyé "${ctype || 'type inconnu'}" au lieu de JSON.`);
  }
  const d = await r.json();
  return Array.isArray(d?.items) ? d.items : [];
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return json({ status: 'error', summary: 'SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY absent.' });
  }

  let filtreId: string | null = null;
  let dryRun = false;
  try {
    const b = await req.json();
    if (typeof b?.watch_id === 'string') filtreId = b.watch_id;
    if (b?.dry_run === true) dryRun = true;
  } catch { /* corps vide accepté : c'est le cas nominal du cron */ }

  const db = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const t0 = Date.now();

  let veilles: Veille[] = [];
  try {
    let q = db.from('ao_watches')
      .select('id, user_id, label, departements, categories, texte, jours_min, last_seen_ids')
      .eq('is_active', true).limit(MAX_VEILLES);
    if (filtreId) q = q.eq('id', filtreId);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    veilles = (data ?? []) as Veille[];
  } catch (e) {
    return json({ status: 'error', summary: `Lecture des veilles impossible : ${e instanceof Error ? e.message : String(e)}` });
  }

  if (veilles.length === 0) {
    return json({ status: 'ok', summary: 'Aucune veille active à exécuter.', stats: { veilles: 0 }, items: [] });
  }

  const rapport: Record<string, unknown>[] = [];
  let totalNouveautes = 0;
  let enErreur = 0;

  for (const v of veilles) {
    try {
      const avis = await chercherAvis(v);
      const dejaVus = new Set(v.last_seen_ids ?? []);
      const nouveaux = avis.filter((a) => a?.id && !dejaVus.has(String(a.id)));

      if (!dryRun && nouveaux.length > 0) {
        const lignes = nouveaux.map((a) => ({
          watch_id: v.id,
          user_id: v.user_id,
          avis_id: String(a.id),
          objet: (a.objet as string) ?? null,
          acheteur: (a.acheteur as string) ?? null,
          url: (a.url as string) ?? null,
          departements: Array.isArray(a.departements_diffusion) ? a.departements_diffusion : [],
          zone_incertaine: a.zone_execution_incertaine === true,
          date_limite: (a.date_limite_reponse as string) ?? null,
          jours_restants: typeof a.jours_restants === 'number' ? a.jours_restants : null,
        }));
        // upsert + ignoreDuplicates : si deux exécutions se croisent, la
        // contrainte UNIQUE tranche sans faire échouer tout le lot.
        const { error } = await db.from('ao_watch_events')
          .upsert(lignes, { onConflict: 'watch_id,avis_id', ignoreDuplicates: true });
        if (error) throw new Error(error.message);
      }

      if (!dryRun) {
        // On mémorise les identifiants VUS (nouveaux + anciens encore ouverts),
        // borné, pour que la liste ne grossisse pas indéfiniment.
        const vus = [...new Set([...avis.map((a) => String(a.id)), ...(v.last_seen_ids ?? [])])]
          .slice(0, HISTORIQUE_IDS);
        const { error } = await db.from('ao_watches')
          .update({ last_seen_ids: vus, last_run_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq('id', v.id);
        if (error) throw new Error(error.message);
      }

      totalNouveautes += nouveaux.length;
      rapport.push({
        veille_id: v.id, libelle: v.label, etat: 'ok',
        avis_vus: avis.length, nouveautes: nouveaux.length,
        exemples: nouveaux.slice(0, 3).map((a) => ({ id: a.id, objet: a.objet, jours_restants: a.jours_restants })),
      });
    } catch (e) {
      enErreur++;
      rapport.push({ veille_id: v.id, libelle: v.label, etat: 'erreur',
                     message: e instanceof Error ? e.message : String(e) });
    }
  }

  return json({
    status: enErreur ? 'partial' : 'ok',
    summary:
      `${veilles.length} veille(s) exécutée(s), ${totalNouveautes} nouveauté(s) détectée(s)` +
      (enErreur ? `, ⚠️ ${enErreur} en erreur.` : '.') +
      (dryRun ? ' (dry_run : aucune écriture)' : ''),
    stats: { veilles: veilles.length, nouveautes: totalNouveautes, erreurs: enErreur, dry_run: dryRun, duree_ms: Date.now() - t0 },
    items: rapport,
  });
});