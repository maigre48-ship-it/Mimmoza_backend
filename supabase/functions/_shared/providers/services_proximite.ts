// supabase/functions/_shared/providers/services_proximite.ts
// Provider minimal – services de proximité en zone rurale
// Alimente uniquement market.services_ruraux

export type ServiceRuralItem = {
  name: string;
  category:
    | "supérette"
    | "poste"
    | "banque_dab"
    | "station_service"
    | "pharmacie"
    | "supermarché";
  distance_km: number;
};

export function buildServicesRurauxFallback(): ServiceRuralItem[] {
  return [
    { name: "SPAR", category: "supérette", distance_km: 0.2 },
    { name: "La Poste", category: "poste", distance_km: 0.2 },
    { name: "DAB (banque)", category: "banque_dab", distance_km: 4.8 },
    { name: "Station-service", category: "station_service", distance_km: 3.9 },
  ];
}

// --------------------------------------------------
// ✅ Export attendu par smartscore-enriched-v3
// Objectif: éviter le BootFailure en production.
// On renvoie uniquement le fallback "services ruraux".
// --------------------------------------------------
export function servicesProximiteV1(): ServiceRuralItem[] {
  return buildServicesRurauxFallback();
}
