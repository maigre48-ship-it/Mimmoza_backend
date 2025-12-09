// supabase/functions/plu-extract-article-v1/index.ts
// Version : v1.1 – fallback sur le texte envoyé si l’article n’est pas trouvé dans le JSON

// -----------------------------------------------------------------------------
// CORS helpers
// -----------------------------------------------------------------------------
const corsHeaders: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(
  body: unknown,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers || {});
  for (const [k, v] of Object.entries(corsHeaders)) {
    headers.set(k, v);
  }
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
}

// -----------------------------------------------------------------------------
// Petit parseur pour extraire l’emprise max (ratio) à partir d’un texte type UC9
// Exemple : “L’emprise au sol … ne doit pas excéder 40% …”  →  0.4
// -----------------------------------------------------------------------------
function parseEmpriseMaxRatio(text: string): number | null {
  // On cherche le premier "nombre %" dans le texte
  const regex = /(\d+(?:[.,]\d+)?)\s*%/;
  const match = text.match(regex);
  if (!match) return null;

  const raw = match[1].replace(",", ".");
  const value = Number(raw);
  if (isNaN(value)) return null;

  return value / 100;
}

// -----------------------------------------------------------------------------
// Lecture optionnelle du fichier ascain-uc-articles.json
// (si présent et accessible, sinon on continue sans lui)
// -----------------------------------------------------------------------------
type ArticleRecord = {
  article_id: string;
  article_text?: string;
  [key: string]: unknown;
};

async function loadArticleFromJson(
  articleId: string,
): Promise<ArticleRecord | null> {
  try {
    const url = new URL("./ascain-uc-articles.json", import.meta.url);
    const content = await Deno.readTextFile(url);
    const data = JSON.parse(content);

    if (!Array.isArray(data)) return null;

    const found = data.find((a: ArticleRecord) => a.article_id === articleId);
    return found ?? null;
  } catch (err) {
    console.error("Erreur lecture ascain-uc-articles.json :", err);
    return null;
  }
}

// -----------------------------------------------------------------------------
// Edge function handler
// -----------------------------------------------------------------------------
Deno.serve(async (req: Request): Promise<Response> => {
  // Pré-vol CORS
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse(
      { success: false, error: "Method not allowed" },
      { status: 405 },
    );
  }

  let input: any;
  try {
    input = await req.json();
  } catch (_err) {
    return jsonResponse(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const { article_id, commune_insee } = input;
  const textFromBody: string | undefined =
    input.text ?? input.article_text ?? undefined;

  if (!article_id) {
    return jsonResponse(
      { success: false, error: "Missing field: article_id" },
      { status: 400 },
    );
  }

  // 1) On essaie de charger l’article depuis le JSON (si dispo)
  const articleFromJson = await loadArticleFromJson(article_id);
  const textFromJson: string | undefined = articleFromJson?.article_text;

  // 2) On choisit le texte "brut" à analyser :
  //    priorité au texte envoyé dans la requête, sinon celui du JSON
  const brut: string | undefined = textFromBody ?? textFromJson;

  if (!brut) {
    // Ici SEULEMENT on renvoie une erreur, si on n’a VRAIMENT aucun texte
    return jsonResponse(
      {
        success: false,
        article_id,
        error:
          `Aucun texte trouvé pour l’article ${article_id} (ni dans le body, ni dans ascain-uc-articles.json)`,
      },
      { status: 404 },
    );
  }

  // 3) On applique notre parseur "UC9 style" (emprise max en %)
  const emprise_max_ratio = parseEmpriseMaxRatio(brut);

  const parsed = {
    emprise_max_ratio,
  };

  return jsonResponse({
    success: true,
    article_id,
    commune_insee: commune_insee ?? null,
    parsed,
    brut,
    source: {
      from_body: !!textFromBody,
      from_json: !!textFromJson,
    },
  });
});
