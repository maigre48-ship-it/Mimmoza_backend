// supabase/functions/promoteur-synthese-v1/composer.ts
import type { SyntheseContext } from "./types.ts";

export function buildWarnings(ctx: SyntheseContext): string[] {
  const warnings: string[] = [];

  if (!ctx.project?.parcel_ids?.length && !ctx.project?.address) {
    warnings.push("Aucune parcelle/adresse fournie : la synthèse est générée avec un contexte incomplet.");
  }
  if (!ctx.market) warnings.push("Étude de marché absente : la synthèse ne peut pas conclure finement sur les prix/tension.");
  if (!ctx.risks) warnings.push("Étude de risques absente : les contraintes techniques/assurantielles peuvent être sous-estimées.");
  if (!ctx.plu) warnings.push("Données PLU/faisabilité absentes : la partie réglementaire est indicative.");
  if (!ctx.implantation) warnings.push("Implantation absente : la synthèse ne contient pas d’hypothèse de plan masse.");
  return warnings;
}

export function buildTitle(ctx: SyntheseContext): string {
  const commune = ctx.project?.commune ?? ctx.project?.commune_insee ?? "Commune";
  const parcel = ctx.project?.parcel_ids?.[0];
  if (parcel) return `Synthèse Promoteur — ${commune} — ${parcel}`;
  return `Synthèse Promoteur — ${commune}`;
}

/**
 * On envoie à Claude un JSON propre, resserré, sans bruit.
 * Claude doit rédiger, pas "recalculer".
 */
export function buildClaudeUserPayload(ctx: SyntheseContext) {
  return {
    project: ctx.project ?? {},
    plu: ctx.plu ?? {},
    implantation: ctx.implantation ?? {},
    market: ctx.market ?? {},
    risks: ctx.risks ?? {},
    terrain3d: ctx.terrain3d ?? {},
  };
}
