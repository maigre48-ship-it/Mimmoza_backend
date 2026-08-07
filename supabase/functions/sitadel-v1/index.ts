// supabase/functions/sitadel-v1/index.ts  — v5 CSV download
//
// La tabular API data.gouv.fr retourne 400 sur TOUS les filtres pour ce resource.
// Solution : télécharger le CSV brut (5,5 Mo) et parser en mémoire dans Deno.
// Le runtime Supabase Edge Functions supporte jusqu'à 150 Mo.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

// Téléchargement direct du CSV (suit la redirection vers Minio)
const CSV_DOWNLOAD_URL =
  "https://www.data.gouv.fr/api/1/datasets/r/79c41b99-be89-485c-bf74-170c03111252";

function safeN(v: string | undefined): number {
  if (!v) return 0;
  const n = Number(v.trim().replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: CORS_HEADERS });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  let epciCode: string | undefined;
  let minYear: number;

  try {
    const body = await req.json();
    epciCode = body?.epciCode;
    minYear  = Number(body?.minYear) || (new Date().getFullYear() - 3);
  } catch {
    return ok({ ok: false, error: "body JSON invalide" });
  }

  if (!epciCode) return ok({ ok: false, error: "epciCode requis" });

  // ── Télécharger le CSV ────────────────────────────────────────────
  let text: string;
  try {
    const resp = await fetch(CSV_DOWNLOAD_URL, {
      redirect: "follow",
      headers:  { Accept: "text/csv,text/plain,*/*" },
    });
    if (!resp.ok) {
      return ok({ ok: false, error: `CSV download HTTP ${resp.status}` });
    }
    text = await resp.text();
    console.log(`[sitadel-v1] CSV downloaded: ${Math.round(text.length / 1024)} Ko`);
  } catch (err) {
    return ok({ ok: false, error: `CSV fetch failed: ${err}` });
  }

  // ── Parser CSV ────────────────────────────────────────────────────
  const lines = text.split("\n");
  if (lines.length < 2) return ok({ ok: false, error: "CSV vide ou invalide" });

  // Détecter le séparateur (FR gov = souvent ";" )
  const header0 = lines[0];
  const sep     = header0.includes(";") ? ";" : ",";
  const headers = header0.split(sep).map(h => h.trim().replace(/^"|"$/g, "").toUpperCase());

  const epciIdx = headers.findIndex(h => h === "EPCI");
  const anneeIdx= headers.findIndex(h => h === "ANNEE");
  const logIdx  = headers.findIndex(h => h === "LOG_AUT");
  const sdpIdx  = headers.findIndex(h => h === "SDP_AUT");

  console.log(`[sitadel-v1] headers: ${JSON.stringify(headers)}`);
  console.log(`[sitadel-v1] col indices: EPCI=${epciIdx} ANNEE=${anneeIdx} LOG_AUT=${logIdx} SDP_AUT=${sdpIdx}`);

  if (epciIdx < 0 || logIdx < 0) {
    return ok({ ok: false, error: "colonnes EPCI ou LOG_AUT introuvables", headers });
  }

  // ── Agréger les lignes correspondantes ────────────────────────────
  const minYearStr = String(minYear);
  let logements = 0;
  let surface   = 0;
  let matched   = 0;
  const sampleEpcis: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cells = line.split(sep);

    // Collecter quelques EPCI pour diagnostic
    if (sampleEpcis.length < 5) {
      const e = cells[epciIdx]?.trim().replace(/^"|"$/g, "");
      if (e && !sampleEpcis.includes(e)) sampleEpcis.push(e);
    }

    const rowEpci = cells[epciIdx]?.trim().replace(/^"|"$/g, "");
    if (rowEpci !== epciCode) continue;

    // Filtre année optionnel
    if (anneeIdx >= 0) {
      const rowAnnee = cells[anneeIdx]?.trim().replace(/^"|"$/g, "");
      if (rowAnnee && rowAnnee < minYearStr) continue;
    }

    logements += safeN(cells[logIdx]);
    surface   += safeN(sdpIdx >= 0 ? cells[sdpIdx] : undefined);
    matched++;
  }

  console.log(`[sitadel-v1] scan done: lines=${lines.length} matched=${matched} LOG=${logements} SDP=${surface} sampleEpcis=${JSON.stringify(sampleEpcis)}`);

  if (matched === 0) {
    return ok({ ok: false, error: `EPCI ${epciCode} non trouvé dans le CSV`, sampleEpcis });
  }

  return ok({
    ok: true, epciCode,
    rows:     matched,
    logements,
    surface,
    anneeMin: minYear,
    strategy: "csv_download",
  });
});