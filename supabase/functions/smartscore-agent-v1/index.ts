// supabase/functions/smartscore-agent-v1/index.ts
import { corsHeaders } from "../_shared/cors.ts";

console.log("✅ smartscore-agent-v1 – function loaded");

async function handlePost(req: Request): Promise<Response> {
  try {
    const body = await req.json().catch(() => null);
    console.log("📥 smartscore-agent-v1 – body reçu:", body);

    const mode =
      body && typeof body.mode === "string" ? body.mode : "standard";

    // ✅ Stub SmartScore + rapport complet
    const result = {
      success: true,
      globalScore: 73,
      pillarScores: {
        emplacement_env: 85,
        marche_liquidite: 70,
        qualite_bien: 75,
        rentabilite_prix: 60,
        risques_complexite: 40, // on met un score pour éviter le 0/100 vide
      },
      usedCriteriaCount: 15,
      activePillars: [
        "emplacement_env",
        "marche_liquidite",
        "qualite_bien",
        "rentabilite_prix",
        "risques_complexite",
      ],
      mode,
      messages: [
        "SmartScore calculé via smartscore-agent-v1 (version stub).",
      ],
      report: {
        executiveSummary:
          "Le bien présente un bon équilibre entre emplacement, qualité intrinsèque et potentiel de valorisation. Le SmartScore global de 73/100 indique une opportunité intéressante, sous réserve d’une vérification plus fine des risques et de la liquidité du marché local.",
        pillarDetails: {
          emplacement_env:
            "L’emplacement obtient 85/100, ce qui traduit une bonne attractivité du quartier : transports disponibles, services de proximité et cadre de vie globalement favorable.",
          marche_liquidite:
            "Avec 70/100, le marché est jugé relativement liquide : le bien devrait pouvoir se revendre dans des délais raisonnables, sans décote excessive, si le prix reste cohérent avec le marché.",
          qualite_bien:
            "La qualité du bien (75/100) reflète un état général correct à bon, avec un agencement exploitable et un potentiel de valorisation à moyen terme (travaux d’optimisation, modernisation, etc.).",
          rentabilite_prix:
            "Le score de 60/100 en rentabilité & prix indique une rentabilité correcte mais pas exceptionnelle : il faudra optimiser le financement, la fiscalité et éventuellement le loyer cible pour améliorer le cashflow.",
          risques_complexite:
            "Les risques et complexités sont modérés (40/100) : il peut s’agir de points d’attention techniques, juridiques ou liés à la copropriété qui devront être vérifiés avant décision d’achat.",
        },
        recommendations:
          "Avant de se positionner, il est recommandé de : (1) vérifier la cohérence du prix avec les dernières ventes DVF et annonces comparables, (2) analyser le règlement de copropriété et les éventuels travaux votés, (3) simuler plusieurs scénarios de financement et de loyer, (4) valider les risques spécifiques identifiés (techniques, juridiques, environnementaux).",
        forecast: {
          horizon: "3 à 5 ans",
          appreciationScenario:
            "Dans un scénario de marché neutre à légèrement porteur, le bien pourrait bénéficier d’une appréciation de 5 à 10 % sur 3 à 5 ans, à condition que les travaux de valorisation soient réalisés et que le positionnement prix/location reste cohérent.",
          cashflowScenario:
            "En optimisant le financement (apport, durée, taux) et la stratégie locative, le cashflow peut être rapproché de l’équilibre, voire légèrement positif dans un contexte de taux maîtrisés et de bonne demande locative.",
        },
      },
      debug: {
        receivedBody: body,
      },
    };

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders,
      },
    });
  } catch (err) {
    console.error("❌ smartscore-agent-v1 – erreur:", err);

    return new Response(
      JSON.stringify({
        success: false,
        error:
          err instanceof Error
            ? err.message
            : "Erreur interne smartscore-agent-v1",
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      },
    );
  }
}

Deno.serve((req: Request) => {
  const { method } = req;
  console.log(`➡️ smartscore-agent-v1 – requête ${method}`);

  // Preflight CORS
  if (method === "OPTIONS") {
    console.log("ℹ️ smartscore-agent-v1 – preflight OPTIONS");
    return new Response("ok", {
      status: 200,
      headers: {
        ...corsHeaders,
      },
    });
  }

  if (method === "POST") {
    return handlePost(req);
  }

  return new Response(
    JSON.stringify({ error: "Method not allowed" }),
    {
      status: 405,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders,
      },
    },
  );
});
