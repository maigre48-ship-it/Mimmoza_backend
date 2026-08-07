// supabase/functions/import-maires-rne-v1/index.ts

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const RNE_URL =
  "https://www.data.gouv.fr/fr/datasets/r/d5f400de-ae3f-4966-8cb6-a85c70c6c24a";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const UPSERT_CHUNK_SIZE = 200;

type MaireInsert = {
  code_insee: string;
  code_departement: string | null;
  nom_departement: string | null;
  nom_commune: string;
  civilite: string | null;
  nom: string | null;
  prenom: string | null;
  date_naissance: string | null;
  code_sexe: string | null;
  profession_libelle: string | null;
  date_debut_mandat: string | null;
  date_debut_fonction: string | null;
  libelle_fonction: string | null;
  libelle_mandat: string | null;
};

type ColumnMap = {
  codeDep: number;
  nomDep: number;
  codeCom: number;
  nomCom: number;
  nom: number;
  prenom: number;
  codeSexe: number;
  dateNaiss: number;
  profession: number;
  dateDebutMandat: number;
  dateDebutFonction: number;
  libelleFonction: number;
  libelleMandat: number;
};

function parseCsvLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }

  fields.push(cur);
  return fields;
}

function normalizeKey(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function normalizeLooseText(s?: string | null): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function findColumn(headers: string[], candidates: string[]): number {
  const normalizedHeaders = headers.map(normalizeKey);

  for (const candidate of candidates) {
    const idx = normalizedHeaders.indexOf(normalizeKey(candidate));
    if (idx >= 0) return idx;
  }

  return -1;
}

function nn(s?: string): string | null {
  if (!s) return null;
  const t = s.trim();
  return t.length > 0 ? t : null;
}

function toIsoDate(s?: string): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (!trimmed) return null;

  const m = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;

  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    return trimmed.slice(0, 10);
  }

  return null;
}

function civiliteFromCodeSexe(code: string | null): string | null {
  if (code === "M") return "M.";
  if (code === "F") return "Mme";
  return null;
}

