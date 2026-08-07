export const corsHeaders: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

export function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      ...corsHeaders,
      "content-type": "application/json; charset=utf-8",
    },
  });
}

export function badRequest(message: string) {
  return json({ success: false, error: message, message: null }, 400);
}

export function serverError(message: string) {
  return json({ success: false, error: message, message: null }, 500);
}

export function methodNotAllowed() {
  return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
}
