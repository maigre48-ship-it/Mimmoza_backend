// ============================================================
// Mimmoza — Edge Function
// supabase/functions/transport-score-gtfs-v1/index.ts
// v2 — rail = TGV/TER uniquement, métro/RER/Transilien/tram = réseau urbain,
//      pondérations contextuelles (intra-agglo vs hors agglo)
// ============================================================

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

type MobilityMode = 'tgv' | 'ter' | 'rer' | 'transilien' | 'metro' | 'tram' | 'bhns';

interface MobilityModeGroup {
  mode:            MobilityMode;
  nearest_name:    string;
  nearest_dist_m:  number;
  stop_count:      number;
  has_tgv:         boolean;
  has_ter:         boolean;
  line_ids:        string[] | null;
  minutes_to_cbd:  number | null;
}

interface PillarScore {
  score:   number;
  weight:  number;
  details: string;
}

type Weights = { rail: number; urban: number; employment: number; multimodal: number };

interface MobilityScore {
  total: number;
  is_urban: boolean;
  pillars: {
    rail:       PillarScore;
    urban:      PillarScore;
    employment: PillarScore;
    multimodal: PillarScore;
  };
  top_stops: Array<{
    name:       string;
    mode:       MobilityMode;
    distance_m: number;
    lines:      string[];
  }>;
  computed_at: string;
  radius_m:    number;
}

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Hors agglo : la SNCF grandes lignes est le moteur de la mobilité.
// En ville : c'est le réseau urbain lourd (métro/tram/RER) qui prime.
const W_RURAL: Weights = { rail: 0.40, urban: 0.25, employment: 0.20, multimodal: 0.15 };
const W_URBAN: Weights = { rail: 0.10, urban: 0.45, employment: 0.20, multimodal: 0.25 };

// Présence d'un métro OU d'un tram = vraie agglomération.
// => SNCF grandes lignes déclassée, réseau urbain valorisé.
function isUrbanContext(groups: MobilityModeGroup[]): boolean {
  return groups.some(g => g.mode === 'metro' || g.mode === 'tram');
}

// ── Rail = SNCF grandes lignes UNIQUEMENT (TGV / TER) ────────────────
function scoreRail(groups: MobilityModeGroup[], W: Weights): PillarScore {
  const rail = groups.find(g => ['tgv', 'ter'].includes(g.mode));
  if (!rail) return { score: 0, weight: W.rail, details: 'Aucune gare TGV/TER à proximité' };

  const d = rail.nearest_dist_m;
  const hasTgv = groups.some(g => g.has_tgv);

  let score = 0;
  let details = '';

  if      (hasTgv && d < 500)  { score = 100; details = `Gare TGV à ${Math.round(d)} m (${rail.nearest_name})`; }
  else if (hasTgv && d < 1200) { score = 88;  details = `Gare TGV à ${Math.round(d)} m (${rail.nearest_name})`; }
  else if (hasTgv && d < 2000) { score = 75;  details = `Gare TGV à ${Math.round(d)} m`; }
  else if (d < 400)            { score = 85;  details = `Gare ${rail.mode.toUpperCase()} à ${Math.round(d)} m (${rail.nearest_name})`; }
  else if (d < 800)            { score = 75;  details = `Gare ${rail.mode.toUpperCase()} à ${Math.round(d)} m`; }
  else if (d < 1200)           { score = 62;  details = `Gare ${rail.mode.toUpperCase()} à ${Math.round(d)} m`; }
  else if (d < 2000)           { score = 45;  details = `Gare ${rail.mode.toUpperCase()} à ${Math.round(d)} m`; }

  return { score, weight: W.rail, details };
}

// ── Réseau urbain lourd = métro / tram / RER / Transilien / BHNS ─────
function scoreUrban(groups: MobilityModeGroup[], W: Weights): PillarScore {
  const urbanModes = groups.filter(g => ['metro', 'tram', 'bhns', 'rer', 'transilien'].includes(g.mode));
  if (urbanModes.length === 0) {
    return { score: 0, weight: W.urban, details: 'Pas de réseau urbain lourd à proximité' };
  }

  const nearest = urbanModes.reduce((a, b) => (a.nearest_dist_m < b.nearest_dist_m ? a : b));
  const d = nearest.nearest_dist_m;
  const totalLines = urbanModes.reduce((acc, g) => acc + (g.line_ids?.length ?? 0), 0);
  const lineBonus = Math.min(15, totalLines * 3);

  let base = 0;
  if      (d < 200)  base = 85;
  else if (d < 400)  base = 75;
  else if (d < 700)  base = 62;
  else if (d < 1000) base = 48;
  else if (d < 1500) base = 32;
  else if (d < 2000) base = 18;

  const score = Math.min(100, base + lineBonus);
  return {
    score,
    weight: W.urban,
    details: `${nearest.mode.toUpperCase()} à ${Math.round(d)} m (${nearest.nearest_name}), ${totalLines} ligne(s)`,
  };
}

