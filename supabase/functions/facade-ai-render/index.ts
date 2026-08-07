// supabase/functions/facade-ai-render/index.ts

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const FACADE_IMAGE_MODEL = Deno.env.get("FACADE_IMAGE_MODEL") ?? "gpt-image-1.5";

type UiView =
  | "frontale"
  | "3_quarts_legers"
  | "perspective_entree"
  | "angle_rue";

type NormalizedView =
  | "frontale"
  | "three-quarter-light"
  | "entree"
  | "street-angle";

type UiDrawingStyle =
  | "aquarelle"
  | "esquisse_architecte"
  | "photo_realiste";

type NormalizedDrawingStyle =
  | "aquarelle"
  | "architect-sketch"
  | "photo-realiste";

type BuildingStandard =
  | "economique"
  | "standard"
  | "qualitatif"
  | "premium"
  | "luxe";

type Point2D = { x: number; y: number };

type FacadeAiRenderRequest = {
  prompt?: string;

  view?: UiView | NormalizedView;
  drawingStyle?: UiDrawingStyle | NormalizedDrawingStyle;
  buildingStandard?: BuildingStandard;

  floors?: number;
  widthM?: number;
  heightM?: number;
  levelsCount?: number;

  facadeStyleLabel?: string;
  sourceLabel?: string;

  includePeople?: boolean;
  includeGroundFloorShops?: boolean;
  includeWindowFlowerPots?: boolean;

  hasRealFootprint?: boolean;
  footprintPoints?: Point2D[] | null;
  footprintLabel?: string | null;
  massingNotes?: string[] | null;

  footprintWidthM?: number | null;
  footprintDepthM?: number | null;
  footprintAspectRatio?: number | null;
  footprintComplexity?: "simple" | "intermediate" | "complex" | null;
  volumeBreakCount?: number | null;

  pluContext?: {
    zone?: string;
    maxHeightM?: number | null;
    maxFloorsIndicative?: number | null;
    notes?: string[];
  } | null;

  baseImageDataUrl?: string | null;
  maskImageDataUrl?: string | null;

  referenceImageDataUrl?: string | null;
  style?: "promoteur-watercolor" | "architect-sketch" | "brochure-premium";

  size?: "1024x1024" | "1024x1536" | "1536x1024" | "1792x1024" | "auto";
  quality?: "low" | "medium" | "high" | "auto";
  outputFormat?: "png" | "jpeg" | "webp";
  background?: "opaque" | "transparent" | "auto";
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders });
}

