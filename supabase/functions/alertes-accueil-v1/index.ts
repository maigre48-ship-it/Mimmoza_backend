// supabase/functions/alertes-accueil-v1/index.ts
// =============================================================================
// Mimmoza — bandeau d'alertes de la page d'accueil
// -----------------------------------------------------------------------------
// UN seul appel côté front, DEUX gisements réunis :
//   • APPELS D'OFFRES : ao_watch_events non lus (produits par ao-watch-run-v1) ;
//   • IMMOBILIER      : market_opportunities croisées avec les user_watchlists
//                       actives de l'utilisateur (ville + prix + surface).
//
// PRINCIPE DE SINCÉRITÉ — chaque bloc porte sa FRAÎCHEUR (`donnees_du`) et un
// drapeau `perime`. Une alerte immobilière calculée il y a trois mois n'est pas
// une opportunité : c'est un souvenir. Le front doit pouvoir le dire, et le
// silence ne doit jamais passer pour « rien à signaler ».
//
// AUTH : JWT de l'utilisateur OBLIGATOIRE. Toutes les lectures passent par son
// client — le RLS s'applique, personne ne voit les veilles d'un autre.
// Les opportunités de marché ne sont PAS nominatives : on ne les expose que
// filtrées par les watchlists de l'appelant.
//
// SORTIE : { status, total, appels_offres[], immobilier[], fraicheur, summary }
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
};

const env = (k: string) => Deno.env.get(k) ?? '';
const SUPABASE_URL = env('SUPABASE_URL');
const PUBLISHABLE = env('SUPABASE_ANON_KEY') || env('SUPABASE_PUBLISHABLE_KEY');

// Au-delà, une opportunité immobilière n'est plus un signal exploitable.
const PEREMPTION_JOURS = 30;
const MAX_PAR_BLOC = 8;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