// ── Accès emploi / CBD ───────────────────────────────────────────────
function scoreEmployment(minutesToCbd: number | null, isUrban: boolean, W: Weights): PillarScore {
  if (minutesToCbd == null) {
    // En cœur d'agglo, l'accès au bassin d'emploi est de fait bon même sans
    // temps de trajet calculé. Hors agglo, on reste prudent (neutre).
    const score = isUrban ? 70 : 50;
    return {
      score,
      weight: W.employment,
      details: 'Temps trajet CBD non disponible — estimation contextuelle',
    };
  }
  let score = 0;
  if      (minutesToCbd <= 10) score = 100;
  else if (minutesToCbd <= 20) score = 88;
  else if (minutesToCbd <= 30) score = 75;
  else if (minutesToCbd <= 45) score = 58;
  else if (minutesToCbd <= 60) score = 40;
  else if (minutesToCbd <= 90) score = 22;
  else                         score = 8;
  return { score, weight: W.employment, details: `${minutesToCbd} min vers le bassin d'emploi` };
}

// ── Multimodalité ────────────────────────────────────────────────────
function scoreMultimodal(groups: MobilityModeGroup[], W: Weights): PillarScore {
  const within1km = groups.filter(g => g.nearest_dist_m <= 1000);
  const modeCount = within1km.length;

  const hasPremiumCombo =
    within1km.some(g => ['tgv', 'ter'].includes(g.mode)) &&
    within1km.some(g => ['metro', 'tram', 'rer'].includes(g.mode));

  let score = 0;
  if      (modeCount >= 4)  score = 100;
  else if (modeCount === 3) score = 82;
  else if (modeCount === 2) score = 60;
  else if (modeCount === 1) score = 30;

  if (hasPremiumCombo) score = Math.min(100, score + 15);

  const modeNames = within1km.map(g => g.mode.toUpperCase()).join(', ');
  return {
    score,
    weight: W.multimodal,
    details: modeCount > 0
      ? `${modeCount} mode(s) < 1 km : ${modeNames}`
      : 'Aucun transport dans un rayon de 1 km',
  };
}

function computeMobilityScore(groups: MobilityModeGroup[], radiusM: number): MobilityScore {
  const urban = isUrbanContext(groups);
  const W = urban ? W_URBAN : W_RURAL;

  const minutesToCbd = [...groups]
    .sort((a, b) => a.nearest_dist_m - b.nearest_dist_m)
    .find(g => g.minutes_to_cbd != null)?.minutes_to_cbd ?? null;

  const rail       = scoreRail(groups, W);
  const urbanP     = scoreUrban(groups, W);
  const employment = scoreEmployment(minutesToCbd, urban, W);
  const multimodal = scoreMultimodal(groups, W);

  const total = Math.min(100, Math.max(0, Math.round(
    rail.score       * W.rail +
    urbanP.score     * W.urban +
    employment.score * W.employment +
    multimodal.score * W.multimodal
  )));

  const top_stops = [...groups]
    .sort((a, b) => a.nearest_dist_m - b.nearest_dist_m)
    .slice(0, 5)
    .map(g => ({
      name:       g.nearest_name,
      mode:       g.mode,
      distance_m: Math.round(g.nearest_dist_m),
      lines:      g.line_ids ?? [],
    }));

  return {
    total,
    is_urban: urban,
    pillars: { rail, urban: urbanP, employment, multimodal },
    top_stops,
    computed_at: new Date().toISOString(),
    radius_m: radiusM,
  };
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { lat, lon, radius_m = 2000 } = body;

    console.log(`[transport-score] lat=${lat} lon=${lon} radius=${radius_m}`);

    if (!lat || !lon) {
      return new Response(
        JSON.stringify({ error: 'lat et lon sont requis' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { data: groups, error } = await supabase.rpc('mobility_deduplicate_by_mode', {
      p_lat:      lat,
      p_lon:      lon,
      p_radius_m: radius_m,
    });

    console.log(`[transport-score] rpc error: ${JSON.stringify(error)}`);
    console.log(`[transport-score] groups: ${JSON.stringify(groups)}`);

    if (error) throw error;

    if (!groups || groups.length === 0) {
      const emptyScore: MobilityScore = {
        total: 0,
        is_urban: false,
        pillars: {
          rail:       { score: 0, weight: W_RURAL.rail,       details: 'Aucune gare dans un rayon de 2 km' },
          urban:      { score: 0, weight: W_RURAL.urban,      details: 'Aucun réseau urbain dans un rayon de 2 km' },
          employment: { score: 0, weight: W_RURAL.employment, details: 'Données non disponibles' },
          multimodal: { score: 0, weight: W_RURAL.multimodal, details: 'Aucun transport' },
        },
        top_stops:   [],
        computed_at: new Date().toISOString(),
        radius_m,
      };
      return new Response(
        JSON.stringify({ score: emptyScore, cached: false }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const score = computeMobilityScore(groups as MobilityModeGroup[], radius_m);

    return new Response(
      JSON.stringify({ score, cached: false }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    console.error('[transport-score-gtfs-v1] ERREUR:', err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});