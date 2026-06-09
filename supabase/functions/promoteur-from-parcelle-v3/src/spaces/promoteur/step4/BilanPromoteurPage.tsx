// src/spaces/promoteur/bilan-promoteur/BilanPromoteurPage.tsx
// Pro forma v2 — avec surface vendable, lecture promoteur, sensibilité

import React, { useMemo, useState } from "react";
import * as turf from "@turf/turf";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { usePromoteurProjectStore } from "../store/promoteurProject.store";

// -------------------------------
// Helpers
// -------------------------------
function n(v: unknown, fallback = 0): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}
function pct(v: unknown, fallback = 0): number {
  const x = n(v, fallback);
  if (x < 0) return 0;
  if (x > 100) return 100;
  return x;
}
function eur(v: number): string {
  try {
    return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(v);
  } catch {
    return `${Math.round(v)} €`;
  }
}
function m2(v: number): string {
  return `${Math.round(v)} m²`;
}
function safeAreaM2(feat: Feature<Geometry> | null | undefined): number {
  if (!feat?.geometry) return 0;
  try {
    return turf.area(feat as turf.AllGeoJSON);
  } catch {
    return 0;
  }
}
function sumAreas(fc?: FeatureCollection<Geometry> | null): number {
  if (!fc?.features || !Array.isArray(fc.features)) return 0;
  return fc.features.reduce((acc, f) => acc + safeAreaM2(f as Feature<Geometry>), 0);
}

// -------------------------------
// Types
// -------------------------------
type BuildingKind = "INDIVIDUEL" | "COLLECTIF";

type FloorsSpec = {
  aboveGroundFloors: number;
  groundFloorHeightM: number;
  typicalFloorHeightM: number;
};

type Assumptions = {
  // Revenus
  salePriceEurM2Hab: number;
  commercialisationPct: number;
  coefVendable: number;

  // Foncier
  landPriceEur: number;
  notaryFeesPct: number;
  acquisitionTaxesPct: number;

  // Travaux
  worksCostEurM2Sdp: number;
  vrdPct: number;
  extPct: number;
  contingencyPct: number;

  // Études & montage
  surveyorEur: number;
  geotechEur: number;
  moePct: number;
  betPct: number;
  spsCtOpcEur: number;
  insuranceDoPct: number;
  miscEur: number;

  // Commercialisation
  marketingPctCa: number;
  marketingFixedEur: number;

  // Financement
  financingRatePct: number;
  financingFeesEur: number;

  // Taxes
  taxeAmenagementEurM2Sdp: number;
};

type Line = {
  section: string;
  label: string;
  valueEur: number;
  kind?: "subtotal" | "total";
  hint?: string;
};

// -------------------------------
// Coefficients
// -------------------------------
const COEF_SDP = 1.0;
const COEF_HABITABLE_COLLECTIF = 0.82;
const COEF_HABITABLE_INDIVIDUEL = 0.90;

// -------------------------------
// Default assumptions
// -------------------------------
const DEFAULT_ASSUMPTIONS: Assumptions = {
  salePriceEurM2Hab: 5200,
  commercialisationPct: 100,
  coefVendable: 1.0,

  landPriceEur: 0,
  notaryFeesPct: 7.5,
  acquisitionTaxesPct: 0,

  worksCostEurM2Sdp: 1800,
  vrdPct: 6,
  extPct: 3,
  contingencyPct: 3,

  surveyorEur: 6000,
  geotechEur: 12000,
  moePct: 10,
  betPct: 3,
  spsCtOpcEur: 15000,
  insuranceDoPct: 2,
  miscEur: 8000,

  marketingPctCa: 2,
  marketingFixedEur: 0,

  financingRatePct: 4,
  financingFeesEur: 8000,

  taxeAmenagementEurM2Sdp: 80,
};