function stripBom(s: string): string {
  if (!s) return s;
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function isMayorRow(libelleFonction: string | null, libelleMandat: string | null): boolean {
  const f = normalizeLooseText(libelleFonction);
  const m = normalizeLooseText(libelleMandat);
  const combined = `${f} ${m}`.trim();

  // On vise "maire" mais on exclut explicitement "adjoint au maire" etc.
  if (!combined.includes("maire")) return false;

  const excludedPatterns = [
    "adjoint au maire",
    "adjointe au maire",
    "adjoint",
    "adjointe",
    "conseiller municipal",
    "conseillere municipale",
    "conseillère municipale",
    "conseiller",
    "conseillere",
    "conseillère",
    "delegue",
    "délégué",
    "deleguee",
    "déléguée",
    "membre",
  ];

  for (const pattern of excludedPatterns) {
    if (combined.includes(pattern)) return false;
  }

  const acceptedPatterns = [
    "maire",
    "maire de la commune",
    "maire d'arrondissement",
    "maire delegue",
    "maire délégué",
    "maire deleguee",
    "maire déléguée",
  ];

  return acceptedPatterns.some((pattern) => combined.includes(pattern));
}

function buildRow(fields: string[], col: ColumnMap): MaireInsert | null {
  const codeInsee = nn(fields[col.codeCom]);
  const nomCommune = nn(fields[col.nomCom]);

  if (!codeInsee || !nomCommune) return null;

  const codeSexe = col.codeSexe >= 0 ? nn(fields[col.codeSexe]) : null;
  const libelleFonction = col.libelleFonction >= 0 ? nn(fields[col.libelleFonction]) : null;
  const libelleMandat = col.libelleMandat >= 0 ? nn(fields[col.libelleMandat]) : null;

  if (!isMayorRow(libelleFonction, libelleMandat)) {
    return null;
  }

  return {
    code_insee: codeInsee,
    code_departement: col.codeDep >= 0 ? nn(fields[col.codeDep]) : null,
    nom_departement: col.nomDep >= 0 ? nn(fields[col.nomDep]) : null,
    nom_commune: nomCommune,
    civilite: civiliteFromCodeSexe(codeSexe),
    nom: col.nom >= 0 ? nn(fields[col.nom]) : null,
    prenom: col.prenom >= 0 ? nn(fields[col.prenom]) : null,
    date_naissance: col.dateNaiss >= 0 ? toIsoDate(fields[col.dateNaiss]) : null,
    code_sexe: codeSexe,
    profession_libelle: col.profession >= 0 ? nn(fields[col.profession]) : null,
    date_debut_mandat:
      col.dateDebutMandat >= 0 ? toIsoDate(fields[col.dateDebutMandat]) : null,
    date_debut_fonction:
      col.dateDebutFonction >= 0 ? toIsoDate(fields[col.dateDebutFonction]) : null,
    libelle_fonction: libelleFonction,
    libelle_mandat: libelleMandat,
  };
}

function chooseBestMayorRow(rows: MaireInsert[]): MaireInsert[] {
  const map = new Map<string, MaireInsert>();

  for (const row of rows) {
    if (!row.code_insee) continue;

    const existing = map.get(row.code_insee);
    if (!existing) {
      map.set(row.code_insee, row);
      continue;
    }

    const currentScore =
      (row.nom ? 1 : 0) +
      (row.prenom ? 1 : 0) +
      (row.date_debut_fonction ? 1 : 0) +
      (row.libelle_fonction ? 1 : 0) +
      (row.libelle_mandat ? 1 : 0);

    const existingScore =
      (existing.nom ? 1 : 0) +
      (existing.prenom ? 1 : 0) +
      (existing.date_debut_fonction ? 1 : 0) +
      (existing.libelle_fonction ? 1 : 0) +
      (existing.libelle_mandat ? 1 : 0);

    if (currentScore >= existingScore) {
      map.set(row.code_insee, row);
    }
  }

  return Array.from(map.values());
}

async function upsertChunk(
  supabase: any,
  chunk: MaireInsert[],
  importedSoFar: number,
): Promise<number> {
  if (!Array.isArray(chunk) || chunk.length === 0) {
    return importedSoFar;
  }

  const deduped = chooseBestMayorRow(chunk);

  if (deduped.length === 0) {
    return importedSoFar;
  }

  console.log(
    `[import-rne] upsert chunk raw=${chunk.length} deduped=${deduped.length} importedSoFar=${importedSoFar}`,
  );

  const result = await supabase
    .from("maires_rne")
    .upsert(deduped, { onConflict: "code_insee" });

  if (!result) {
    throw new Error("upsert a retourné undefined");
  }

  if (result.error) {
    throw new Error(
      `Upsert échoué après ${importedSoFar} lignes : ${result.error.message}`,
    );
  }

  return importedSoFar + deduped.length;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(
      JSON.stringify({
        error: "SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY manquant côté Edge Function",
      }),
      {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      },
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const limit =
    typeof body.limit === "number" && Number.isFinite(body.limit) && body.limit > 0
      ? Math.floor(body.limit)
      : null;

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const startedAt = Date.now();

  try {
    console.log(`[import-rne] download ${RNE_URL} limit=${limit ?? "none"}`);

    const resp = await fetch(RNE_URL, {
      method: "GET",
      headers: {
        Accept: "text/csv, text/plain;q=0.9, */*;q=0.8",
      },
    });

    if (!resp.ok) {
      return new Response(
        JSON.stringify({ error: `Téléchargement RNE échoué : HTTP ${resp.status}` }),
        {
          status: 502,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        },
      );
    }

    const text = await resp.text();

    if (!text || text.trim().length === 0) {
      return new Response(JSON.stringify({ error: "Réponse RNE vide" }), {
        status: 502,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);

    if (lines.length < 2) {
      return new Response(JSON.stringify({ error: "CSV RNE vide ou malformé" }), {
        status: 502,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const headers = parseCsvLine(stripBom(lines[0]), ";");

    const col: ColumnMap = {
      codeDep: findColumn(headers, ["Code du département", "Code département"]),
      nomDep: findColumn(headers, ["Libellé du département", "Nom département"]),
      codeCom: findColumn(headers, ["Code de la commune", "Code commune"]),
      nomCom: findColumn(headers, ["Libellé de la commune", "Nom commune"]),
      nom: findColumn(headers, ["Nom de l'élu", "Nom"]),
      prenom: findColumn(headers, ["Prénom de l'élu", "Prenom de l'elu", "Prénom"]),
      codeSexe: findColumn(headers, ["Code sexe", "Sexe"]),
      dateNaiss: findColumn(headers, ["Date de naissance"]),
      profession: findColumn(headers, ["Libellé de la profession", "Profession"]),
      dateDebutMandat: findColumn(headers, [
        "Date de début du mandat",
        "Date de debut du mandat",
      ]),
      dateDebutFonction: findColumn(headers, [
        "Date de début de la fonction",
        "Date de debut de la fonction",
      ]),
      libelleFonction: findColumn(headers, [
        "Libellé de la fonction",
        "Libelle de la fonction",
        "Fonction",
        "Qualité",
        "Qualite",
      ]),
      libelleMandat: findColumn(headers, [
        "Libellé du mandat",
        "Libelle du mandat",
        "Mandat",
      ]),
    };

    console.log("[import-rne] headers detected:", headers.join(" | "));
    console.log("[import-rne] column map:", JSON.stringify(col));

    if (col.codeCom < 0 || col.nomCom < 0) {
      return new Response(
        JSON.stringify({
          error: "Colonnes RNE introuvables (code/libellé commune). Structure du CSV modifiée ?",
          headersDetected: headers,
        }),
        {
          status: 500,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        },
      );
    }

    if (col.libelleFonction < 0 && col.libelleMandat < 0) {
      return new Response(
        JSON.stringify({
          error: "Impossible d'identifier une colonne de fonction/mandat dans le CSV RNE.",
          headersDetected: headers,
        }),
        {
          status: 500,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        },
      );
    }

    let imported = 0;
    let totalRowsSeen = 0;
    let totalRowsBuilt = 0;
    let totalMayorRows = 0;
    let upsertBuffer: MaireInsert[] = [];

    for (let i = 1; i < lines.length; i++) {
      totalRowsSeen++;

      const fields = parseCsvLine(lines[i], ";");
      const row = buildRow(fields, col);

      if (row) {
        totalMayorRows++;
        totalRowsBuilt++;
        upsertBuffer.push(row);
      }

      if (upsertBuffer.length >= UPSERT_CHUNK_SIZE) {
        imported = await upsertChunk(supabase, upsertBuffer, imported);
        upsertBuffer = [];
      }

      if (limit !== null && totalRowsSeen >= limit) {
        console.log(`[import-rne] limit reached: ${limit}`);
        break;
      }
    }

    if (upsertBuffer.length > 0) {
      imported = await upsertChunk(supabase, upsertBuffer, imported);
      upsertBuffer = [];
    }

    const durationMs = Date.now() - startedAt;

    return new Response(
      JSON.stringify({
        ok: true,
        imported,
        totalRowsSeen,
        totalRowsBuilt,
        totalMayorRows,
        limit,
        durationMs,
      }),
      {
        status: 200,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erreur inattendue";
    console.error("[import-rne] fatal:", message);

    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});