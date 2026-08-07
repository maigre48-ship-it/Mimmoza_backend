import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

function toHtml(message: string): string {
  return message
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br />");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
  }

  try {
    if (!RESEND_API_KEY) {
      throw new Error("RESEND_API_KEY manquante.");
    }

    const { emails } = await req.json();

    if (!Array.isArray(emails) || emails.length === 0) {
      throw new Error("Aucun email à envoyer.");
    }

    if (emails.length > 50) {
      throw new Error("Maximum 50 emails par envoi.");
    }

    const results = [];

    for (const e of emails) {
      if (!e.to || !e.subject || !e.message || !e.replyTo) {
        throw new Error("Payload email incomplet.");
      }

      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "Mimmoza <notifications@mimmoza.com>",
          to: [e.to],
          subject: e.subject,
          html: toHtml(e.message),
          reply_to: e.replyTo,
        }),
      });

      const data = await resp.json();

      if (!resp.ok) {
        console.error("[MIMMOZA][SEND_MAIL_ERROR]", data);
        throw new Error(data?.message ?? "Erreur Resend.");
      }

      results.push({
        to: e.to,
        status: "sent",
        providerId: data?.id ?? null,
      });
    }

    return new Response(JSON.stringify({ success: true, results }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Erreur inconnue.";

    return new Response(JSON.stringify({ success: false, error: msg }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }
});