// -------------------------------
// Pro forma calculation function (reusable for sensitivity)
// -------------------------------
function computeProForma(
  ass: Assumptions,
  sdpEstimatedM2: number,
  surfaceVendableM2: number
) {
  // ========== RECETTES ==========
  const caLogements = surfaceVendableM2 * n(ass.salePriceEurM2Hab, 0) * (pct(ass.commercialisationPct, 100) / 100);
  const caTotal = caLogements;

  // ========== A) FONCIER ==========
  const foncier = n(ass.landPriceEur, 0);
  const fraisNotaire = foncier * (pct(ass.notaryFeesPct, 7.5) / 100);
  const taxesAcq = foncier * (pct(ass.acquisitionTaxesPct, 0) / 100);
  const totalFoncier = foncier + fraisNotaire + taxesAcq;

  // ========== B) ÉTUDES & MONTAGE ==========
  const travauxBase = sdpEstimatedM2 * n(ass.worksCostEurM2Sdp, 0);

  const surveyor = n(ass.surveyorEur, 0);
  const geotech = n(ass.geotechEur, 0);
  const moe = travauxBase * (pct(ass.moePct, 10) / 100);
  const bet = travauxBase * (pct(ass.betPct, 3) / 100);
  const spsCtOpc = n(ass.spsCtOpcEur, 0);
  const insuranceDo = travauxBase * (pct(ass.insuranceDoPct, 2) / 100);
  const misc = n(ass.miscEur, 0);
  const totalEtudes = surveyor + geotech + moe + bet + spsCtOpc + insuranceDo + misc;

  // ========== C) TRAVAUX ==========
  const vrd = travauxBase * (pct(ass.vrdPct, 6) / 100);
  const ext = travauxBase * (pct(ass.extPct, 3) / 100);
  const aleas = travauxBase * (pct(ass.contingencyPct, 3) / 100);
  const totalTravaux = travauxBase + vrd + ext + aleas;

  // ========== D) TAXES ==========
  const taxeAmenagement = sdpEstimatedM2 * n(ass.taxeAmenagementEurM2Sdp, 0);
  const totalTaxes = taxeAmenagement;

  // ========== E) COMMERCIALISATION ==========
  const marketingPct = caTotal * (pct(ass.marketingPctCa, 2) / 100);
  const marketingFixed = n(ass.marketingFixedEur, 0);
  const totalCom = marketingPct + marketingFixed;

  // ========== F) FINANCEMENT ==========
  const baseFin = totalFoncier + 0.5 * totalTravaux;
  const intercalaires = baseFin * (pct(ass.financingRatePct, 4) / 100);
  const fraisFin = n(ass.financingFeesEur, 0);
  const totalFin = intercalaires + fraisFin;

  // ========== TOTAUX ==========
  const coutTotal = totalFoncier + totalEtudes + totalTravaux + totalTaxes + totalCom + totalFin;
  const marge = caTotal - coutTotal;
  const margePct = caTotal > 0 ? (marge / caTotal) * 100 : 0;

  const coutRevientEurM2Hab = surfaceVendableM2 > 0 ? coutTotal / surfaceVendableM2 : 0;
  const coutRevientEurM2Sdp = sdpEstimatedM2 > 0 ? coutTotal / sdpEstimatedM2 : 0;

  return {
    caLogements,
    caTotal,
    foncier,
    fraisNotaire,
    taxesAcq,
    totalFoncier,
    travauxBase,
    surveyor,
    geotech,
    moe,
    bet,
    spsCtOpc,
    insuranceDo,
    misc,
    totalEtudes,
    vrd,
    ext,
    aleas,
    totalTravaux,
    taxeAmenagement,
    totalTaxes,
    marketingPct,
    marketingFixed,
    totalCom,
    intercalaires,
    fraisFin,
    totalFin,
    coutTotal,
    marge,
    margePct,
    coutRevientEurM2Hab,
    coutRevientEurM2Sdp,
  };
}

