import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

async function fetchPortalSearch(url: string) {
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0",
    },
  });

  if (!res.ok) return [];

  const text = await res.text();

  // extraction minimaliste prix/surface/url
  const results: any[] = [];

  // parsing simple (ex: regex ou JSON embedded)
  // ici simplifié
  const matches = text.match(/"price":[0-9]+/g);

  if (matches) {
    matches.forEach((m) => {
      results.push({
        price: Number(m.replace('"price":', "")),
      });
    });
  }

  return results;
}

serve(async () => {
  const zones = [
    { city: "Saint-Cloud", zip: "92210" },
  ];

  const portals = [
    "leboncoin",
    "seloger",
    "bienici",
    "figaro",
    "pap",
    "logic-immo",
  ];

  const data: any[] = [];

  for (const zone of zones) {
    for (const portal of portals) {
      const url = `https://example.com/search?city=${zone.city}`;

      const listings = await fetchPortalSearch(url);

      listings.forEach((l) => {
        data.push({
          portal,
          city: zone.city,
          zip_code: zone.zip,
          price: l.price,
        });
      });
    }
  }

  return new Response(JSON.stringify({ scanned: data.length }));
});