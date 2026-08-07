// ============================================================
// Mimmoza — Edge Function
// supabase/functions/sncf-gares-ingest-v1/index.ts
// Import des gares SNCF depuis data.sncf.com (CSV direct)
// Colonnes : nom_gare | position géographique (lat,lon) | code_uic
// Séparateur CSV : point-virgule (;)
// ============================================================

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { crypto } from 'https://deno.land/std@0.168.0/crypto/mod.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SNCF_CSV_URL =
  'https://ressources.data.sncf.com/api/explore/v2.1/catalog/datasets/gares-de-voyageurs/exports/csv?use_labels=true';

// SHA-256
async function sha256(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// Parse CSV séparateur ";" — SNCF
// La colonne "position géographique" contient "lat,lon" comme valeur
function parseCsvSemicolon(text: string): Array<Record<string, string>> {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  const headers = lines[0].split(';').map(h =>
    h.trim().replace(/^"|"$/g, '').toLowerCase()
  );

  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i++) {
    // Split uniquement sur ";" — les virgules dans les valeurs sont préservées
    const values = lines[i].split(';').map(v => v.trim().replace(/^"|"$/g, ''));
    if (values.length < 2) continue;
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = (values[idx] ?? '').trim();
    });
    rows.push(row);
  }
  return rows;
}

// Parse "position géographique" → { lat, lon }
// Format SNCF : "48.8566,2.3522" ou "48.8566, 2.3522"
function parseGeoPoint(value: string): { lat: number; lon: number } | null {
  if (!value || value.trim() === '') return null;

  // Nettoyage : retire les parenthèses éventuelles
  const clean = value.replace(/[()]/g, '').trim();
  const parts = clean.split(',').map(s => parseFloat(s.trim()));

  if (parts.length < 2) return null;

  const [lat, lon] = parts;
  if (isNaN(lat) || isNaN(lon)) return null;

  // Sanity check : lat France entre 41 et 52, lon entre -6 et 10
  // (ou DOM)
  const inMetropole = lat >= 41 && lat <= 51.5 && lon >= -5.5 && lon <= 10;
  const inDom =
    (lat >= 14 && lat <= 18.5) ||   // Antilles
    (lat >= -21.5 && lat <= -20.5) || // Réunion
    (lat >= 3 && lat <= 6 && lon >= -54 && lon <= -51); // Guyane

  if (!inMetropole && !inDom) return null;

  return { lat, lon };
}

// Mode SNCF depuis segment DRG et département
function detectSncfMode(row: Record<string, string>): string {
  const segment = (row['segment(s) drg'] ?? '').toLowerCase();
  const uic = row['code_uic'] ?? '';

  // Segment DRG A = grandes gares (TGV)
  if (segment === 'a') return 'tgv';

  // Gares IDF → Transilien (UIC commençant par 87 + département IDF)
  // Les gares IDF ont souvent l'UIC 87XXXXXXX
  // Heuristique : si la gare a aussi des trains grandes lignes = tgv
  if (segment === 'b' || segment === 'c') return 'tgv'; // grandes gares régionales avec TGV

  return 'ter';
}

// ------------------------------------------------------------
// HANDLER PRINCIPAL
// ------------------------------------------------------------
serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  console.log('[sncf-gares-ingest] Téléchargement CSV SNCF...');

  // 1. Téléchargement
  let csvText: string;
  try {
    const resp = await fetch(SNCF_CSV_URL, {
      headers: { 'User-Agent': 'Mimmoza/1.0 mobility-importer' },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    csvText = await resp.text();
  } catch (err) {
    return new Response(
      JSON.stringify({ error: `Téléchargement échoué: ${err}` }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  console.log(`[sncf-gares-ingest] CSV reçu: ${Math.round(csvText.length / 1024)} KB`);

  // 2. Hash checksum
  const hash = await sha256(csvText);
  const { data: existingDataset } = await supabase
    .from('gtfs_datasets')
    .select('id, content_hash')
    .eq('dataset_id', 'sncf-gares-csv')
    .single();

  if (existingDataset?.content_hash === hash) {
    return new Response(
      JSON.stringify({ status: 'skipped', message: 'CSV inchangé' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // Upsert dataset record
  const { data: datasetRow } = await supabase
    .from('gtfs_datasets')
    .upsert({
      dataset_id:      'sncf-gares-csv',
      title:           'Gares de voyageurs SNCF (CSV)',
      coverage_area:   'national',
      gtfs_url:        SNCF_CSV_URL,
      content_hash:    hash,
      last_fetched_at: new Date().toISOString(),
      last_changed_at: new Date().toISOString(),
      is_active:       true,
    }, { onConflict: 'dataset_id' })
    .select('id')
    .single();

  const datasetId = datasetRow?.id;

  // 3. Parse CSV avec séparateur ";"
  const rows = parseCsvSemicolon(csvText);
  console.log(`[sncf-gares-ingest] ${rows.length} lignes parsées`);

  // Debug : affiche les 3 premières lignes pour vérifier
  if (rows.length > 0) {
    console.log('[sncf-gares-ingest] Exemple row[0]:', JSON.stringify(rows[0]));
    console.log('[sncf-gares-ingest] Exemple row[1]:', JSON.stringify(rows[1]));
  }

  // 4. Filtre et préparation
  const stopsToUpsert: Array<Record<string, unknown>> = [];
  let skippedNoCoords = 0;

  for (const row of rows) {
    const geoValue = row['position géographique'] ?? '';
    const coords = parseGeoPoint(geoValue);

    if (!coords) {
      skippedNoCoords++;
      continue;
    }

    const name = row['nom_gare'] ?? 'Gare inconnue';
    const stopId = row['code_uic'] ?? `sncf-${name.toLowerCase().replace(/\s+/g, '-')}`;
    const mode = detectSncfMode(row);

    stopsToUpsert.push({
      stop_id:         stopId,
      stop_name:       name,
      stop_code:       row['trigramme'] ?? null,
      lat:             coords.lat,
      lon:             coords.lon,
      mode,
      is_main_station: true,
      has_tgv:         mode === 'tgv',
      has_ter:         mode === 'ter' || mode === 'transilien',
      line_ids:        null,
      dataset_id:      datasetId,
      source_hash:     hash,
    });
  }

  console.log(`[sncf-gares-ingest] ${stopsToUpsert.length} gares valides, ${skippedNoCoords} sans coords`);

  // 5. Upsert batch 500
  const BATCH_SIZE = 500;
  let inserted = 0;

  for (let i = 0; i < stopsToUpsert.length; i += BATCH_SIZE) {
    const batch = stopsToUpsert.slice(i, i + BATCH_SIZE);
    const { error, count } = await supabase
      .from('mobility_stops')
      .upsert(batch, {
        onConflict:       'stop_id,dataset_id',
        ignoreDuplicates: false,
        count:            'exact',
      });
    if (error) {
      console.error(`[sncf-gares-ingest] Batch ${i} erreur:`, error);
      continue;
    }
    inserted += count ?? batch.length;
  }

  await supabase
    .from('gtfs_datasets')
    .update({ stop_count: stopsToUpsert.length })
    .eq('dataset_id', 'sncf-gares-csv');

  const summary = {
    status:          'success',
    total_in_csv:    rows.length,
    after_filter:    stopsToUpsert.length,
    skipped_no_coords: skippedNoCoords,
    inserted,
  };

  console.log('[sncf-gares-ingest] Terminé:', summary);

  return new Response(
    JSON.stringify(summary),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
});