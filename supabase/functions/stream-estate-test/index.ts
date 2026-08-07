import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

serve(async () => {
  try {
    const apiKey = Deno.env.get("STREAM_ESTATE_API_KEY");

    if (!apiKey) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "STREAM_ESTATE_API_KEY missing",
        }),
        { headers: { "Content-Type": "application/json" }, status: 500 },
      );
    }

    const url =
      "https://api.stream.estate/documents/properties?includedZipcodes[]=92210&transactionType=0&itemsPerPage=5";

    const res = await fetch(url, {
      method: "GET",
      headers: {
        "X-API-KEY": apiKey,
        "Content-Type": "application/json",
      },
    });

    const data = await res.json();

    return new Response(
      JSON.stringify(
        {
          ok: res.ok,
          status: res.status,
          data,
        },
        null,
        2,
      ),
      {
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    return new Response(
      JSON.stringify(
        {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        },
        null,
        2,
      ),
      { headers: { "Content-Type": "application/json" }, status: 500 },
    );
  }
});