// -------------------------------
// Main component
// -------------------------------
export const BilanPromoteurPage: React.FC = () => {
  // Read buildings and parkings directly from store root
  const buildings = usePromoteurProjectStore((s) => s.buildings);
  const parkings = usePromoteurProjectStore((s) => s.parkings);

  // Surfaces depuis géométries réelles (turf.area sur WGS84)
  const footprintBuildingsM2 = useMemo(() => sumAreas(buildings), [buildings]);
  const footprintParkingsM2 = useMemo(() => sumAreas(parkings), [parkings]);

  // Local state for volumetry params
  const [buildingKind, setBuildingKind] = useState<BuildingKind>("COLLECTIF");
  const [floorsSpec, setFloorsSpec] = useState<FloorsSpec>({
    aboveGroundFloors: 1,
    groundFloorHeightM: 2.8,
    typicalFloorHeightM: 2.7,
  });
  const [nbLogements, setNbLogements] = useState<number>(1);

  // Assumptions state
  const [ass, setAss] = useState<Assumptions>(DEFAULT_ASSUMPTIONS);

  // Derived volumetry
  const levelsCount = useMemo(() => 1 + Math.max(0, Math.floor(n(floorsSpec.aboveGroundFloors, 0))), [floorsSpec.aboveGroundFloors]);
  const totalHeightM = useMemo(
    () => n(floorsSpec.groundFloorHeightM, 2.8) + Math.max(0, Math.floor(n(floorsSpec.aboveGroundFloors, 0))) * n(floorsSpec.typicalFloorHeightM, 2.7),
    [floorsSpec]
  );

  const coefHab = buildingKind === "INDIVIDUEL" ? COEF_HABITABLE_INDIVIDUEL : COEF_HABITABLE_COLLECTIF;
  const sdpEstimatedM2 = useMemo(() => footprintBuildingsM2 * levelsCount * COEF_SDP, [footprintBuildingsM2, levelsCount]);
  const habitableEstimatedM2 = useMemo(() => sdpEstimatedM2 * coefHab, [sdpEstimatedM2, coefHab]);
  const surfaceVendableM2 = useMemo(() => habitableEstimatedM2 * n(ass.coefVendable, 1), [habitableEstimatedM2, ass.coefVendable]);

  // -------------------------------
  // Pro forma calculations
  // -------------------------------
  const computed = useMemo(() => {
    const pf = computeProForma(ass, sdpEstimatedM2, surfaceVendableM2);

    // ========== LINES ==========
    const lines: Line[] = [];

    // RECETTES
    lines.push({ section: "RECETTES", label: "CA logements", valueEur: pf.caLogements, hint: `${m2(surfaceVendableM2)} × ${ass.salePriceEurM2Hab} €/m²` });
    lines.push({ section: "RECETTES", label: "CA TOTAL", valueEur: pf.caTotal, kind: "subtotal" });

    // A) FONCIER
    lines.push({ section: "A) FONCIER", label: "Prix foncier", valueEur: pf.foncier });
    lines.push({ section: "A) FONCIER", label: "Frais notaire", valueEur: pf.fraisNotaire, hint: `${ass.notaryFeesPct.toFixed(1)}%` });
    lines.push({ section: "A) FONCIER", label: "Droits / taxes acquisition", valueEur: pf.taxesAcq, hint: `${ass.acquisitionTaxesPct.toFixed(1)}%` });
    lines.push({ section: "A) FONCIER", label: "Total foncier", valueEur: pf.totalFoncier, kind: "subtotal" });

    // B) ÉTUDES & MONTAGE
    lines.push({ section: "B) ÉTUDES & MONTAGE", label: "Géomètre", valueEur: pf.surveyor, hint: "forfait" });
    lines.push({ section: "B) ÉTUDES & MONTAGE", label: "Géotechnique", valueEur: pf.geotech, hint: "forfait" });
    lines.push({ section: "B) ÉTUDES & MONTAGE", label: "MOE / Architecte", valueEur: pf.moe, hint: `${ass.moePct.toFixed(1)}% travaux` });
    lines.push({ section: "B) ÉTUDES & MONTAGE", label: "BET", valueEur: pf.bet, hint: `${ass.betPct.toFixed(1)}% travaux` });
    lines.push({ section: "B) ÉTUDES & MONTAGE", label: "SPS / CT / OPC", valueEur: pf.spsCtOpc, hint: "forfait" });
    lines.push({ section: "B) ÉTUDES & MONTAGE", label: "Assurance DO", valueEur: pf.insuranceDo, hint: `${ass.insuranceDoPct.toFixed(1)}% travaux` });
    lines.push({ section: "B) ÉTUDES & MONTAGE", label: "Divers montage", valueEur: pf.misc, hint: "forfait" });
    lines.push({ section: "B) ÉTUDES & MONTAGE", label: "Total études & montage", valueEur: pf.totalEtudes, kind: "subtotal" });

    // C) TRAVAUX
    lines.push({ section: "C) TRAVAUX", label: "Travaux principaux", valueEur: pf.travauxBase, hint: `${m2(sdpEstimatedM2)} × ${ass.worksCostEurM2Sdp} €/m² SDP` });
    lines.push({ section: "C) TRAVAUX", label: "VRD / raccordements", valueEur: pf.vrd, hint: `${ass.vrdPct.toFixed(1)}% travaux` });
    lines.push({ section: "C) TRAVAUX", label: "Aménagements extérieurs", valueEur: pf.ext, hint: `${ass.extPct.toFixed(1)}% travaux` });
    lines.push({ section: "C) TRAVAUX", label: "Aléas travaux", valueEur: pf.aleas, hint: `${ass.contingencyPct.toFixed(1)}% travaux` });
    lines.push({ section: "C) TRAVAUX", label: "Total travaux", valueEur: pf.totalTravaux, kind: "subtotal" });

    // D) TAXES
    lines.push({ section: "D) TAXES", label: "Taxe d'aménagement", valueEur: pf.taxeAmenagement, hint: `${ass.taxeAmenagementEurM2Sdp} €/m² SDP` });
    lines.push({ section: "D) TAXES", label: "Total taxes", valueEur: pf.totalTaxes, kind: "subtotal" });

    // E) COMMERCIALISATION
    lines.push({ section: "E) COMMERCIALISATION", label: "Commercialisation (% CA)", valueEur: pf.marketingPct, hint: `${ass.marketingPctCa.toFixed(1)}%` });
    lines.push({ section: "E) COMMERCIALISATION", label: "Commercialisation (forfait)", valueEur: pf.marketingFixed, hint: "option" });
    lines.push({ section: "E) COMMERCIALISATION", label: "Total commercialisation", valueEur: pf.totalCom, kind: "subtotal" });

    // F) FINANCEMENT
    lines.push({ section: "F) FINANCEMENT", label: "Intérêts intercalaires", valueEur: pf.intercalaires, hint: `${ass.financingRatePct.toFixed(1)}% × (foncier + 0.5×travaux)` });
    lines.push({ section: "F) FINANCEMENT", label: "Frais dossier / garanties", valueEur: pf.fraisFin, hint: "forfait" });
    lines.push({ section: "F) FINANCEMENT", label: "Total financement", valueEur: pf.totalFin, kind: "subtotal" });

    // TOTAL
    lines.push({ section: "TOTAL", label: "COÛT TOTAL OPÉRATION", valueEur: pf.coutTotal, kind: "total" });
    lines.push({ section: "TOTAL", label: "MARGE BRUTE", valueEur: pf.marge, kind: "total" });

    // Notes
    const notes: string[] = [];
    if (footprintBuildingsM2 <= 0) notes.push("Aucun bâtiment dessiné en Implantation 2D : SDP/Habitable = 0. Retournez sur Implantation 2D et dessinez au moins un bâtiment.");
    if (ass.salePriceEurM2Hab <= 0) notes.push("Prix de vente €/m² non renseigné : CA = 0.");
    if (ass.landPriceEur <= 0) notes.push("Foncier non renseigné : le bilan est incomplet.");

    // Per-unit metrics (safe division)
    const safeNbLogements = nbLogements > 0 ? nbLogements : 1;
    const prixParLogement = pf.caTotal / safeNbLogements;
    const coutParLogement = pf.coutTotal / safeNbLogements;
    const margeParLogement = pf.marge / safeNbLogements;

    return {
      ...pf,
      lines,
      notes,
      prixParLogement,
      coutParLogement,
      margeParLogement,
    };
  }, [ass, footprintBuildingsM2, sdpEstimatedM2, surfaceVendableM2, nbLogements]);

  // -------------------------------
  // Lecture Promoteur (auto-generated insights)
  // -------------------------------
  const lecturePromoteur = useMemo(() => {
    const insights: string[] = [];

    // Marge analysis
    if (computed.margePct >= 20) {
      insights.push("✅ Marge confortable (≥ 20%)");
    } else if (computed.margePct >= 12) {
      insights.push("⚠️ Marge moyenne (12-20%) : prudence sur les hypothèses");
    } else if (computed.margePct > 0) {
      insights.push("🔴 Marge faible (< 12%) : risque élevé");
    } else {
      insights.push("🔴 Marge négative : opération non viable en l'état");
    }

    // Small operation
    if (surfaceVendableM2 > 0 && surfaceVendableM2 < 150) {
      insights.push("📏 Petite opération (< 150 m² vendable) : frais fixes proportionnellement élevés");
    }

    // Cost ratio analysis
    if (computed.coutRevientEurM2Hab > 0 && ass.salePriceEurM2Hab > 0) {
      const ratio = computed.coutRevientEurM2Hab / ass.salePriceEurM2Hab;
      if (ratio > 0.70) {
        insights.push("⚠️ Risque de compression de marge : coût de revient élevé vs prix");
      }
    }

    // Foncier check
    if (ass.landPriceEur <= 0) {
      insights.push("📋 Foncier non renseigné : bilan incomplet");
    }

    // Building check
    if (footprintBuildingsM2 <= 0) {
      insights.push("🏗️ Aucun bâtiment dessiné : surfaces à 0");
    }

    return insights;
  }, [computed, surfaceVendableM2, ass.salePriceEurM2Hab, ass.landPriceEur, footprintBuildingsM2]);

  // -------------------------------
  // Sensibilité (Stress test)
  // -------------------------------
  const sensitivity = useMemo(() => {
    // Scenario A: +5% construction costs (affects travauxBase, and VRD/ext/aleas that are % of it)
    const assScenarioA: Assumptions = {
      ...ass,
      worksCostEurM2Sdp: ass.worksCostEurM2Sdp * 1.05,
    };
    const pfA = computeProForma(assScenarioA, sdpEstimatedM2, surfaceVendableM2);

    // Scenario B: -5% sale price
    const assScenarioB: Assumptions = {
      ...ass,
      salePriceEurM2Hab: ass.salePriceEurM2Hab * 0.95,
    };
    const pfB = computeProForma(assScenarioB, sdpEstimatedM2, surfaceVendableM2);

    return {
      base: {
        marge: computed.marge,
        margePct: computed.margePct,
      },
      scenarioA: {
        label: "+5% coût travaux",
        marge: pfA.marge,
        margePct: pfA.margePct,
        deltaMarge: pfA.marge - computed.marge,
        deltaPct: pfA.margePct - computed.margePct,
      },
      scenarioB: {
        label: "-5% prix de vente",
        marge: pfB.marge,
        margePct: pfB.margePct,
        deltaMarge: pfB.marge - computed.marge,
        deltaPct: pfB.margePct - computed.margePct,
      },
    };
  }, [ass, sdpEstimatedM2, surfaceVendableM2, computed.marge, computed.margePct]);

  // Group lines by section
  const grouped = useMemo(() => {
    const map = new Map<string, Line[]>();
    for (const l of computed.lines) {
      if (!map.has(l.section)) map.set(l.section, []);
      map.get(l.section)!.push(l);
    }
    return map;
  }, [computed.lines]);

  // Scroll to stress test section
  const scrollToStressTest = () => {
    document.getElementById("stress-test")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // -------------------------------
  // UI Styles
  // -------------------------------
  const card: React.CSSProperties = {
    background: "white",
    borderRadius: 16,
    padding: 16,
    border: "1px solid #e2e8f0",
    boxShadow: "0 1px 3px rgba(0,0,0,0.06), 0 10px 24px rgba(0,0,0,0.06)",
  };
  const kpi: React.CSSProperties = { ...card, padding: 16 };
  const label: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: "#0f172a", marginBottom: 6 };
  const input: React.CSSProperties = {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 12,
    border: "1px solid #cbd5e1",
    background: "white",
    color: "#0f172a",
    fontSize: 13,
    boxSizing: "border-box",
  };
  const sectionTitle: React.CSSProperties = {
    fontSize: 12,
    fontWeight: 900,
    color: "#0f172a",
    letterSpacing: "0.06em",
    textTransform: "uppercase",
  };

  const updateAss = <K extends keyof Assumptions>(key: K, value: Assumptions[K]) => {
    setAss((s) => ({ ...s, [key]: value }));
  };

  // Check if we have data from store
  const hasStoreData = buildings && buildings.features && buildings.features.length > 0;

  return (
    <div style={{ background: "#f8fafc", minHeight: "100vh", padding: 24, color: "#0f172a", fontFamily: "'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif" }}>
      <div style={{ maxWidth: 1280, margin: "0 auto" }}>
        {/* Header */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 28, fontWeight: 950, letterSpacing: "-0.6px" }}>Bilan Promoteur</div>
          <div style={{ background: "#16a34a", color: "white", padding: "8px 16px", borderRadius: 8, fontSize: 13, fontWeight: 700, marginTop: 10 }}>
            ✅ VERSION UI: STRESS TEST VISIBLE
          </div>
          <div style={{ fontSize: 13, color: "#64748b", marginTop: 6 }}>
            Pro forma détaillé — basé sur l'implantation 2D (empreintes) et des hypothèses ajustables.
          </div>
        </div>

        {/* KPIs - Row 1 (6 columns) */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 12, marginBottom: 12 }}>
          <div style={kpi}>
            <div style={{ fontSize: 12, color: "#64748b", fontWeight: 700, marginBottom: 6 }}>CA total</div>
            <div style={{ fontSize: 22, fontWeight: 950 }}>{eur(computed.caTotal)}</div>
            <div style={{ fontSize: 11, color: "#64748b", marginTop: 6 }}>Vendable × Prix × Commercialisation</div>
          </div>
          <div style={kpi}>
            <div style={{ fontSize: 12, color: "#64748b", fontWeight: 700, marginBottom: 6 }}>Coût total</div>
            <div style={{ fontSize: 22, fontWeight: 950 }}>{eur(computed.coutTotal)}</div>
            <div style={{ fontSize: 11, color: "#64748b", marginTop: 6 }}>Foncier + Études + Travaux + …</div>
          </div>
          <div style={kpi}>
            <div style={{ fontSize: 12, color: "#64748b", fontWeight: 700, marginBottom: 6 }}>Marge brute</div>
            <div style={{ fontSize: 22, fontWeight: 950, color: computed.marge >= 0 ? "#16a34a" : "#dc2626" }}>{eur(computed.marge)}</div>
            <div style={{ fontSize: 11, color: "#64748b", marginTop: 6 }}>{computed.margePct.toFixed(1)} % du CA</div>
          </div>
          <div style={kpi}>
            <div style={{ fontSize: 12, color: "#64748b", fontWeight: 700, marginBottom: 6 }}>Coût revient</div>
            <div style={{ fontSize: 18, fontWeight: 950 }}>{Math.round(computed.coutRevientEurM2Hab)} €/m² vend.</div>
            <div style={{ fontSize: 11, color: "#64748b", marginTop: 6 }}>{Math.round(computed.coutRevientEurM2Sdp)} €/m² SDP</div>
          </div>
          <div style={kpi}>
            <div style={{ fontSize: 12, color: "#64748b", fontWeight: 700, marginBottom: 6 }}>Taux marge</div>
            <div style={{ fontSize: 22, fontWeight: 950, color: computed.margePct >= 15 ? "#16a34a" : computed.margePct >= 8 ? "#ea580c" : "#dc2626" }}>
              {computed.margePct.toFixed(1)} %
            </div>
            <div style={{ fontSize: 11, color: "#64748b", marginTop: 6 }}>Marge / CA</div>
          </div>
          {/* KPI Stress test */}
          <div style={{ ...kpi, background: "linear-gradient(135deg, #fef9c3, #fef08a)" }}>
            <div style={{ fontSize: 12, color: "#854d0e", fontWeight: 700, marginBottom: 6 }}>📉 Stress test</div>
            <div style={{ fontSize: 11, color: "#713f12", lineHeight: 1.5 }}>
              <div>
                +5% travaux → Marge: <span style={{ fontWeight: 700, color: sensitivity.scenarioA.marge >= 0 ? "#166534" : "#991b1b" }}>{eur(sensitivity.scenarioA.marge)}</span> ({sensitivity.scenarioA.margePct.toFixed(1)}%)
              </div>
              <div style={{ fontSize: 10, color: "#a16207", marginBottom: 4 }}>
                Δ {sensitivity.scenarioA.deltaMarge >= 0 ? "+" : ""}{eur(sensitivity.scenarioA.deltaMarge)} ({sensitivity.scenarioA.deltaPct >= 0 ? "+" : ""}{sensitivity.scenarioA.deltaPct.toFixed(1)} pts)
              </div>
              <div>
                -5% prix → Marge: <span style={{ fontWeight: 700, color: sensitivity.scenarioB.marge >= 0 ? "#166534" : "#991b1b" }}>{eur(sensitivity.scenarioB.marge)}</span> ({sensitivity.scenarioB.margePct.toFixed(1)}%)
              </div>
              <div style={{ fontSize: 10, color: "#a16207" }}>
                Δ {sensitivity.scenarioB.deltaMarge >= 0 ? "+" : ""}{eur(sensitivity.scenarioB.deltaMarge)} ({sensitivity.scenarioB.deltaPct >= 0 ? "+" : ""}{sensitivity.scenarioB.deltaPct.toFixed(1)} pts)
              </div>
            </div>
            <div
              onClick={scrollToStressTest}
              style={{ fontSize: 11, color: "#1d4ed8", marginTop: 6, textDecoration: "underline", cursor: "pointer" }}
            >
              Voir le détail
            </div>
          </div>
        </div>

        {/* KPIs - Row 2 (Per unit) */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 16 }}>
          <div style={{ ...kpi, background: "linear-gradient(135deg, #f0f9ff, #e0f2fe)" }}>
            <div style={{ fontSize: 12, color: "#0369a1", fontWeight: 700, marginBottom: 6 }}>Prix moyen / logement</div>
            <div style={{ fontSize: 20, fontWeight: 950, color: "#0c4a6e" }}>{eur(computed.prixParLogement)}</div>
            <div style={{ fontSize: 11, color: "#64748b", marginTop: 6 }}>CA ÷ {nbLogements} logements</div>
          </div>
          <div style={{ ...kpi, background: "linear-gradient(135deg, #fef3c7, #fde68a)" }}>
            <div style={{ fontSize: 12, color: "#92400e", fontWeight: 700, marginBottom: 6 }}>Coût / logement</div>
            <div style={{ fontSize: 20, fontWeight: 950, color: "#78350f" }}>{eur(computed.coutParLogement)}</div>
            <div style={{ fontSize: 11, color: "#64748b", marginTop: 6 }}>Coût total ÷ {nbLogements} logements</div>
          </div>
          <div style={{ ...kpi, background: computed.margeParLogement >= 0 ? "linear-gradient(135deg, #dcfce7, #bbf7d0)" : "linear-gradient(135deg, #fee2e2, #fecaca)" }}>
            <div style={{ fontSize: 12, color: computed.margeParLogement >= 0 ? "#166534" : "#991b1b", fontWeight: 700, marginBottom: 6 }}>Marge / logement</div>
            <div style={{ fontSize: 20, fontWeight: 950, color: computed.margeParLogement >= 0 ? "#14532d" : "#7f1d1d" }}>{eur(computed.margeParLogement)}</div>
            <div style={{ fontSize: 11, color: "#64748b", marginTop: 6 }}>Marge ÷ {nbLogements} logements</div>
          </div>
        </div>

        {/* Lecture Promoteur */}
        <div style={{ ...card, marginBottom: 16, background: "linear-gradient(135deg, #fafafa, #f5f5f5)", borderLeft: "4px solid #6366f1" }}>
          <div style={{ fontSize: 14, fontWeight: 950, marginBottom: 10, color: "#4338ca" }}>📊 Lecture promoteur</div>
          <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: "#334155", lineHeight: 1.7 }}>
            {lecturePromoteur.map((insight, i) => (
              <li key={i} style={{ marginBottom: 4 }}>{insight}</li>
            ))}
          </ul>
        </div>

        {/* Sensibilité (Stress test) - MOVED HERE: after Lecture promoteur, before Données sources */}
        <div id="stress-test" style={{ ...card, marginBottom: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 950, marginBottom: 10 }}>📉 Sensibilité (Stress test)</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            {/* Scenario A */}
            <div style={{ background: "#fef3c7", borderRadius: 12, padding: 14, border: "1px solid #fcd34d" }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#92400e", marginBottom: 8 }}>
                {sensitivity.scenarioA.label}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#78350f" }}>Marge :</span>
                  <span style={{ fontWeight: 700, color: sensitivity.scenarioA.marge >= 0 ? "#166534" : "#991b1b" }}>
                    {eur(sensitivity.scenarioA.marge)}
                  </span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#78350f" }}>Taux marge :</span>
                  <span style={{ fontWeight: 700 }}>{sensitivity.scenarioA.margePct.toFixed(1)} %</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", borderTop: "1px solid #fcd34d", paddingTop: 6, marginTop: 4 }}>
                  <span style={{ color: "#78350f" }}>Delta vs base :</span>
                  <span style={{ fontWeight: 700, color: sensitivity.scenarioA.deltaMarge < 0 ? "#dc2626" : "#16a34a" }}>
                    {sensitivity.scenarioA.deltaMarge >= 0 ? "+" : ""}{eur(sensitivity.scenarioA.deltaMarge)} ({sensitivity.scenarioA.deltaPct >= 0 ? "+" : ""}{sensitivity.scenarioA.deltaPct.toFixed(1)} pts)
                  </span>
                </div>
              </div>
            </div>

            {/* Scenario B */}
            <div style={{ background: "#fee2e2", borderRadius: 12, padding: 14, border: "1px solid #fca5a5" }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#991b1b", marginBottom: 8 }}>
                {sensitivity.scenarioB.label}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#7f1d1d" }}>Marge :</span>
                  <span style={{ fontWeight: 700, color: sensitivity.scenarioB.marge >= 0 ? "#166534" : "#991b1b" }}>
                    {eur(sensitivity.scenarioB.marge)}
                  </span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#7f1d1d" }}>Taux marge :</span>
                  <span style={{ fontWeight: 700 }}>{sensitivity.scenarioB.margePct.toFixed(1)} %</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", borderTop: "1px solid #fca5a5", paddingTop: 6, marginTop: 4 }}>
                  <span style={{ color: "#7f1d1d" }}>Delta vs base :</span>
                  <span style={{ fontWeight: 700, color: sensitivity.scenarioB.deltaMarge < 0 ? "#dc2626" : "#16a34a" }}>
                    {sensitivity.scenarioB.deltaMarge >= 0 ? "+" : ""}{eur(sensitivity.scenarioB.deltaMarge)} ({sensitivity.scenarioB.deltaPct >= 0 ? "+" : ""}{sensitivity.scenarioB.deltaPct.toFixed(1)} pts)
                  </span>
                </div>
              </div>
            </div>
          </div>
          <div style={{ marginTop: 10, fontSize: 12, color: "#64748b" }}>
            Ces scénarios permettent d'évaluer la résilience de l'opération face aux aléas du marché.
          </div>
        </div>

        {/* Sources implantation */}
        <div style={{ ...card, marginBottom: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 950, marginBottom: 10 }}>Données sources (Implantation 2D)</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 12, fontSize: 13, color: "#334155" }}>
            <div><span style={{ color: "#64748b" }}>Empreinte bâtiments :</span> <b>{m2(footprintBuildingsM2)}</b></div>
            <div><span style={{ color: "#64748b" }}>Empreinte parkings :</span> <b>{m2(footprintParkingsM2)}</b></div>
            <div><span style={{ color: "#64748b" }}>Niveaux :</span> <b>R+{floorsSpec.aboveGroundFloors} ({levelsCount} niv.)</b></div>
            <div><span style={{ color: "#64748b" }}>SDP estimée :</span> <b>{m2(sdpEstimatedM2)}</b></div>
            <div><span style={{ color: "#64748b" }}>Habitable estimée :</span> <b>{m2(habitableEstimatedM2)}</b></div>
            <div><span style={{ color: "#64748b" }}>Vendable estimée :</span> <b style={{ color: "#0369a1" }}>{m2(surfaceVendableM2)}</b></div>
          </div>
          <div style={{ marginTop: 10, fontSize: 12, color: "#64748b" }}>
            {hasStoreData
              ? `✓ Données récupérées depuis Implantation 2D (${nbLogements} logements, type ${buildingKind})`
              : "⚠️ Aucun bâtiment dans le store. Retournez sur Implantation 2D et dessinez au moins un bâtiment."}
          </div>
        </div>

        {/* Paramètres projet + Hypothèses */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 16, marginBottom: 16 }}>
          {/* Paramètres projet */}
          <div style={card}>
            <div style={{ fontSize: 14, fontWeight: 950, marginBottom: 10 }}>Paramètres projet</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <div style={label}>Type bâtiment</div>
                <select style={input} value={buildingKind} onChange={(e) => setBuildingKind(e.target.value as BuildingKind)}>
                  <option value="COLLECTIF">Collectif</option>
                  <option value="INDIVIDUEL">Individuel</option>
                </select>
              </div>
              <div>
                <div style={label}>Étages (R+N)</div>
                <input style={input} type="number" min={0} max={40} value={floorsSpec.aboveGroundFloors} onChange={(e) => setFloorsSpec((f) => ({ ...f, aboveGroundFloors: Math.max(0, Number(e.target.value) || 0) }))} />
              </div>
              <div>
                <div style={label}>Hauteur RDC (m)</div>
                <input style={input} type="number" step="0.1" value={floorsSpec.groundFloorHeightM} onChange={(e) => setFloorsSpec((f) => ({ ...f, groundFloorHeightM: Number(e.target.value) || 2.8 }))} />
              </div>
              <div>
                <div style={label}>Hauteur étage (m)</div>
                <input style={input} type="number" step="0.1" value={floorsSpec.typicalFloorHeightM} onChange={(e) => setFloorsSpec((f) => ({ ...f, typicalFloorHeightM: Number(e.target.value) || 2.7 }))} />
              </div>
              <div>
                <div style={label}>Nb logements</div>
                <input style={input} type="number" min={1} max={500} value={nbLogements} onChange={(e) => setNbLogements(Math.max(1, Math.min(500, Number(e.target.value) || 1)))} />
              </div>
            </div>
            <div style={{ marginTop: 10, fontSize: 12, color: "#64748b" }}>
              Hauteur totale estimée : <b>{totalHeightM.toFixed(1)} m</b>
            </div>
          </div>

          {/* Hypothèses complètes */}
          <div style={card}>
            <div style={{ fontSize: 14, fontWeight: 950, marginBottom: 10 }}>Hypothèses</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
              {/* Revenus */}
              <div>
                <div style={label}>Prix vente (€/m² vend.)</div>
                <input style={input} type="number" value={ass.salePriceEurM2Hab} onChange={(e) => updateAss("salePriceEurM2Hab", Number(e.target.value) || 0)} />
              </div>
              <div>
                <div style={label}>Commercialisation (%)</div>
                <input style={input} type="number" value={ass.commercialisationPct} onChange={(e) => updateAss("commercialisationPct", pct(e.target.value, 100))} />
              </div>
              <div>
                <div style={label}>Coef vendable</div>
                <input style={input} type="number" step="0.01" min={0.8} max={1.2} value={ass.coefVendable} onChange={(e) => updateAss("coefVendable", Math.min(1.2, Math.max(0.8, Number(e.target.value) || 1)))} />
                <div style={{ fontSize: 10, color: "#64748b", marginTop: 2 }}>Vendable = Habitable × coef</div>
              </div>

              {/* Foncier */}
              <div>
                <div style={label}>Foncier (€)</div>
                <input style={input} type="number" value={ass.landPriceEur} onChange={(e) => updateAss("landPriceEur", Number(e.target.value) || 0)} />
              </div>
              <div>
                <div style={label}>Notaire (%)</div>
                <input style={input} type="number" value={ass.notaryFeesPct} onChange={(e) => updateAss("notaryFeesPct", pct(e.target.value, 7.5))} />
              </div>
              <div>
                <div style={label}>Taxes acquisition (%)</div>
                <input style={input} type="number" value={ass.acquisitionTaxesPct} onChange={(e) => updateAss("acquisitionTaxesPct", pct(e.target.value, 0))} />
              </div>

              {/* Travaux */}
              <div>
                <div style={label}>Travaux (€/m² SDP)</div>
                <input style={input} type="number" value={ass.worksCostEurM2Sdp} onChange={(e) => updateAss("worksCostEurM2Sdp", Number(e.target.value) || 0)} />
              </div>
              <div>
                <div style={label}>VRD (%)</div>
                <input style={input} type="number" value={ass.vrdPct} onChange={(e) => updateAss("vrdPct", pct(e.target.value, 6))} />
              </div>
              <div>
                <div style={label}>Ext. (%)</div>
                <input style={input} type="number" value={ass.extPct} onChange={(e) => updateAss("extPct", pct(e.target.value, 3))} />
              </div>
              <div>
                <div style={label}>Aléas (%)</div>
                <input style={input} type="number" value={ass.contingencyPct} onChange={(e) => updateAss("contingencyPct", pct(e.target.value, 3))} />
              </div>

              {/* Études */}
              <div>
                <div style={label}>MOE (%)</div>
                <input style={input} type="number" value={ass.moePct} onChange={(e) => updateAss("moePct", pct(e.target.value, 10))} />
              </div>
              <div>
                <div style={label}>BET (%)</div>
                <input style={input} type="number" value={ass.betPct} onChange={(e) => updateAss("betPct", pct(e.target.value, 3))} />
              </div>
              <div>
                <div style={label}>DO (%)</div>
                <input style={input} type="number" value={ass.insuranceDoPct} onChange={(e) => updateAss("insuranceDoPct", pct(e.target.value, 2))} />
              </div>

              {/* Comm & Fin */}
              <div>
                <div style={label}>Comm. (% CA)</div>
                <input style={input} type="number" value={ass.marketingPctCa} onChange={(e) => updateAss("marketingPctCa", pct(e.target.value, 2))} />
              </div>
              <div>
                <div style={label}>Taux financement (%)</div>
                <input style={input} type="number" value={ass.financingRatePct} onChange={(e) => updateAss("financingRatePct", pct(e.target.value, 4))} />
              </div>
              <div>
                <div style={label}>Frais dossier (€)</div>
                <input style={input} type="number" value={ass.financingFeesEur} onChange={(e) => updateAss("financingFeesEur", Number(e.target.value) || 0)} />
              </div>

              {/* Taxes */}
              <div>
                <div style={label}>Taxe aménag. (€/m² SDP)</div>
                <input style={input} type="number" value={ass.taxeAmenagementEurM2Sdp} onChange={(e) => updateAss("taxeAmenagementEurM2Sdp", Number(e.target.value) || 0)} />
              </div>
            </div>
            <div style={{ marginTop: 10, fontSize: 12, color: "#64748b" }}>
              Les hypothèses sont simplifiées (v2). TVA, phasage, annexes, et cashflow seront ajoutés dans les versions suivantes.
            </div>
          </div>
        </div>

        {/* Bilan détaillé */}
        <div style={card}>
          <div style={{ fontSize: 14, fontWeight: 950, marginBottom: 10 }}>Bilan détaillé</div>

          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {Array.from(grouped.entries()).map(([section, lines]) => (
              <div key={section}>
                <div style={{ ...sectionTitle, marginBottom: 8 }}>{section}</div>
                <div style={{ border: "1px solid #e2e8f0", borderRadius: 12, overflow: "hidden" }}>
                  {lines.map((l, idx) => {
                    const isSubtotal = l.kind === "subtotal";
                    const isTotal = l.kind === "total";
                    const isNegative = l.valueEur < 0;
                    return (
                      <div
                        key={idx}
                        style={{
                          display: "grid",
                          gridTemplateColumns: "1fr 180px 160px",
                          gap: 12,
                          padding: "10px 12px",
                          borderTop: idx === 0 ? "none" : "1px solid #f1f5f9",
                          background: isTotal ? "#0f172a" : isSubtotal ? "#f1f5f9" : "white",
                          color: isTotal ? "white" : isNegative ? "#dc2626" : "#0f172a",
                          fontWeight: isTotal ? 900 : isSubtotal ? 700 : 500,
                          alignItems: "center",
                        }}
                      >
                        <div>{l.label}</div>
                        <div style={{ fontSize: 11, color: isTotal ? "rgba(255,255,255,0.7)" : "#64748b", textAlign: "right" }}>
                          {l.hint ?? ""}
                        </div>
                        <div style={{ textAlign: "right", fontWeight: isTotal || isSubtotal ? 900 : 600 }}>{eur(l.valueEur)}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Notes */}
        {computed.notes.length > 0 && (
          <div style={{ ...card, marginTop: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 950, marginBottom: 10 }}>Notes</div>
            <ul style={{ margin: 0, paddingLeft: 18, color: "#334155", fontSize: 13 }}>
              {computed.notes.map((x, i) => (
                <li key={i} style={{ marginBottom: 4 }}>{x}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
};

export default BilanPromoteurPage;