/**
 * Sourcing Analyze V1 - Edge Function
 * Normalise les données d'entrée et effectue le géocodage
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

// Types importés (inline pour Edge Functions)
type ProfileTarget = 'mdb' | 'promoteur' | 'particulier';
type PropertyType = 'appartement' | 'maison' | 'terrain' | 'immeuble' | 'local_commercial' | 'bureau';
type FloorType = 'rdc' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10+' | 'dernier' | 'n/a';
type ProximityTransport = 'metro' | 'rer' | 'tramway' | 'bus' | 'gare' | 'aucun' | 'unknown';
type NuisanceLevel = 'aucune' | 'faible' | 'moyenne' | 'forte' | 'unknown';
type StandingLevel = 'basique' | 'standard' | 'premium' | 'luxe' | 'unknown';

interface SourcingLocation {
  codePostal: string;
  rueProche: string;
  ville?: string;
  adresseExacte?: string;
  commune?: string;
  departement?: string;
}

interface SourcingInputBase {
  price: number;
  surface: number;
  propertyType: PropertyType;
  floor: FloorType;
  nbPieces?: number;
  nbChambres?: number;
  anneeConstruction?: number;
  etatGeneral?: 'neuf' | 'tres_bon' | 'bon' | 'moyen' | 'a_renover' | 'ruine';
  dpe?: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'unknown';
  ascenseur?: boolean;
  balcon?: boolean;
  terrasse?: boolean;
  cave?: boolean;
  parking?: boolean;
  gardien?: boolean;
  digicode?: boolean;
  jardin?: boolean;
  jardinSurface?: number;
  piscine?: boolean;
  garage?: boolean;
  dependances?: boolean;
  viabilise?: boolean;
  constructible?: boolean;
  pluZone?: string;
  nbLots?: number;
  nbEtages?: number;
  copropriete?: boolean;
}

interface SourcingQuartier {
  proximiteTransport?: ProximityTransport;
  distanceTransport?: number;
  nuisances?: NuisanceLevel;
  standing?: StandingLevel;
  commercesProximite?: boolean;
  ecolesProximite?: boolean;
  espacesVerts?: boolean;
  securite?: 'bonne' | 'moyenne' | 'faible' | 'unknown';
}

interface SourcingItemDraft {
  profileTarget: ProfileTarget;
  location: SourcingLocation;
  input: SourcingInputBase;
  quartier?: SourcingQuartier;
  notes?: string;
  sourceUrl?: string;
  sourceType?: 'seloger' | 'leboncoin' | 'pap' | 'notaire' | 'autre' | 'manual';
}

interface GeocodeResult {
  found: boolean;
  confidence: number;
  lat?: number;
  lon?: number;
  label?: string;
  communeInsee?: string;
  communeName?: string;
  departement?: string;
  region?: string;
  postcode?: string;
  citycode?: string;
  type?: string;
  score?: number;
}

interface GeocodeResponse {
  bestMatch: GeocodeResult | null;
  alternatives: GeocodeResult[];
  query: string;
  source: 'geo.api.gouv.fr';
  fetchedAt: string;
}

interface NormalizedLocation extends SourcingLocation {
  communeInsee?: string;
  departementCode?: string;
  regionCode?: string;
  latitude?: number;
  longitude?: number;
  geocodeConfidence?: number;
}

interface NormalizedInput extends SourcingInputBase {
  pricePerSqm: number;
  surfaceCategory: 'studio' | 'small' | 'medium' | 'large' | 'very_large';
}

interface SourcingItemNormalized {
  profileTarget: ProfileTarget;
  location: NormalizedLocation;
  input: NormalizedInput;
  quartier: SourcingQuartier;
  notes?: string;
  sourceUrl?: string;
  sourceType?: string;
  normalizedAt: string;
  version: string;
}

interface AnalyzeResponse {
  success: boolean;
  normalized: SourcingItemNormalized | null;
  geocode: GeocodeResponse | null;
  hints: string[];
  warnings: string[];
  errors: string[];
  processingTimeMs: number;
}

// ============================================================================
// CORS HEADERS
// ============================================================================

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ============================================================================
// VALIDATION
// ============================================================================

function validateDraft(draft: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  if (!draft || typeof draft !== 'object') {
    return { valid: false, errors: ['Invalid draft: must be an object'] };
  }
  
  const d = draft as Record<string, unknown>;
  
  // profileTarget
  if (!d.profileTarget || !['mdb', 'promoteur', 'particulier'].includes(d.profileTarget as string)) {
    errors.push('profileTarget must be one of: mdb, promoteur, particulier');
  }
  
  // location
  if (!d.location || typeof d.location !== 'object') {
    errors.push('location is required and must be an object');
  } else {
    const loc = d.location as Record<string, unknown>;
    if (!loc.codePostal || typeof loc.codePostal !== 'string' || !/^\d{5}$/.test(loc.codePostal)) {
      errors.push('location.codePostal is required and must be a 5-digit string');
    }
    if (!loc.rueProche || typeof loc.rueProche !== 'string' || loc.rueProche.length < 2) {
      errors.push('location.rueProche is required and must be at least 2 characters');
    }
  }
  
  // input
  if (!d.input || typeof d.input !== 'object') {
    errors.push('input is required and must be an object');
  } else {
    const inp = d.input as Record<string, unknown>;
    if (typeof inp.price !== 'number' || inp.price <= 0) {
      errors.push('input.price is required and must be a positive number');
    }
    if (typeof inp.surface !== 'number' || inp.surface <= 0) {
      errors.push('input.surface is required and must be a positive number');
    }
    const validTypes = ['appartement', 'maison', 'terrain', 'immeuble', 'local_commercial', 'bureau'];
    if (!inp.propertyType || !validTypes.includes(inp.propertyType as string)) {
      errors.push(`input.propertyType must be one of: ${validTypes.join(', ')}`);
    }
    const validFloors = ['rdc', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10+', 'dernier', 'n/a'];
    if (!inp.floor || !validFloors.includes(inp.floor as string)) {
      errors.push(`input.floor must be one of: ${validFloors.join(', ')}`);
    }
  }
  
  return { valid: errors.length === 0, errors };
}

// ============================================================================
// GEOCODING
// ============================================================================

async function geocodeAddress(location: SourcingLocation): Promise<GeocodeResponse> {
  const fetchedAt = new Date().toISOString();
  
  // Construire la query
  const queryParts: string[] = [];
  
  if (location.adresseExacte) {
    queryParts.push(location.adresseExacte);
  } else {
    queryParts.push(location.rueProche);
  }
  
  if (location.ville) {
    queryParts.push(location.ville);
  }
  
  queryParts.push(location.codePostal);
  
  const query = queryParts.join(' ');
  
  try {
    const url = new URL('https://api-adresse.data.gouv.fr/search/');
    url.searchParams.set('q', query);
    url.searchParams.set('postcode', location.codePostal);
    url.searchParams.set('limit', '5');
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    
    const response = await fetch(url.toString(), {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      console.error(`Geocode API error: ${response.status}`);
      return {
        bestMatch: null,
        alternatives: [],
        query,
        source: 'geo.api.gouv.fr',
        fetchedAt,
      };
    }
    
    const data = await response.json();
    const features = data.features || [];
    
    if (features.length === 0) {
      return {
        bestMatch: null,
        alternatives: [],
        query,
        source: 'geo.api.gouv.fr',
        fetchedAt,
      };
    }
    
    const results: GeocodeResult[] = features.map((f: Record<string, unknown>) => {
      const props = f.properties as Record<string, unknown>;
      const geom = f.geometry as Record<string, unknown>;
      const coords = geom.coordinates as number[];
      const score = (props.score as number) || 0;
      
      return {
        found: true,
        confidence: Math.min(score, 1),
        lat: coords[1],
        lon: coords[0],
        label: props.label as string,
        communeInsee: props.citycode as string,
        communeName: props.city as string,
        departement: (props.context as string)?.split(',')[0]?.trim(),
        region: (props.context as string)?.split(',')[2]?.trim(),
        postcode: props.postcode as string,
        citycode: props.citycode as string,
        type: props.type as string,
        score,
      };
    });
    
    return {
      bestMatch: results[0] || null,
      alternatives: results.slice(1),
      query,
      source: 'geo.api.gouv.fr',
      fetchedAt,
    };
    
  } catch (error) {
    console.error('Geocode fetch error:', error);
    return {
      bestMatch: null,
      alternatives: [],
      query,
      source: 'geo.api.gouv.fr',
      fetchedAt,
    };
  }
}

// ============================================================================
// NORMALIZATION
// ============================================================================

function getSurfaceCategory(surface: number): 'studio' | 'small' | 'medium' | 'large' | 'very_large' {
  if (surface < 25) return 'studio';
  if (surface < 50) return 'small';
  if (surface < 80) return 'medium';
  if (surface < 120) return 'large';
  return 'very_large';
}

function normalizeQuartier(quartier?: SourcingQuartier): SourcingQuartier {
  return {
    proximiteTransport: quartier?.proximiteTransport || 'unknown',
    distanceTransport: quartier?.distanceTransport,
    nuisances: quartier?.nuisances || 'unknown',
    standing: quartier?.standing || 'unknown',
    commercesProximite: quartier?.commercesProximite,
    ecolesProximite: quartier?.ecolesProximite,
    espacesVerts: quartier?.espacesVerts,
    securite: quartier?.securite || 'unknown',
  };
}

function normalizeDraft(
  draft: SourcingItemDraft,
  geocode: GeocodeResponse | null
): { normalized: SourcingItemNormalized; hints: string[]; warnings: string[] } {
  const hints: string[] = [];
  const warnings: string[] = [];
  
  // Normalize location
  const normalizedLocation: NormalizedLocation = {
    ...draft.location,
    departementCode: draft.location.codePostal.substring(0, 2),
  };
  
  // Enrichir avec géocode si disponible
  if (geocode?.bestMatch?.found) {
    normalizedLocation.communeInsee = geocode.bestMatch.communeInsee;
    normalizedLocation.latitude = geocode.bestMatch.lat;
    normalizedLocation.longitude = geocode.bestMatch.lon;
    normalizedLocation.geocodeConfidence = geocode.bestMatch.confidence;
    
    if (geocode.bestMatch.communeName && !draft.location.ville) {
      normalizedLocation.ville = geocode.bestMatch.communeName;
    }
  } else {
    warnings.push('Géocodage non trouvé - le scoring sera moins précis');
    hints.push('Précisez l\'adresse exacte ou le nom de la ville pour améliorer le géocodage');
  }
  
  // Normalize input
  const pricePerSqm = draft.input.price / draft.input.surface;
  const normalizedInput: NormalizedInput = {
    ...draft.input,
    pricePerSqm: Math.round(pricePerSqm),
    surfaceCategory: getSurfaceCategory(draft.input.surface),
  };
  
  // Validation cohérence type/floor
  if (draft.input.propertyType === 'terrain' && draft.input.floor !== 'n/a') {
    warnings.push('Type terrain avec étage spécifié - floor devrait être "n/a"');
  }
  if (draft.input.propertyType === 'maison' && !['rdc', 'n/a'].includes(draft.input.floor)) {
    hints.push('Pour une maison, l\'étage est généralement "rdc" ou "n/a"');
  }
  
  // Normalize quartier avec defaults
  const normalizedQuartier = normalizeQuartier(draft.quartier);
  
  // Hints basés sur données manquantes
  if (normalizedQuartier.proximiteTransport === 'unknown') {
    hints.push('Renseignez la proximité transport pour un score de localisation plus précis');
  }
  if (normalizedQuartier.nuisances === 'unknown') {
    hints.push('Indiquez le niveau de nuisances pour affiner le score');
  }
  if (!draft.input.dpe || draft.input.dpe === 'unknown') {
    hints.push('Ajoutez le DPE pour évaluer le risque travaux');
  }
  if (!draft.input.etatGeneral) {
    hints.push('Précisez l\'état général du bien');
  }
  
  const normalized: SourcingItemNormalized = {
    profileTarget: draft.profileTarget,
    location: normalizedLocation,
    input: normalizedInput,
    quartier: normalizedQuartier,
    notes: draft.notes,
    sourceUrl: draft.sourceUrl,
    sourceType: draft.sourceType,
    normalizedAt: new Date().toISOString(),
    version: '1.0.0',
  };
  
  return { normalized, hints, warnings };
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

serve(async (req: Request) => {
  const startTime = Date.now();
  
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  
  // Only accept POST
  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ success: false, errors: ['Method not allowed'] }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
  
  try {
    // Parse body
    const body = await req.json();
    const draft = body.draft as SourcingItemDraft;
    const saveToDb = body.saveToDb === true;
    
    // Validate
    const validation = validateDraft(draft);
    if (!validation.valid) {
      return new Response(
        JSON.stringify({
          success: false,
          normalized: null,
          geocode: null,
          hints: [],
          warnings: [],
          errors: validation.errors,
          processingTimeMs: Date.now() - startTime,
        } as AnalyzeResponse),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    // Geocode
    const geocode = await geocodeAddress(draft.location);
    
    // Normalize
    const { normalized, hints, warnings } = normalizeDraft(draft, geocode);
    
    // Optionally save to database
    if (saveToDb) {
      try {
        const supabaseUrl = Deno.env.get('SUPABASE_URL');
        const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
        
        if (supabaseUrl && supabaseKey) {
          const supabase = createClient(supabaseUrl, supabaseKey);
          
          // Get user from auth header if present
          const authHeader = req.headers.get('Authorization');
          let userId: string | null = null;
          
          if (authHeader?.startsWith('Bearer ')) {
            const token = authHeader.substring(7);
            const { data: userData } = await supabase.auth.getUser(token);
            userId = userData?.user?.id || null;
          }
          
          const { error: insertError } = await supabase
            .from('sourcing_items')
            .insert({
              user_id: userId,
              profile_target: normalized.profileTarget,
              status: 'analyzed',
              input_json: draft,
              normalized_json: normalized,
              geocode_json: geocode,
              code_postal: normalized.location.codePostal,
              commune_insee: normalized.location.communeInsee,
            });
          
          if (insertError) {
            console.error('DB insert error:', insertError);
            warnings.push('Sauvegarde en base échouée - les données restent disponibles');
          }
        }
      } catch (dbError) {
        console.error('DB error:', dbError);
        warnings.push('Erreur de connexion à la base de données');
      }
    }
    
    // Response
    const response: AnalyzeResponse = {
      success: true,
      normalized,
      geocode,
      hints,
      warnings,
      errors: [],
      processingTimeMs: Date.now() - startTime,
    };
    
    return new Response(
      JSON.stringify(response),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
    
  } catch (error) {
    console.error('Handler error:', error);
    
    return new Response(
      JSON.stringify({
        success: false,
        normalized: null,
        geocode: null,
        hints: [],
        warnings: [],
        errors: [error instanceof Error ? error.message : 'Unknown error'],
        processingTimeMs: Date.now() - startTime,
      } as AnalyzeResponse),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});