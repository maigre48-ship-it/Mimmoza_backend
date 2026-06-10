// src/spaces/promoteur/bilan/services/snapshotNormalize.service.ts
import type { Snapshot } from "../types/aiSynthese.types";

export type NormalizedProject = {
  title: string;
  addressLine: string;      // "12 rue X, 75000 Paris"
  parcelLabel: string;      // "Parcelle : 123AB0456" (ou "—")
  projectTypeLabel: string; // "Logement", "EHPAD", ...
};

function clean(s?: string | null) {
  return (s || "").trim();
}

function guessProjectTypeLabel(raw?: any): string {
  const v = String(raw || "").toUpperCase();
  if (!v) return "—";
  if (v.includes("EHPAD") || v.includes("SENIOR")) return "EHPAD / Résidence seniors";
  if (v.includes("ETUD")) return "Résidence étudiante";
  if (v.includes("HOTEL")) return "Hôtel";
  if (v.includes("BUREAU") || v.includes("OFFICE")) return "Bureaux";
  if (v.includes("COMMERCE") || v.includes("RETAIL")) return "Commerces";
  if (v.includes("LOGE") || v.includes("HOUS")) return "Logement";
  return raw?.label || raw?.name || String(raw);
}

export function normalizeProject(snapshot: Snapshot | null): NormalizedProject {
  const p: any = snapshot?.project || {};

  const name = clean(p.name);
  const address = clean(p.address);
  const city = clean(p.city);
  const zip = clean(p.zipCode || p.zip || p.postcode);

  const addressLine =
    [address, [zip, city].filter(Boolean).join(" ")].filter(Boolean).join(", ") || "—";

  const parcelId = clean(p.parcelId || p.parcelle || p.parcel || p.cadastre_id);
  const parcelLabel = parcelId ? `Parcelle : ${parcelId}` : "Parcelle : —";

  const projectTypeLabel = guessProjectTypeLabel(p.projectType || p.nature || snapshot?.project?.type);

  const title =
    name ||
    (addressLine !== "—" ? addressLine : "Projet promoteur");

  return { title, addressLine, parcelLabel, projectTypeLabel };
}
