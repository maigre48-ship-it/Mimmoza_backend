// ============================================================
// Mimmoza — Edge Function
// supabase/functions/gtfs-ingest-v1/index.ts
// Import GTFS depuis transport.data.gouv.fr
// Filtre modes Phase 1 uniquement (pas de bus classique)
// Déclenché par pg_cron hebdo — jamais à la volée
// ============================================================

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { crypto } from 'https://deno.land/std@0.168.0/crypto/mod.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ------------------------------------------------------------
// GTFS route_type → mobility_mode Phase 1
// Retourne null = à ignorer (bus classique, ferry, etc.)
// ------------------------------------------------------------
function routeTypeToMode(routeType: number): string | null {
  const map: Record<number, string | null> = {
    0:   'tram',
    1:   'metro',
    2:   'ter',        // Rail générique → affiné par dataset
    4:   null,         // Ferry
    5:   null,         // Cable car
    6:   null,         // Gondola
    7:   null,         // Funicular
    3:   null,         // Bus classique — EXCLU Phase 1
    11:  null,         // Trolleybus — EXCLU
    // Extended route types SNCF
    100: 'tgv',
    101: 'tgv',
    102: 'ter',
    103: 'ter',
    106: 'ter',
    400: 'metro',
    401: 'metro',
    402: 'metro',
    900: 'tram',
    901: 'tram',
  };
  return map[routeType] ?? null;
}

// BHNS : détecté par mots-clés dans route_desc ou route_long_name
function isBhns(routeDesc: string, routeLongName: string): boolean {
  const text = `${routeDesc} ${routeLongName}`.toLowerCase();
  return text.includes('bhns') || text.includes('brt') ||
         text.includes('bus à haut niveau') || text.includes('busway') ||
         text.includes('lianes') || text.includes('chrono');
}

// Affinage TGV vs TER pour datasets SNCF (route_type=2)
function refineSncfMode(
  routeType: number,
  routeDesc: string,
  routeLongName: string,
  coverageArea: string
): string | null {
  if (routeType !== 2 && routeType !== 102 && routeType !== 103 && routeType !== 106) {
    return routeTypeToMode(routeType);
  }
  const text = `${routeDesc} ${routeLongName}`.toLowerCase();
  if (text.includes('tgv') || text.includes('inoui') || text.includes('ouigo')) return 'tgv';
  if (text.includes('intercit')) return 'ter';
  if (coverageArea === 'idf') return 'transilien';
  return 'ter';
}

// ------------------------------------------------------------
// Parse CSV minimal (stops.txt, routes.txt)
// Deno n'a pas de lib CSV native robuste — parser léger
// ------------------------------------------------------------
function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const rows: Array<Record<string, string>> = [];

  for (let i = 1; i < lines.length; i++) {
    const values = splitCsvLine(lines[i]);
    if (values.length < headers.length) continue;
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = (values[idx] ?? '').trim().replace(/^"|"$/g, '');
    });
    rows.push(row);
  }
  return rows;
}

// Split ligne CSV en gérant les guillemets
function splitCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

// ------------------------------------------------------------
// Extraction d'un fichier depuis un ZIP (sans lib externe)
// Utilise l'API DecompressionStream de Deno
// ------------------------------------------------------------
async function extractFileFromZip(
  zipBuffer: ArrayBuffer,
  filename: string
): Promise<string | null> {
  const bytes = new Uint8Array(zipBuffer);

  // Recherche signature ZIP local file header (PK\x03\x04)
  const targets = [filename, filename.toLowerCase()];

  for (const target of targets) {
    const nameBytes = new TextEncoder().encode(target);
    for (let i = 0; i < bytes.length - 30; i++) {
      // Signature local file header
      if (bytes[i] !== 0x50 || bytes[i+1] !== 0x4b ||
          bytes[i+2] !== 0x03 || bytes[i+3] !== 0x04) continue;

      const compression  = bytes[i+8]  | (bytes[i+9]  << 8);
      const compSize     = bytes[i+18] | (bytes[i+19] << 8) |
                           (bytes[i+20] << 16) | (bytes[i+21] << 24);
      const nameLen      = bytes[i+26] | (bytes[i+27] << 8);
      const extraLen     = bytes[i+28] | (bytes[i+29] << 8);
      const storedName   = new TextDecoder().decode(bytes.slice(i+30, i+30+nameLen));

      if (storedName !== target && storedName.toLowerCase() !== target.toLowerCase()) continue;

      const dataStart = i + 30 + nameLen + extraLen;
      const compressed = bytes.slice(dataStart, dataStart + compSize);

      if (compression === 0) {
        // Stored (non compressé)
        return new TextDecoder('utf-8').decode(compressed);
      } else if (compression === 8) {
        // Deflate
        const ds = new DecompressionStream('deflate-raw');
        const writer = ds.writable.getWriter();
        writer.write(compressed);
        writer.close();
        const chunks: Uint8Array[] = [];
        const reader = ds.readable.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        const total = chunks.reduce((acc, c) => acc + c.length, 0);
        const result = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          result.set(chunk, offset);
          offset += chunk.length;
        }
        return new TextDecoder('utf-8').decode(result);
      }
    }
  }
  return null;
}