function dataUrlToBlob(dataUrl: string): Blob {
  const parts = dataUrl.split(",");
  if (parts.length < 2) throw new Error("Invalid data URL");
  const [meta, base64] = parts;
  const mime = meta.match(/:(.*?);/)?.[1] || "image/png";
  const bin = atob(base64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function normalizeView(view?: FacadeAiRenderRequest["view"]): NormalizedView {
  switch (view) {
    case "3_quarts_legers":    return "three-quarter-light";
    case "perspective_entree": return "entree";
    case "angle_rue":          return "street-angle";
    case "frontale":           return "frontale";
    default:                   return (view as NormalizedView) ?? "frontale";
  }
}

function normalizeDrawingStyle(
  drawingStyle?: FacadeAiRenderRequest["drawingStyle"],
  legacyStyle?: FacadeAiRenderRequest["style"],
): NormalizedDrawingStyle {
  if (drawingStyle === "photo_realiste"    || drawingStyle === "photo-realiste")   return "photo-realiste";
  if (drawingStyle === "esquisse_architecte" || drawingStyle === "architect-sketch") return "architect-sketch";
  if (drawingStyle === "aquarelle")                                                  return "aquarelle";
  if (legacyStyle  === "brochure-premium")                                           return "architect-sketch";
  return "aquarelle";
}

function normalizeFloors(floors?: number, levelsCount?: number): number | null {
  const candidate =
    typeof floors     === "number" && Number.isFinite(floors)     ? floors
    : typeof levelsCount === "number" && Number.isFinite(levelsCount) ? levelsCount
    : null;
  if (candidate === null) return null;
  return Math.max(1, Math.round(candidate));
}

function formatNumber(value?: number): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

// ─── Verrou plan de façade ────────────────────────────────────────────────────
// S'active pour les bâtiments simples/rectangulaires.
// Contra-programme l'inférence de profondeur par le modèle.
function getFacadePlaneLock(body: FacadeAiRenderRequest): string[] {
  const isSimple =
    !body.hasRealFootprint ||
    body.footprintComplexity === "simple" ||
    (typeof body.volumeBreakCount === "number" && body.volumeBreakCount === 0);

  if (!isSimple) return [];

  return [
    "FACADE PLANE LOCK — ABSOLUTE PRIORITY:",
    "The facade is a single continuous flat vertical plane.",
    "There is NO offset, NO recess, NO step, NO protrusion, NO setback anywhere on the facade.",
    "Every wall section, balcony slab, window band, and architectural element sits flush on exactly the same plane.",
    "Do NOT invent any horizontal or vertical shift between parts of the facade.",
    "Do NOT interpret differences in floor height, window size, material, or shadow as a sign of facade depth variation.",
    "Shadows and material changes are surface effects only — they do NOT indicate geometry changes.",
    "The facade reads as one rigid flat plane from edge to edge, top to bottom, with zero depth difference between any two points.",
    "Any facade offset, recess, or step is a critical rendering error.",
  ];
}

// ─── Verrou vue caméra ────────────────────────────────────────────────────────
function getViewPrompt(view: NormalizedView): string {
  switch (view) {
    case "three-quarter-light":
      return [
        "Required view: light three-quarter building view.",
        "Show the full building mass, not only a flat facade elevation.",
        "A side return must be visible.",
        "The real massing and setbacks must remain readable.",
        "Use only a slight perspective.",
        "Do not switch to a frontal elevation.",
        "Do not use a dramatic corner perspective.",
      ].join(" ");

    case "entree":
      return [
        "Required view: entrance-focused building view.",
        "The main entrance must be the focal point.",
        "Keep enough of the building volume visible to understand the overall massing.",
        "Do not crop too tightly on the door alone.",
      ].join(" ");

    case "street-angle":
    return [
      "Required view: street-angle pedestrian building view.",
      "Use an eye-level urban street perspective showing one corner of the building.",
      "The building mass must remain the primary subject.",
      "FLOOR COUNT LOCK: the building must have the EXACT same number of floors as visible in the source image.",
      "Do NOT add any floor, level, or storey that is not present in the source image.",
      "Do NOT increase the building height.",
      "Do NOT interpret the street-angle perspective as permission to add volume or height.",
      "The corner view must reveal depth — but the height and floor count are strictly frozen.",
      "Side returns and volumetric setbacks must remain legible.",
      "Do not switch to a frontal elevation.",
      ].join(" ");

    case "frontale":
    default:
      return [
        "CAMERA LOCK — ABSOLUTE PRIORITY: strictly frontal facade view.",
        "The camera faces the facade head-on.",
        "The horizontal axis of the camera is perfectly parallel to the facade plane.",
        "Zero perspective rotation — the facade must appear as a flat orthographic elevation.",
        "Both vertical edges of the building must be perfectly parallel and equidistant from the image center.",
        "No side face of the building must be visible.",
        "No corner must be visible.",
        "The vanishing point is at infinity — no converging lines.",
        "Do NOT use a three-quarter angle.",
        "Do NOT rotate the camera.",
        "Do NOT show the building from a corner.",
        "Any lateral rotation of the camera is a critical error.",
      ].join(" ");
  }
}

function getBuildingStandardPrompt(standard?: BuildingStandard): string {
  switch (standard) {
    case "economique": return "Target standard: economical residential development, simple and credible.";
    case "qualitatif": return "Target standard: high-quality residential development, refined but restrained.";
    case "premium":    return "Target standard: premium residential development, elegant and marketable.";
    case "luxe":       return "Target standard: luxury residential development, very refined but still credible.";
    default:           return "Target standard: standard residential development, balanced and realistic.";
  }
}

function getStagingPrompt(body: FacadeAiRenderRequest): string[] {
  const bits: string[] = [];

  if (body.includePeople) {
    bits.push(
      "Add a few believable pedestrians.",
      "They must remain secondary to the architecture.",
      "Do not overcrowd the scene.",
      "Use discreet scale figures consistent with a residential promoter presentation.",
    );
  }

  if (body.includeGroundFloorShops) {
    bits.push(
      "Make the ground floor read as active commercial frontage.",
      "Include elegant shop windows or retail glazing at ground floor level.",
      "Keep signage discreet, upscale, and architecturally integrated.",
      "Do not turn the project into a shopping mall.",
    );
  }

  if (body.includeWindowFlowerPots) {
    bits.push(
      "Add tasteful flower pots or window planters near selected windows.",
      "Keep them subtle, elegant, and coherent with the facade rhythm.",
      "Do not overdecorate the building.",
    );
  }

  return bits;
}

function getMassingPrompt(body: FacadeAiRenderRequest): string[] {
  const bits: string[] = [];

  if (body.hasRealFootprint) {
    bits.push(
      "The building footprint is non-trivial and must be respected exactly.",
      "Preserve the real massing implied by the footprint.",
      "Preserve all facade setbacks, recesses, cut-outs, offsets, and stepped volumes.",
      "Do not simplify the building into a rectangular slab.",
      "Do not flatten the side returns.",
      "Do not regularize the silhouette.",
    );
  } else {
    bits.push(
      "The building footprint is strictly rectangular and simple.",
      "The massing must remain a clean single rectangular volume with no exceptions.",
      "Do not add any volumetric complexity, offset, recess, or stepped element.",
      "Do not invent depth, wings, or secondary volumes.",
    );
  }

  if (body.footprintLabel) {
    bits.push(`Footprint summary: ${body.footprintLabel}.`);
  }

  if (body.footprintPoints && body.footprintPoints.length >= 3) {
    bits.push(
      `Footprint control points are provided and must guide the massing: ${JSON.stringify(body.footprintPoints)}.`,
      "Use these points as massing guidance, not as decorative annotation.",
    );
  }

  if (body.massingNotes?.length) {
    bits.push(`Massing notes: ${body.massingNotes.join(" ")}`);
  }

  if (body.hasRealFootprint) {
    bits.push(
      "This building has a complex real footprint.",
      "The footprint complexity MUST be visible in the final image.",
      "Any simplification of geometry is a critical error.",
    );
  }

  return bits;
}

function getExplicitGeometryPrompt(body: FacadeAiRenderRequest): string[] {
  const bits: string[] = [];

  if (typeof body.footprintWidthM === "number" && Number.isFinite(body.footprintWidthM)) {
    bits.push(`Approximate building footprint width: ${body.footprintWidthM} m.`);
  }
  if (typeof body.footprintDepthM === "number" && Number.isFinite(body.footprintDepthM)) {
    bits.push(`Approximate building footprint depth: ${body.footprintDepthM} m.`);
  }
  if (typeof body.footprintAspectRatio === "number" && Number.isFinite(body.footprintAspectRatio)) {
    bits.push(`Footprint width/depth ratio: ${body.footprintAspectRatio}.`);
  }
  if (body.footprintComplexity) {
    bits.push(`Footprint complexity level: ${body.footprintComplexity}.`);
  }
  if (typeof body.volumeBreakCount === "number" && Number.isFinite(body.volumeBreakCount)) {
    bits.push(`Number of significant volume breaks or recess offsets: ${body.volumeBreakCount}.`);
  }

  if (body.hasRealFootprint) {
    bits.push(
      "CRITICAL GEOMETRY CONSTRAINTS:",
      "The building footprint is NOT rectangular and must remain non-rectangular.",
      "You MUST preserve the exact building massing from the input.",
      "All recesses, offsets, wings, and depth variations are mandatory.",
      "Do NOT align volumes into a single flat facade.",
      "Do NOT simplify the building into a box or slab.",
      "Do NOT remove side returns or secondary volumes.",
      "Each visible volume break must be preserved.",
      "The building depth must be visible and consistent with the massing.",
      "The geometry and massing are MORE IMPORTANT than style.",
      "If there is any conflict between style and geometry, ALWAYS keep geometry.",
      "Important: this is a volumetric fidelity task, not a style reinterpretation.",
      "The building must remain identical in shape to the input reference.",
    );
  }

  return bits;
}

function getPluBits(body: FacadeAiRenderRequest): string[] {
  const bits: string[] = [];
  if (body.pluContext?.zone) {
    bits.push(`PLU zone: ${body.pluContext.zone}.`);
  }
  if (typeof body.pluContext?.maxHeightM === "number" && Number.isFinite(body.pluContext.maxHeightM)) {
    bits.push(`Indicative PLU max height: ${body.pluContext.maxHeightM} m.`);
  }
  if (typeof body.pluContext?.maxFloorsIndicative === "number" && Number.isFinite(body.pluContext.maxFloorsIndicative)) {
    bits.push(`Indicative PLU floors: ${Math.max(1, Math.round(body.pluContext.maxFloorsIndicative))}.`);
  }
  if (body.pluContext?.notes?.length) {
    bits.push(`Planning notes: ${body.pluContext.notes.join(" ")}`);
  }
  return bits;
}

function getStyleBits(style: NormalizedDrawingStyle): string[] {
  if (style === "photo-realiste") {
    return [
      "Render style: photorealistic architectural visualization.",
      "Use highly realistic materials, natural lighting, accurate reflections, precise shadows, and credible real-estate marketing quality.",
      "The result must feel like a premium real estate promotional image.",
      "Keep the architecture faithful, elegant, and believable.",
      "Do not render as watercolor.",
      "Do not use paper texture, pigment bleeding, sketch lines, or illustrated effects.",
      "Do not stylize the image as an architectural brochure illustration.",
    ];
  }

  if (style === "architect-sketch") {
    return [
      "Render style: ARCHITECTURAL CONCEPT SKETCH on technical paper. This is the most important instruction.",
      "The image MUST look like an architect's hand-drawn concept sketch on white or light grid paper.",
      "DOMINANT ELEMENT: bold black pencil and ink linework — thick confident strokes for building edges and contours, thinner precise lines for windows, details, and textures.",
      "MANDATORY: visible construction lines, perspective vanishing lines, dimension guides, and technical overlay marks extending beyond the building edges.",
      "Use hatching and cross-hatching for shadows and material differentiation.",
      "Apply selective watercolor-style color washes ONLY as transparent tints over the linework — teal/cyan for glass and water, warm ochre for stone, grey for concrete.",
      "The color washes must be clearly SECONDARY to the black linework — at least 70% line, 30% color.",
      "The overall composition must feel like a page from an architect's sketchbook or competition presentation board.",
      "Include subtle graph paper or technical paper texture in the background.",
      "Preserve the real building volumes, setbacks, recesses, and side returns.",
      "Keep the geometry readable and the massing faithful.",
      "Do NOT render as a finished watercolor painting — the lines must dominate, not the washes.",
      "Do NOT render as a polished digital illustration or photorealistic image.",
      "Do NOT render as a clean marketing brochure visualization.",
      "Do NOT use smooth gradients or soft atmospheric effects as the primary technique.",
      "Do NOT produce a clean finished rendering — the result must feel hand-drawn, technical, and sketchy.",
    ];
  }

  return [
    "Render style: architectural watercolor illustration.",
    "Use refined watercolor washes, subtle linework, soft paper texture, and elegant presentation quality.",
    "Keep the result soft but still precise and readable.",
  ];
}

function getEditPrompt(body: FacadeAiRenderRequest): string {
  const style  = normalizeDrawingStyle(body.drawingStyle, body.style);
  const view   = normalizeView(body.view);
  const floors = normalizeFloors(body.floors, body.levelsCount);
  const widthM = formatNumber(body.widthM);
  const heightM = formatNumber(body.heightM);

  return [
    "Transform this input building preview into a polished architectural image.",
    "The input image is a strict 2D orthographic plan — treat it as the authoritative geometry reference.",
    "Preserve the building identity from the input image.",
    "Preserve the overall facade composition and architectural language from the input image.",
    "Preserve the visible floor count and the overall proportions from the input image.",
    "This is not only a facade restyling task: it is a full-building massing-preservation task.",
    "Render the whole building volume faithfully.",
    ...getFacadePlaneLock(body),
    getViewPrompt(view),
    view === "frontale"
      ? "The final image must show ONLY the flat front facade — no side walls, no corners, no perspective angle."
      : "",
    floors
      ? `Preserve EXACTLY the current floor count visible in the input image. The building must keep exactly ${floors} visible floors.`
      : "Preserve the exact visible floor count from the input image.",
    widthM && heightM
      ? `Keep the overall proportions consistent with approximately ${widthM} m facade width and ${heightM} m facade height.`
      : "Keep the overall building proportions unchanged.",
    body.facadeStyleLabel
      ? `Respect the facade intent and architectural language: ${body.facadeStyleLabel}.`
      : "Respect the facade intent shown in the input image.",
    getBuildingStandardPrompt(body.buildingStandard),
    ...getMassingPrompt(body),
    ...getExplicitGeometryPrompt(body),
    "Do not add or remove floors.",
    "Do not convert the building into a simple box.",
    "Do not erase recesses, offsets, wings, side returns, or volumetric steps.",
    "Do not redesign the massing.",
    "Do not reinterpret the building as a flat rectangular frontage.",
    "Keep the camera family consistent with the source image.",
    "Do not crop the building more tightly than the source image.",
    ...getStagingPrompt(body),
    ...getStyleBits(style),
    ...getPluBits(body),
    body.prompt?.trim() || "",
  ]
    .filter(Boolean)
    .join(" ");
}

function buildFinalPrompt(body: FacadeAiRenderRequest, userPrompt: string): string {
  const style  = normalizeDrawingStyle(body.drawingStyle, body.style);
  const view   = normalizeView(body.view);
  const floors = normalizeFloors(body.floors, body.levelsCount);
  const widthM = formatNumber(body.widthM);
  const heightM = formatNumber(body.heightM);

  return [
    "Generate a credible residential building image for a real-estate promoter presentation.",
    "This is a full-building architectural image, not a flat facade diagram.",
    "Priority order: 1) camera view lock, 2) real massing and footprint fidelity, 3) floor count, 4) requested render style, 5) architectural details, 6) atmosphere.",
    ...getFacadePlaneLock(body),
    getViewPrompt(view),
    view === "frontale"
      ? "The final image must show ONLY the flat front facade — no side walls, no corners, no perspective angle."
      : "",
    floors
      ? `The building must have exactly ${floors} visible floors. Do not generate fewer or more floors.`
      : "Use a coherent visible floor count based on the architectural description.",
    ...getStyleBits(style),
    body.facadeStyleLabel
      ? `Architectural language: ${body.facadeStyleLabel}.`
      : "Use a coherent residential facade language.",
    body.buildingStandard ? getBuildingStandardPrompt(body.buildingStandard) : "",
    widthM && heightM
      ? `Target proportions are approximately ${widthM} m facade width and ${heightM} m facade height.`
      : "",
    ...getMassingPrompt(body),
    ...getExplicitGeometryPrompt(body),
    ...getStagingPrompt(body),
    ...getPluBits(body),
    "Keep the building clear, marketable, and credible.",
    "Do not produce a technical massing diagram, surreal architecture, fantasy building, or exaggerated composition.",
    userPrompt,
  ]
    .filter(Boolean)
    .join(" ");
}

function getMimeType(outputFormat: FacadeAiRenderRequest["outputFormat"]): string {
  switch (outputFormat) {
    case "jpeg": return "image/jpeg";
    case "webp": return "image/webp";
    default:     return "image/png";
  }
}

function buildMeta(
  body: FacadeAiRenderRequest,
  userId: string,
  size: string,
  quality: string,
  outputFormat: string,
  background: string,
) {
  return {
    model: FACADE_IMAGE_MODEL,
    view: normalizeView(body.view),
    drawingStyle: normalizeDrawingStyle(body.drawingStyle, body.style),
    floors: normalizeFloors(body.floors, body.levelsCount),
    includePeople: !!body.includePeople,
    includeGroundFloorShops: !!body.includeGroundFloorShops,
    includeWindowFlowerPots: !!body.includeWindowFlowerPots,
    hasRealFootprint: !!body.hasRealFootprint,
    footprintComplexity: body.footprintComplexity ?? null,
    volumeBreakCount: body.volumeBreakCount ?? null,
    facadePlaneLockActive: getFacadePlaneLock(body).length > 0,
    cameraLockView: normalizeView(body.view),
    footprintPointsCount: body.footprintPoints?.length ?? 0,
    size,
    quality,
    outputFormat,
    background,
    userId,
  };
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const SUPABASE_URL    = Deno.env.get("SUPABASE_URL");
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
    const OPENAI_API_KEY  = Deno.env.get("OPENAI_API_KEY");

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return json({ error: "Missing Supabase config" }, 500);
    if (!OPENAI_API_KEY)                      return json({ error: "Missing OpenAI key" }, 500);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return json({ error: "Unauthorized" }, 401);

    const body = (await req.json()) as FacadeAiRenderRequest;

    const prompt = body.prompt?.trim();
    if (!prompt) return json({ error: "prompt is required" }, 400);

    const size         = body.size         ?? "1536x1024";
    const quality      = body.quality      ?? "high";
    const outputFormat = body.outputFormat ?? "png";
    const background   = body.background   ?? "opaque";

    if (background === "transparent" && outputFormat === "jpeg") {
      return json({ error: "transparent background requires png or webp outputFormat" }, 400);
    }

    const normalizedBaseImage = body.baseImageDataUrl ?? body.referenceImageDataUrl ?? null;

    // ── Mode edit ────────────────────────────────────────────────────────────
    if (normalizedBaseImage) {
      const imageBlob  = dataUrlToBlob(normalizedBaseImage);
      const editPrompt = getEditPrompt(body);

      const form = new FormData();
      form.append("model",         FACADE_IMAGE_MODEL);
      form.append("prompt",        editPrompt);
      form.append("image",         imageBlob, "input.png");
      form.append("size",          size);
      form.append("quality",       quality);
      form.append("output_format", outputFormat);

      if (body.maskImageDataUrl) {
        const maskBlob = dataUrlToBlob(body.maskImageDataUrl);
        form.append("mask", maskBlob, "mask.png");
      }

      const res = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: form,
      });

      const raw = await res.text();
      if (!res.ok) {
        return json({ error: "Edit failed", details: raw, promptUsed: editPrompt }, 500);
      }

      const data  = JSON.parse(raw) as { data?: Array<{ b64_json?: string; revised_prompt?: string }> };
      const first = data.data?.[0];
      const b64   = first?.b64_json;

      if (!b64) {
        return json({ error: "Edit response missing image data", details: data, promptUsed: editPrompt }, 500);
      }

      return json({
        ok: true,
        imageUrl:   `data:${getMimeType(outputFormat)};base64,${b64}`,
        promptUsed: first?.revised_prompt ?? editPrompt,
        mode: "edit",
        meta: buildMeta(body, user.id, size, quality, outputFormat, background),
      });
    }

    // ── Mode generation ──────────────────────────────────────────────────────
    const finalPrompt = buildFinalPrompt(body, prompt);

    const openaiRes = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model:         FACADE_IMAGE_MODEL,
        prompt:        finalPrompt,
        size,
        quality,
        output_format: outputFormat,
        background,
        user:          user.id,
      }),
    });

    const rawText = await openaiRes.text();
    if (!openaiRes.ok) {
      return json({ error: "Generation failed", details: rawText, promptUsed: finalPrompt }, 500);
    }

    const openaiJson = JSON.parse(rawText) as { data?: Array<{ b64_json?: string; revised_prompt?: string }> };
    const first      = openaiJson.data?.[0];
    const b64        = first?.b64_json;

    if (!b64) {
      return json({ error: "Generation response missing image data", details: openaiJson, promptUsed: finalPrompt }, 500);
    }

    return json({
      ok: true,
      imageUrl:   `data:${getMimeType(outputFormat)};base64,${b64}`,
      promptUsed: first?.revised_prompt ?? finalPrompt,
      mode: "generation",
      meta: buildMeta(body, user.id, size, quality, outputFormat, background),
    });

  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});