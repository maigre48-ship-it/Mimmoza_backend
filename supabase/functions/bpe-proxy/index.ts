// supabase/functions/bpe-proxy/index.ts
// ✅ VERSION v4.1 - Codes corrigés (pharmacies, stations, etc.)
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { corsHeaders } from "../_shared/cors.ts";

const ODS_API_URL = "https://public.opendatasoft.com/api/records/1.0/search/";
const ODS_DATASET = "buildingref-france-bpe-all-geolocated";

// ✅ TYPES ESSENTIELS CORRIGÉS
const TYPES_ESSENTIELS = new Set([
  // Santé
  "D301", // Pharmacie ✅
  "D201", // Médecin généraliste
  "D202", "D203", "D204", "D205", "D206", "D207", "D208", "D209", "D210", "D211", // Spécialistes
  "D221", // Dentiste
  "D232", // Infirmier
  "D233", // Kiné
  
  // Banque (agences uniquement)
  "A203", // Banque (agence) ✅
  // "A204", // DAB - on retire les distributeurs
  
  // Poste
  "A206", "A207", "A208",
  
  // Commerces alimentaires
  "B101", // Hypermarché
  "B102", // Supermarché
  "B103", // Supérette
  "B201", // Boulangerie
  "B202", // Boucherie
  "B203", // Produits surgelés
  "B204", // Poissonnerie
  
  // Station service ✅ CORRIGÉ
  "B306", // Station-service (pas B313 qui est magasin d'optique)
  
  // Sécurité
  "A101", // Police/Commissariat
  "A104", // Gendarmerie
]);

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function fetchBpeFromODS(
  lat: number,
  lon: number,
  radiusM: number,
  typeCodes: string[] | null,
  limit: number
): Promise<{ items: any[]; error: string | null; debug: any }> {
  const debugInfo: any = { requests: [], totalRecords: 0 };
  const allItems: any[] = [];

  let start = 0;
  const pageSize = 100;
  let hasMore = true;
  let pageCount = 0;
  const maxPages = 30;

  while (hasMore && pageCount < maxPages) {
    const url = `${ODS_API_URL}?dataset=${ODS_DATASET}&rows=${pageSize}&start=${start}&geofilter.distance=${lat},${lon},${radiusM}`;
    
    console.log(`📡 ODS API v1.0 page ${pageCount + 1}`);
    debugInfo.requests.push({ url, status: null, recordCount: 0 });

    try {
      const resp = await fetch(url, {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(30000),
      });

      debugInfo.requests[pageCount].status = resp.status;

      if (!resp.ok) {
        const errorText = await resp.text();
        console.error(`ODS API error: ${resp.status}`);
        debugInfo.requests[pageCount].error = errorText.substring(0, 500);
        if (pageCount === 0) {
          return { items: [], error: `ODS API error: ${resp.status}`, debug: debugInfo };
        }
        break;
      }

      const jsonData = await resp.json();
      const records = jsonData.records || [];
      const totalCount = jsonData.nhits || 0;
      
      debugInfo.requests[pageCount].recordCount = records.length;
      debugInfo.totalRecords += records.length;
      debugInfo.totalAvailable = totalCount;

      for (const record of records) {
        const fields = record.fields || {};
        
        const equipmentCodes = fields.equipment_code || [];
        const typeCode = Array.isArray(equipmentCodes) ? equipmentCodes[0] : equipmentCodes;

        if (!typeCode) continue;

        // Filtrer
        if (typeCodes && typeCodes.length > 0) {
          if (!typeCodes.includes(typeCode)) continue;
        } else {
          if (!TYPES_ESSENTIELS.has(typeCode)) continue;
        }

        const geoPoint = fields.geo_point_2d;
        if (!geoPoint) continue;
        
        let eqLat: number;
        let eqLon: number;
        
        if (Array.isArray(geoPoint)) {
          eqLat = geoPoint[0];
          eqLon = geoPoint[1];
        } else {
          eqLat = geoPoint.lat;
          eqLon = geoPoint.lon;
        }

        if (!eqLat || !eqLon) continue;

        const distance_m = haversineDistance(lat, lon, eqLat, eqLon);

        const equipmentNames = fields.equipment_name || [];
        const nom = Array.isArray(equipmentNames) ? equipmentNames[0] : equipmentNames;

        const commune = fields.com_arm_name || null;
        
        const comArmCodes = fields.com_arm_code || [];
        const codeCommune = Array.isArray(comArmCodes) ? comArmCodes[0] : comArmCodes;

        allItems.push({
          type_code: typeCode,
          nom: nom || null,
          commune: commune,
          code_commune: codeCommune,
          latitude: eqLat,
          longitude: eqLon,
          distance_m: Math.round(distance_m),
        });
      }

      if (records.length < pageSize || start + pageSize >= totalCount) {
        hasMore = false;
      } else {
        start += pageSize;
        pageCount++;
      }

    } catch (e) {
      console.error(`ODS fetch error page ${pageCount + 1}:`, e);
      debugInfo.requests[pageCount].error = String(e);
      if (pageCount === 0) {
        return { items: [], error: String(e), debug: debugInfo };
      }
      break;
    }
  }

  allItems.sort((a, b) => a.distance_m - b.distance_m);
  debugInfo.essentialItemsCount = allItems.length;
  
  return { items: allItems.slice(0, limit), error: null, debug: debugInfo };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { success: false, error: "Method not allowed" });

  const payload = await req.json().catch(() => null);
  if (!payload) return json(400, { success: false, error: "Invalid JSON" });

  const lat = Number(payload.lat);
  const lon = Number(payload.lon);
  const radius_m = Number(payload.radius_m ?? 20000);
  const type_codes = Array.isArray(payload.type_codes) ? payload.type_codes : null;
  const limit = Number(payload.limit ?? 500);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return json(400, { success: false, error: "lat/lon required" });
  }

  console.log(`📦 bpe-proxy v4.1: lat=${lat}, lon=${lon}, radius=${radius_m}m`);

  try {
    const { items, error, debug } = await fetchBpeFromODS(lat, lon, radius_m, type_codes, limit);

    if (error) {
      return json(200, { success: false, items: [], count: 0, error, debug });
    }

    console.log(`✅ bpe-proxy: ${items.length} items`);

    return json(200, {
      success: true,
      items,
      count: items.length,
      source: "opendatasoft-v1.0",
      params: { lat, lon, radius_m },
    });

  } catch (e) {
    console.error("bpe-proxy error:", e);
    return json(500, { success: false, error: "Internal error", details: String(e) });
  }
});