// ------------------------------------------------------------
// SHA-256 du buffer ZIP pour hash checksum
// ------------------------------------------------------------
async function sha256(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ------------------------------------------------------------
// TRAITEMENT D'UN DATASET
// ------------------------------------------------------------
async function processDataset(
  supabase: ReturnType<typeof createClient>,
  dataset: {
    id: string;
    dataset_id: string;
    title: string;
    coverage_area: string;
    gtfs_url: string;
    content_hash: string | null;
  },
  triggeredBy: string
): Promise<{
  status: 'success' | 'skipped' | 'failed';
  inserted: number;
  updated: number;
  error?: string;
}> {

  console.log(`[gtfs-ingest] Traitement dataset: ${dataset.title}`);

  // 1. Résolution URL réelle depuis l'API transport.data.gouv.fr
  let downloadUrl = dataset.gtfs_url;
  try {
    const apiResp = await fetch(
      `https://transport.data.gouv.fr/api/datasets/${dataset.dataset_id}`
    );
    if (apiResp.ok) {
      const apiData = await apiResp.json();
      const gtfsResource = (apiData.resources ?? []).find(
        (r: { format: string; url: string }) =>
          r.format === 'GTFS' && r.url
      );
      if (gtfsResource?.url) downloadUrl = gtfsResource.url;
    }
  } catch {
    console.warn(`[gtfs-ingest] Impossible de résoudre URL via API, utilisation URL seed`);
  }

  // 2. Téléchargement ZIP
  let zipBuffer: ArrayBuffer;
  try {
    const resp = await fetch(downloadUrl, {
      headers: { 'User-Agent': 'Mimmoza/1.0 mobility-importer' },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    zipBuffer = await resp.arrayBuffer();
  } catch (err) {
    return { status: 'failed', inserted: 0, updated: 0, error: `Téléchargement échoué: ${err}` };
  }

  // 3. Hash checksum — skip si inchangé
  const hash = await sha256(zipBuffer);
  if (hash === dataset.content_hash) {
    console.log(`[gtfs-ingest] ${dataset.title} — inchangé, skip`);
    await supabase.from('gtfs_datasets').update({
      last_fetched_at: new Date().toISOString(),
    }).eq('id', dataset.id);
    return { status: 'skipped', inserted: 0, updated: 0 };
  }

  // 4. Extraction stops.txt
  const stopsTxt = await extractFileFromZip(zipBuffer, 'stops.txt');
  if (!stopsTxt) {
    return { status: 'failed', inserted: 0, updated: 0, error: 'stops.txt introuvable dans le ZIP' };
  }

  // 5. Extraction routes.txt (pour déduire le mode)
  const routesTxt = await extractFileFromZip(zipBuffer, 'routes.txt');

  // 6. Parse routes → Map stop_id → mode
  // On construit route_id → mode, puis via trips.txt + stop_times.txt → stop_id → mode
  // Simplification Phase 1 : on se base sur route_type du dataset entier
  // pour les gares SNCF, et sur route_type par ligne pour les urbains
  const routeModeMap = new Map<string, string>(); // route_id → mode

  if (routesTxt) {
    const routes = parseCsv(routesTxt);
    for (const r of routes) {
      const routeType = parseInt(r.route_type ?? '3', 10);
      const routeDesc = r.route_desc ?? '';
      const routeLongName = r.route_long_name ?? '';

      let mode: string | null;

      // BHNS détecté par mots-clés
      if (isBhns(routeDesc, routeLongName)) {
        mode = 'bhns';
      } else {
        mode = refineSncfMode(routeType, routeDesc, routeLongName, dataset.coverage_area);
      }

      // RER : dataset IdFM + route_type=2 + nom contient RER
      if (dataset.coverage_area === 'idf' && routeType === 2) {
        const text = `${routeDesc} ${routeLongName}`.toLowerCase();
        if (text.includes('rer')) mode = 'rer';
        else mode = 'transilien';
      }

      if (mode) routeModeMap.set(r.route_id, mode);
    }
  }

  // Mode fallback basé sur coverage_area si routes.txt absent
  function getDefaultMode(): string {
    if (dataset.coverage_area === 'national') return 'ter';
    if (dataset.coverage_area === 'idf') return 'metro';
    return 'metro';
  }

  // 7. Parse stops.txt
  const stops = parseCsv(stopsTxt);
  console.log(`[gtfs-ingest] ${dataset.title} — ${stops.length} stops bruts`);

  // 8. Filtre et préparation upsert
  // Pour Phase 1 : on garde tous les stops si le dataset est
  // un dataset de mode haute valeur (pas de bus pur)
  // La déduplication is_main_station se fait sur parent_station
  const stopsToUpsert: Array<Record<string, unknown>> = [];

  for (const stop of stops) {
    const lat = parseFloat(stop.stop_lat);
    const lon = parseFloat(stop.stop_lon);

    // Coordonnées invalides
    if (isNaN(lat) || isNaN(lon) || lat === 0 || lon === 0) continue;
    // Hors France métropolitaine + DOM (approx)
    if (lat < 41 || lat > 51.5 || lon < -5.5 || lon > 10) {
      // Garde les DOM (Martinique, Guadeloupe, Réunion, etc.)
      if (!(lat > 14 && lat < 17) && !(lat > -21.5 && lat < -20.5)) continue;
    }

    // is_main_station : true si pas de parent_station (ou parent vide)
    const isMainStation = !stop.parent_station || stop.parent_station.trim() === '';

    // Mode : depuis routeModeMap si disponible, sinon fallback dataset
    // Pour les datasets sans routes.txt, on prend le mode du dataset entier
    const mode = routeModeMap.size > 0
      ? (getDefaultMode()) // sera affiné avec trips.txt en Phase 2
      : getDefaultMode();

    stopsToUpsert.push({
      stop_id:         stop.stop_id,
      stop_name:       stop.stop_name ?? stop.stop_id,
      stop_code:       stop.stop_code ?? null,
      parent_stop_id:  stop.parent_station ?? null,
      lat,
      lon,
      mode,
      is_main_station: isMainStation,
      has_tgv:         mode === 'tgv',
      has_ter:         mode === 'ter',
      line_ids:        null, // enrichi en Phase 2 via trips + routes
      city_name:       stop.stop_timezone ?? null,
      dataset_id:      dataset.id,
      source_hash:     hash,
    });
  }

  console.log(`[gtfs-ingest] ${dataset.title} — ${stopsToUpsert.length} stops à upsert`);

  // 9. Upsert par batch de 500 (limite Supabase)
  const BATCH_SIZE = 500;
  let inserted = 0;
  let updated  = 0;

  for (let i = 0; i < stopsToUpsert.length; i += BATCH_SIZE) {
    const batch = stopsToUpsert.slice(i, i + BATCH_SIZE);
    const { error: upsertError, count } = await supabase
      .from('mobility_stops')
      .upsert(batch, {
        onConflict:        'stop_id,dataset_id',
        ignoreDuplicates:  false,
        count:             'exact',
      });

    if (upsertError) {
      console.error(`[gtfs-ingest] Batch ${i} erreur:`, upsertError);
      continue;
    }
    inserted += count ?? batch.length;
  }

  // 10. Mise à jour metadata dataset
  await supabase.from('gtfs_datasets').update({
    content_hash:    hash,
    stop_count:      stopsToUpsert.length,
    last_fetched_at: new Date().toISOString(),
    last_changed_at: new Date().toISOString(),
  }).eq('id', dataset.id);

  console.log(`[gtfs-ingest] ${dataset.title} — terminé. inserted=${inserted}`);

  return { status: 'success', inserted, updated };
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

  // Paramètre optionnel : dataset_id spécifique (pour test manuel)
  let targetDatasetId: string | null = null;
  try {
    const body = await req.json();
    targetDatasetId = body?.dataset_id ?? null;
  } catch { /* body vide = run all */ }

  const triggeredBy = targetDatasetId ? 'manual' : 'cron';

  // Récupération des datasets actifs
  let query = supabase
    .from('gtfs_datasets')
    .select('*')
    .eq('is_active', true);

  if (targetDatasetId) {
    query = query.eq('dataset_id', targetDatasetId);
  }

  const { data: datasets, error: dsError } = await query;

  if (dsError || !datasets?.length) {
    return new Response(
      JSON.stringify({ error: 'Aucun dataset actif trouvé', detail: dsError }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const results: Array<{
    dataset: string;
    status: string;
    inserted: number;
    updated: number;
    error?: string;
  }> = [];

  // Traitement séquentiel (évite surcharge mémoire Deno)
  for (const dataset of datasets) {
    // Log début
    const { data: logRow } = await supabase
      .from('gtfs_import_log')
      .insert({
        dataset_id:   dataset.id,
        status:       'running',
        triggered_by: triggeredBy,
      })
      .select('id')
      .single();

    const logId = logRow?.id;

    const result = await processDataset(supabase, dataset, triggeredBy);

    // Log fin
    if (logId) {
      await supabase.from('gtfs_import_log').update({
        finished_at:    new Date().toISOString(),
        status:         result.status,
        stops_inserted: result.inserted,
        stops_updated:  result.updated,
        error_message:  result.error ?? null,
      }).eq('id', logId);
    }

    results.push({
      dataset:  dataset.title,
      status:   result.status,
      inserted: result.inserted,
      updated:  result.updated,
      error:    result.error,
    });
  }

  const summary = {
    processed:      results.length,
    success:        results.filter(r => r.status === 'success').length,
    skipped:        results.filter(r => r.status === 'skipped').length,
    failed:         results.filter(r => r.status === 'failed').length,
    total_inserted: results.reduce((acc, r) => acc + r.inserted, 0),
    results,
  };

  console.log('[gtfs-ingest] Terminé:', JSON.stringify(summary, null, 2));

  return new Response(
    JSON.stringify(summary),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
});