function joursDepuis(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor((Date.now() - t) / 86400000) : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader) {
    return json({ status: 'error', summary: "Authentification requise." }, 401);
  }

  const db = createClient(SUPABASE_URL, PUBLISHABLE, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let limite = MAX_PAR_BLOC;
  try {
    const b = await req.json();
    const n = Number(b?.limite);
    if (Number.isFinite(n)) limite = Math.min(20, Math.max(1, Math.trunc(n)));
  } catch { /* GET ou corps vide */ }

  const erreurs: string[] = [];

  // ── Bloc 1 : appels d'offres non lus ───────────────────────────────────
  let ao: Record<string, unknown>[] = [];
  try {
    const { data, error } = await db.from('ao_watch_events')
      .select('avis_id, objet, acheteur, url, date_limite, zone_incertaine, created_at, ao_watches(label)')
      .eq('is_read', false)
      .order('date_limite', { ascending: true, nullsFirst: false })
      .limit(limite);
    if (error) throw new Error(error.message);
    ao = (data ?? []).map((r: any) => {
      const t = r.date_limite ? Date.parse(r.date_limite) : NaN;
      const jours = Number.isFinite(t) ? Math.round((t - Date.now()) / 86400000) : null;
      return {
        type: 'appel_offres',
        id: r.avis_id,
        titre: r.objet,
        sous_titre: r.acheteur,
        veille: r.ao_watches?.label ?? null,
        url: r.url,
        echeance: r.date_limite,
        jours_restants: jours,
        // Un avis clos ne doit pas s'afficher comme une opportunité ouverte.
        expire: jours != null && jours < 0,
        urgent: jours != null && jours >= 0 && jours <= 7,
        zone_incertaine: r.zone_incertaine === true,
        detecte_le: r.created_at,
      };
    }).filter((a: any) => !a.expire);
  } catch (e) {
    erreurs.push(`appels d'offres : ${e instanceof Error ? e.message : String(e)}`);
  }

  // ── Bloc 2 : opportunités immobilières croisées aux watchlists ─────────
  let immo: Record<string, unknown>[] = [];
  let fraicheurImmo: string | null = null;
  try {
    const { data: wl, error: eWl } = await db.from('user_watchlists')
      .select('name, city, zip_code, property_type, min_price, max_price, min_surface_m2, max_surface_m2, min_opportunity_score')
      .eq('is_active', true).limit(30);
    if (eWl) throw new Error(eWl.message);

    const watchlists = wl ?? [];
    if (watchlists.length) {
      const villes = [...new Set(watchlists.map((w: any) => w.city).filter(Boolean))];
      const { data: opp, error: eOpp } = await db.from('market_opportunities')
        .select('canonical_key, city, zip_code, price, surface, price_m2, opportunity_score, opportunity_bucket, price_position_pct, days_on_market, representative_url, updated_at, last_seen_at')
        .in('city', villes)
        .order('opportunity_score', { ascending: false })
        .limit(200);
      if (eOpp) throw new Error(eOpp.message);

      const retenues = (opp ?? []).filter((o: any) => {
        // Une opportunité ne remonte que si elle satisfait AU MOINS UNE
        // watchlist en entier : ville, prix, surface et score.
        return watchlists.some((w: any) => {
          if (w.city && o.city !== w.city) return false;
          if (w.min_price != null && o.price != null && Number(o.price) < Number(w.min_price)) return false;
          if (w.max_price != null && o.price != null && Number(o.price) > Number(w.max_price)) return false;
          if (w.min_surface_m2 != null && o.surface != null && Number(o.surface) < Number(w.min_surface_m2)) return false;
          if (w.max_surface_m2 != null && o.surface != null && Number(o.surface) > Number(w.max_surface_m2)) return false;
          if (w.min_opportunity_score != null && o.opportunity_score != null
              && Number(o.opportunity_score) < Number(w.min_opportunity_score)) return false;
          return true;
        });
      }).slice(0, limite);

      fraicheurImmo = (opp ?? [])[0]?.updated_at ?? null;

      immo = retenues.map((o: any) => ({
        type: 'immobilier',
        id: o.canonical_key,
        titre: `${o.city} — ${o.surface ? Math.round(Number(o.surface)) + ' m²' : 'surface inconnue'}`,
        sous_titre: o.price != null ? `${Math.round(Number(o.price)).toLocaleString('fr-FR')} €` : null,
        prix: o.price, surface: o.surface, prix_m2: o.price_m2,
        score: o.opportunity_score, niveau: o.opportunity_bucket,
        position_prix_pct: o.price_position_pct,
        jours_sur_le_marche: o.days_on_market,
        url: o.representative_url,
        calcule_le: o.updated_at,
      }));
    }
  } catch (e) {
    erreurs.push(`immobilier : ${e instanceof Error ? e.message : String(e)}`);
  }

  const ageImmo = joursDepuis(fraicheurImmo);
  const immoPerime = ageImmo != null && ageImmo > PEREMPTION_JOURS;
  const total = ao.length + immo.length;

  return json({
    status: erreurs.length ? 'partial' : 'ok',
    total,
    appels_offres: ao,
    immobilier: immo,
    fraicheur: {
      immobilier_calcule_le: fraicheurImmo,
      immobilier_age_jours: ageImmo,
      immobilier_perime: immoPerime,
      // Le front doit AFFICHER cet avertissement, pas le masquer : une absence
      // d'alerte peut signifier « rien de neuf » ou « le moteur est à l'arrêt ».
      avertissement: immoPerime
        ? `Les opportunités immobilières datent de ${ageImmo} jours : le rafraîchissement de marché ne tourne plus. Ce n'est pas une absence d'opportunité.`
        : fraicheurImmo === null
        ? "Aucune opportunité immobilière n'a jamais été calculée pour vos zones. Ce n'est pas une absence d'opportunité."
        : null,
    },
    erreurs: erreurs.length ? erreurs : undefined,
    summary:
      total === 0
        ? "Aucune alerte." + (immoPerime ? ' ⚠️ Données de marché périmées.' : '')
        : `${ao.length} appel(s) d'offres et ${immo.length} opportunité(s) immobilière(s).`,
  });
});