// supabase/functions/market-context-v1/index.ts

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

// 🌐 CORS
const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// 📦 Types

type MarketContextInput = {
  address: string;
  zipCode: string;
  city: string;
  propertyType: "appartement" | "maison" | "immeuble" | "terrain" | "autre";
  surfaceHabitable?: number;
  priceAsked?: number;
};

type MarketContext = {
  location: {
    city: string;
    zipCode: string;
    inseeCode?: string | null;
  };
  dvfWindow: {
    periodMonths: number; // ex: 24
    radiusMeters: number; // conceptuel : on reste au niveau CP/commune ici
  };
  stats: {
    transactionsCount: number;
    priceM2Median: number | null;
    priceM2P25: number | null;
    priceM2P75: number | null;
    priceTrend12m: number | null; // en %
  };
  scores: {
    dynamismScore: number;
    liquidityScore: number;
    demandDepthScore: number;
  };
};

// 🔧 Helpers

function clamp(value: number, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  const weight = idx - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function monthsDiff(d1: Date, d2: Date): number {
  const years = d1.getFullYear() - d2.getFullYear();
  const months = d1.getMonth() - d2.getMonth();
  const total = years * 12 + months;
  // Ajuster grossièrement avec les jours
  const dayDiff = d1.getDate() - d2.getDate();
  return total + dayDiff / 30;
}

// 🌐 API DVF (data.economie.gouv.fr)
const DVF_API_BASE =
  "https://data.economie.gouv.fr/api/records/1.0/search/?dataset=valeurs-foncieres";

async function fetchDvfRecords(input: MarketContextInput) {
  const params = new URLSearchParams({
    rows: "200", // on récupère un paquet d'enregistrements récents
    sort: "-date_mutation",
  });

  // Filtre code postal
  if (input.zipCode) {
    params.append("refine.code_postal", input.zipCode);
  }

  // Filtre type local
  const typeLocalMap: Record<string, string> = {
    appartement: "Appartement",
    maison: "Maison",
  };
  const typeLocal = typeLocalMap[input.propertyType];
  if (typeLocal) {
    params.append("refine.type_local", typeLocal);
  }

  const url = `${DVF_API_BASE}&${params.toString()}`;

  const res = await fetch(url);
  if (!res.ok) {
    console.warn("DVF API non OK:", res.status, await res.text());
    return [];
  }

  const json = await res.json();
  const records = (json.records ?? []) as Array<{
    fields?: Record<string, unknown>;
  }>;

  return records;
}

serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: corsHeaders,
    });
  }

  try {
    const body = (await req.json()) as MarketContextInput;

    if (!body.zipCode || !body.city) {
      return new Response(
        JSON.stringify({
          success: false,
          error:
            "Requête incomplète : zipCode et city sont obligatoires pour le contexte marché.",
        }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        }
      );
    }

    // 1️⃣ Appel DVF
    const records = await fetchDvfRecords(body);
    const now = new Date();

    type DvfEntry = {
      date: Date;
      price: number;
      surface: number;
      priceM2: number;
    };

    const entries: DvfEntry[] = [];

    for (const rec of records) {
      const fields = rec.fields ?? {};
      const dateStr = fields["date_mutation"] as string | undefined;
      const valeur_fonciere = fields["valeur_fonciere"] as number | undefined;
      const surface_reelle_bati = fields["surface_reelle_bati"] as number | undefined;

      if (!dateStr || !valeur_fonciere || !surface_reelle_bati) continue;
      if (surface_reelle_bati <= 0) continue;

      const date = new Date(dateStr);
      const diffMonths = monthsDiff(now, date);
      if (diffMonths < 0 || diffMonths > 24) continue; // fenêtre 24 mois

      const priceM2 = valeur_fonciere / surface_reelle_bati;

      entries.push({
        date,
        price: valeur_fonciere,
        surface: surface_reelle_bati,
        priceM2,
      });
    }

    const transactionsCount = entries.length;

    // 2️⃣ Statistiques prix/m² sur 24 mois
    const allPriceM2 = entries.map((e) => e.priceM2);
    const priceM2Median = median(allPriceM2);
    const priceM2P25 = percentile(allPriceM2, 25);
    const priceM2P75 = percentile(allPriceM2, 75);

    // 3️⃣ Tendance prix 12 derniers mois vs 12–24 mois
    const last12m: number[] = [];
    const prev12m: number[] = [];

    for (const e of entries) {
      const diff = monthsDiff(now, e.date);
      if (diff <= 12) last12m.push(e.priceM2);
      else prev12m.push(e.priceM2);
    }

    const medianLast12m = median(last12m);
    const medianPrev12m = median(prev12m);

    let priceTrend12m: number | null = null; // en %
    if (medianLast12m !== null && medianPrev12m !== null && medianPrev12m > 0) {
      priceTrend12m =
        ((medianLast12m - medianPrev12m) / medianPrev12m) * 100;
    }

    // 4️⃣ Construction des scores

    // Dynamisme = intensité des transactions
    let dynamismScore = 50;
    if (transactionsCount === 0) dynamismScore = 30;
    else if (transactionsCount < 10) dynamismScore = 45;
    else if (transactionsCount < 30) dynamismScore = 60;
    else if (transactionsCount < 80) dynamismScore = 75;
    else dynamismScore = 85;

    // Liquidity = dynamisme ajusté par tendance de prix
    let liquidityScore = dynamismScore;
    if (priceTrend12m !== null) {
      if (priceTrend12m > 3) liquidityScore += 5; // marché légèrement haussier
      else if (priceTrend12m > 8) liquidityScore += 10; // marché très haussier
      else if (priceTrend12m < -5) liquidityScore -= 10; // correction forte
      else if (priceTrend12m < -2) liquidityScore -= 5;
    }
    liquidityScore = clamp(liquidityScore);

    // Profondeur de la demande = position du prix du bien vs marché
    let demandDepthScore = 70;
    if (body.priceAsked && body.surfaceHabitable && priceM2Median) {
      const priceM2Bien = body.priceAsked / body.surfaceHabitable;
      const ratio = priceM2Bien / priceM2Median;

      if (ratio > 1.25) {
        demandDepthScore -= 15; // bien cher -> demande plus étroite
      } else if (ratio > 1.10) {
        demandDepthScore -= 5;
      } else if (ratio < 0.8) {
        demandDepthScore += 10; // bien sous le marché -> plus de candidats potentiels
      } else if (ratio < 0.95) {
        demandDepthScore += 5;
      }
    }
    demandDepthScore = clamp(demandDepthScore);

    const marketContext: MarketContext = {
      location: {
        city: body.city,
        zipCode: body.zipCode,
        inseeCode: null, // à remplir plus tard si tu branches une API géo
      },
      dvfWindow: {
        periodMonths: 24,
        radiusMeters: 0, // conceptuel tant qu'on reste au niveau CP
      },
      stats: {
        transactionsCount,
        priceM2Median,
        priceM2P25,
        priceM2P75,
        priceTrend12m,
      },
      scores: {
        dynamismScore: Math.round(dynamismScore),
        liquidityScore: Math.round(liquidityScore),
        demandDepthScore: Math.round(demandDepthScore),
      },
    };

    return new Response(
      JSON.stringify({
        success: true,
        marketContext,
      }),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (err) {
    console.error("Erreur market-context-v1:", err);
    return new Response(
      JSON.stringify({
        success: false,
        error: "Erreur interne dans market-context-v1",
      }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  }
});
