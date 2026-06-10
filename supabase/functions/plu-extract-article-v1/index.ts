// supabase/functions/plu-extract-article-v1/index.ts
// Version : v1.2 — security hardening, no raw article leak in responses/logs

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
// Parser local : emprise max en ratio
// -----------------------------------------------------------------------------
function parseEmpriseMaxRatio(text: string): number | null {
  const regex = /(\d+(?:[.,]\d+)?)\s*%/;
  const match = text.match(regex);

  if (!match) return null;

  const raw = match[1].replace(",", ".");
  const value = Number(raw);

  if (isNaN(value) || value < 0 || value > 100) return null;

  return value / 100;
}

// -----------------------------------------------------------------------------
// Lecture optionnelle du fichier ascain-uc-articles.json
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
  } catch (_e) {
    console.error("[plu-extract-article-v1] local article load failed");
    return null;
  }
}

// -----------------------------------------------------------------------------
// Edge function handler
// -----------------------------------------------------------------------------
Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse(
      {
        success: false,
        error: "METHOD_NOT_ALLOWED",
      },
      { status: 405 },
    );
  }

  let input: Record<string, unknown>;

  try {
    input = (await req.json()) as Record<string, unknown>;
  } catch (_e) {
    return jsonResponse(
      {
        success: false,
        error: "INVALID_JSON_BODY",
      },
      { status: 400 },
    );
  }

  const articleIdRaw = input.article_id;
  const communeInseeRaw = input.commune_insee;

  const article_id =
    typeof articleIdRaw === "string" ? articleIdRaw.trim() : "";

  const commune_insee =
    typeof communeInseeRaw === "string" ? communeInseeRaw.trim() : null;

  const textRaw = input.text ?? input.article_text;
  const textFromBody =
    typeof textRaw === "string" && textRaw.trim().length > 0
      ? textRaw
      : undefined;

  if (!article_id) {
    return jsonResponse(
      {
        success: false,
        error: "INVALID_INPUT",
      },
      { status: 400 },
    );
  }

  const articleFromJson = await loadArticleFromJson(article_id);

  const textFromJson =
    typeof articleFromJson?.article_text === "string" &&
    articleFromJson.article_text.trim().length > 0
      ? articleFromJson.article_text
      : undefined;

  const brut = textFromBody ?? textFromJson;

  if (!brut) {
    return jsonResponse(
      {
        success: false,
        error: "ARTICLE_TEXT_NOT_FOUND",
      },
      { status: 404 },
    );
  }

  const emprise_max_ratio = parseEmpriseMaxRatio(brut);

  return jsonResponse(
    {
      success: true,
      article_id,
      commune_insee,
      parsed: {
        emprise_max_ratio,
      },
      source: {
        from_body: Boolean(textFromBody),
        from_json: Boolean(textFromJson),
      },
    },
    { status: 200 },
  );
});