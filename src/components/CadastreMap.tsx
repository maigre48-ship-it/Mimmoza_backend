// src/components/CadastreMap.tsx
import React, { useMemo, useState, useEffect, useCallback, useRef } from "react";
import { MapContainer, TileLayer, GeoJSON } from "react-leaflet";
import type { GeoJSON as GeoJSONType, FeatureCollection, Geometry } from "geojson";
import L from "leaflet";
import type { Map as LeafletMap } from "leaflet";
import { supabase } from "@/lib/supabaseClient";
import * as turf from "@turf/turf";

export type CadastreParcelSelection = {
  parcel_id: string;
  commune_insee: string;
  surface_terrain_m2: number | null;
};

type CadastreMapProps = {
  onParcelSelect?: (parcel: CadastreParcelSelection) => void;
  onParcelChange?: (parcelId: string, geom: any, surface_terrain_m2?: number | null) => void;
  parcels?: GeoJSONType.FeatureCollection;
  selectedParcelId?: string;
  initialCenter?: [number, number];
  initialZoom?: number;
  communeInsee?: string;
  centerOnParcel?: boolean;
};

type ReculsResult = {
  zone_code: string | null;
  zone_libelle: string | null;
  retrait_voirie_min_m: number | null;
  retrait_limites_separatives_min_m: number | null;
  retrait_fond_parcelle_min_m: number | null;
  retrait_min_m: number | null;
};

function getParcelIdFromFeature(feature: any): string | null {
  if (!feature) return null;
  const p = feature.properties || {};

  const candidates = [
    p.parcel_id,
    p.idu,
    p.IDU,
    p.id_parcelle,
    p.ID_PARCELLE,
    p.id,
    feature.id,
  ];

  for (const c of candidates) {
    if (c !== undefined && c !== null && String(c).trim() !== "") {
      return String(c).trim();
    }
  }

  return null;
}

function matchParcelId(feature: any, targetId: string): boolean {
  if (!targetId) return false;
  const id = getParcelIdFromFeature(feature);
  if (!id) return false;

  const a = String(id);
  const b = String(targetId);

  if (a === b) return true;
  if (a.endsWith(b) || b.endsWith(a)) return true;

  return false;
}

/**
 * Essaie de dériver un code INSEE fiable depuis les propriétés cadastre.
 * Etalab/IGN cadastre expose souvent code_dep + code_com (3 digits) => INSEE = dep + code_com
 */
function deriveCommuneInseeFromProps(p: any, fallback?: string): string {
  const direct =
    (p?.commune_insee ??
      p?.code_insee ??
      p?.code_insee_commune ??
      p?.insee ??
      p?.INSEE ??
      "") as string;

  const s = String(direct || "").trim();
  if (s.length >= 5) return s;

  const dep = String(p?.code_dep ?? p?.CODE_DEP ?? "").trim();
  const com = String(p?.code_com ?? p?.CODE_COM ?? "").trim(); // souvent "065"
  if (dep && com && dep.length === 2 && com.length === 3) return `${dep}${com}`;

  const fb = String(fallback || "").trim();
  if (fb.length >= 5) return fb;

  return "";
}

function toNumberOrNull(v: any): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeReculsRow(row: any): ReculsResult {
  return {
    zone_code: row?.zone_code ?? null,
    zone_libelle: row?.zone_libelle ?? null,
    retrait_voirie_min_m: toNumberOrNull(row?.retrait_voirie_min_m),
    retrait_limites_separatives_min_m: toNumberOrNull(row?.retrait_limites_separatives_min_m),
    retrait_fond_parcelle_min_m: toNumberOrNull(row?.retrait_fond_parcelle_min_m),
    retrait_min_m: toNumberOrNull(row?.retrait_min_m),
  };
}

export const CadastreMap: React.FC<CadastreMapProps> = ({
  onParcelSelect,
  onParcelChange,
  parcels,
  selectedParcelId,
  initialCenter = [43.3483, -1.6214],
  initialZoom = 16,
  communeInsee,
  centerOnParcel = true,
}) => {
  const [map, setMap] = useState<LeafletMap | null>(null);
  const [effectiveParcels, setEffectiveParcels] =
    useState<FeatureCollection<Geometry, any> | null>(null);
  const [clickedIds, setClickedIds] = useState<string[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);

  // Overlays reculs
  const [buildableGeom, setBuildableGeom] = useState<any | null>(null); // buffer négatif (zone constructible)
  const [reculBandGeom, setReculBandGeom] = useState<any | null>(null); // bande (buffer + diff)
  const [reculsInfo, setReculsInfo] = useState<ReculsResult | null>(null);
  const [reculLoading, setReculLoading] = useState(false);

  // évite les réponses RPC qui arrivent dans le désordre
  const requestSeqRef = useRef(0);

  useEffect(() => {
    console.log("[CadastreMap] communeInsee reçu:", communeInsee);
  }, [communeInsee]);

  // ---------------------------------------------------------------------------
  // Chargement automatique du cadastre
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;

    setLastError(null);

    if (parcels) {
      setEffectiveParcels(parcels as any);
      return;
    }

    const insee = (communeInsee ?? "").trim();
    if (!insee || insee.length < 5) {
      setEffectiveParcels(null);
      setLastError("INSEE invalide ou manquant");
      return;
    }

    const load = async () => {
      try {
        console.log("[CadastreMap] Invoke cadastre-from-commune:", { commune_insee: insee });

        const { data: json, error } = await supabase.functions.invoke("cadastre-from-commune", {
          body: { commune_insee: insee },
        });

        if (error) {
          console.error("[CadastreMap] Erreur cadastre-from-commune:", error);
          if (!cancelled) {
            setEffectiveParcels(null);
            setLastError(error.message ?? "Erreur cadastre");
          }
          return;
        }

        let geojson: FeatureCollection<Geometry, any> | null = null;

        if (json && (json as any).type === "FeatureCollection") {
          geojson = json as FeatureCollection<Geometry, any>;
        } else if ((json as any)?.geojson?.type === "FeatureCollection") {
          geojson = (json as any).geojson;
        }

        if (!geojson) {
          console.error("[CadastreMap] Format GeoJSON inattendu:", json);
          if (!cancelled) {
            setEffectiveParcels(null);
            setLastError("Format GeoJSON inattendu");
          }
          return;
        }

        if (!cancelled) setEffectiveParcels(geojson);
      } catch (err) {
        console.error("[CadastreMap] Erreur chargement cadastre:", err);
        if (!cancelled) {
          setEffectiveParcels(null);
          setLastError(err instanceof Error ? err.message : String(err));
        }
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [parcels, communeInsee]);

  // ---------------------------------------------------------------------------
  // Sélection
  // ---------------------------------------------------------------------------
  const selectedIdSet = useMemo(() => {
    const all = new Set<string>();
    if (selectedParcelId) all.add(String(selectedParcelId));
    for (const id of clickedIds) if (id) all.add(String(id));
    return all;
  }, [selectedParcelId, clickedIds]);

  // dernier id cliqué (utile quand selectedParcelId n’est pas fourni)
  const lastClickedId = useMemo(() => {
    return clickedIds.length ? clickedIds[clickedIds.length - 1] : null;
  }, [clickedIds]);

  const activeParcelId = selectedParcelId ? String(selectedParcelId) : lastClickedId;

  const styleFn = useMemo(
    () =>
      (feature: any) => {
        const id = getParcelIdFromFeature(feature);
        const isSelected = id != null && selectedIdSet.has(String(id));

        return {
          color: isSelected ? "#2563eb" : "#0f172a",
          weight: isSelected ? 2 : 1,
          fillColor: isSelected ? "#60a5fa" : "#e5e7eb",
          fillOpacity: isSelected ? 0.6 : 0.2,
        };
      },
    [selectedIdSet],
  );

  const resetReculOverlays = useCallback(() => {
    setBuildableGeom(null);
    setReculBandGeom(null);
    setReculsInfo(null);
  }, []);

  const computeOverlaysFromRecul = useCallback((parcelFeature: any, rMeters: number) => {
    // Turf buffer sur GeoJSON 4326 : OK (units meters).
    // Buffer négatif peut être vide : on gère proprement.
    try {
      const bufferedNeg = turf.buffer(parcelFeature as any, -rMeters, { units: "meters" });
      // si négatif invalide/empty, turf peut renvoyer null ou une feature non exploitable
      if (bufferedNeg && (bufferedNeg as any).geometry) {
        setBuildableGeom(bufferedNeg);
      } else {
        setBuildableGeom(null);
      }
    } catch {
      setBuildableGeom(null);
    }

    // Bande de recul : buffer positif - parcelle (visuel)
    try {
      const bufferedPos = turf.buffer(parcelFeature as any, rMeters, { units: "meters" });
      // diff = pos - original
      const band = turf.difference(bufferedPos as any, parcelFeature as any);
      if (band && (band as any).geometry) {
        setReculBandGeom(band);
      } else {
        // fallback : si difference échoue, affiche au moins le buffer positif
        setReculBandGeom(bufferedPos);
      }
    } catch {
      setReculBandGeom(null);
    }
  }, []);

  const fetchReculsForFeature = useCallback(
    async (feature: any) => {
      const p = feature?.properties || {};
      const insee = deriveCommuneInseeFromProps(p, communeInsee);

      // Si on n’a pas l’INSEE, on ne peut pas obtenir les reculs
      if (!insee || insee.length < 5) {
        console.warn("[CadastreMap] INSEE introuvable sur la parcelle, reculs non calculés.");
        resetReculOverlays();
        return;
      }

      // La fonction SQL attend un Feature avec geometry.
      const parcelFeature = {
        type: "Feature",
        geometry: feature.geometry,
        properties: {
          parcel_id: getParcelIdFromFeature(feature) ?? null,
        },
      };

      // garde-fou : GeoJSON doit être Polygon/MultiPolygon
      const gType = parcelFeature?.geometry?.type;
      if (gType !== "Polygon" && gType !== "MultiPolygon") {
        console.warn("[CadastreMap] Géométrie non supportée pour reculs:", gType);
        resetReculOverlays();
        return;
      }

      const seq = ++requestSeqRef.current;
      setReculLoading(true);

      try {
        const { data, error } = await supabase.rpc("get_reculs_for_parcel_geom_v2", {
          p_commune_insee: String(insee),
          p_parcel_geojson: parcelFeature,
          p_geojson_srid: 4326, // Leaflet
        });

        // ignore si une requête plus récente est déjà partie
        if (seq !== requestSeqRef.current) return;

        if (error || !data || !data[0]) {
          console.warn("[CadastreMap] RPC reculs: pas de data", { error, data });
          resetReculOverlays();
          return;
        }

        const row = normalizeReculsRow(data[0]);
        setReculsInfo(row);

        const rVoirie = row.retrait_voirie_min_m ?? 0;
        const rLimites = row.retrait_limites_separatives_min_m ?? 0;
        const rFond = row.retrait_fond_parcelle_min_m ?? 0;
        const rMin = row.retrait_min_m ?? 0;

        // Stratégie simple (visuel) : on prend le maximum disponible
        const r = Math.max(rVoirie, rLimites, rFond, rMin);

        if (r > 0) {
          computeOverlaysFromRecul(parcelFeature, r);
        } else {
          resetReculOverlays();
        }
      } catch (e) {
        if (seq !== requestSeqRef.current) return;
        console.error("[CadastreMap] erreur RPC reculs", e);
        resetReculOverlays();
      } finally {
        if (seq === requestSeqRef.current) setReculLoading(false);
      }
    },
    [communeInsee, computeOverlaysFromRecul, resetReculOverlays],
  );

  // ---------------------------------------------------------------------------
  // Clic sur parcelle
  // ---------------------------------------------------------------------------
  const handleEachFeature = (feature: any, layer: any) => {
    const p = feature?.properties || {};
    const id = getParcelIdFromFeature(feature);

    const communeInseeProp = deriveCommuneInseeFromProps(p, communeInsee);

    const surfaceRaw =
      p.surface_terrain_m2 ??
      p.contenance ??
      p.SURFACE ??
      p.surface ??
      null;

    const surfaceNum =
      surfaceRaw != null && !Number.isNaN(Number(surfaceRaw))
        ? Number(surfaceRaw)
        : null;

    layer.on("click", async () => {
      if (id) {
        setClickedIds((prev) =>
          prev.includes(String(id))
            ? prev.filter((x) => x !== String(id))
            : [...prev, String(id)],
        );
      }

      // centrage sur clic
      try {
        const bounds = (layer as any).getBounds?.();
        if (bounds?.isValid?.()) {
          map?.fitBounds(bounds, { padding: [40, 40] });
        }
      } catch (err) {
        console.error("[CadastreMap] Erreur centrage sur clic :", err);
      }

      if (onParcelSelect && id) {
        onParcelSelect({
          parcel_id: String(id),
          commune_insee: String(communeInseeProp),
          surface_terrain_m2: surfaceNum,
        });
      }

      if (onParcelChange && id) {
        onParcelChange(String(id), feature.geometry, surfaceNum);
      }

      // Reculs + overlays
      await fetchReculsForFeature(feature);
    });
  };

  // ---------------------------------------------------------------------------
  // Quand selectedParcelId change depuis le parent → calcule aussi les reculs
  // (avant, on ne calculait que sur click => souvent "ça ne marche pas")
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!effectiveParcels || !activeParcelId) return;

    const f = effectiveParcels.features.find((x: any) => matchParcelId(x, activeParcelId));
    if (!f) return;

    fetchReculsForFeature(f);
  }, [effectiveParcels, activeParcelId, fetchReculsForFeature]);

  // ---------------------------------------------------------------------------
  // Recentre automatiquement la carte sur selectedParcelId
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!map || !effectiveParcels || !selectedParcelId || !centerOnParcel) return;

    const feature = effectiveParcels.features.find((f: any) => matchParcelId(f, selectedParcelId));
    if (!feature) return;

    try {
      const layer = L.geoJSON(feature as any);
      const bounds = layer.getBounds();
      if (bounds.isValid()) {
        map.fitBounds(bounds, { padding: [40, 40] });
      }
    } catch (err) {
      console.error("[CadastreMap] Erreur centrage auto :", err);
    }
  }, [map, effectiveParcels, selectedParcelId, centerOnParcel]);

  // ---------------------------------------------------------------------------
  // Rendu
  // ---------------------------------------------------------------------------
  if (!effectiveParcels) {
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: "radial-gradient(circle at 0 0, #e5e7eb, #cbd5f5, #e5e7eb)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 12,
          color: "#111827",
          padding: "12px",
        }}
      >
        <div style={{ marginBottom: 8, fontWeight: 500 }}>
          Carte cadastrale (en attente de données)
        </div>
        <div
          style={{
            marginBottom: 4,
            color: "#4b5563",
            fontSize: 11,
            textAlign: "center",
            maxWidth: 360,
          }}
        >
          Chargement via <code>cadastre-from-commune</code>. Ouvre la console et cherche{" "}
          <code>[CadastreMap]</code>.
        </div>
        <div style={{ marginTop: 4, fontSize: 11, color: "#6b7280" }}>
          Code INSEE reçu : <strong>{communeInsee || "—"}</strong>
        </div>
        {lastError && (
          <div
            style={{
              marginTop: 8,
              fontSize: 10,
              color: "#b91c1c",
              maxWidth: 360,
              textAlign: "center",
            }}
          >
            Dernière erreur : {lastError}
          </div>
        )}
      </div>
    );
  }

  return (
    <MapContainer
      whenCreated={setMap}
      center={initialCenter}
      zoom={initialZoom}
      style={{ width: "100%", height: "100%" }}
    >
      <TileLayer
        attribution="&copy; OpenStreetMap contributors"
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />

      {/* Parcelles */}
      <GeoJSON
        data={effectiveParcels as any}
        style={styleFn as any}
        onEachFeature={handleEachFeature}
      />

      {/* Bande de recul (visuelle) */}
      {reculBandGeom && (
        <GeoJSON
          data={reculBandGeom as any}
          style={{
            color: "#f59e0b",
            weight: 1,
            fillColor: "#fbbf24",
            fillOpacity: 0.25,
          }}
        />
      )}

      {/* Zone constructible (buffer négatif) */}
      {buildableGeom && (
        <GeoJSON
          data={buildableGeom as any}
          style={{
            color: "#16a34a",
            weight: 2,
            fillColor: "#22c55e",
            fillOpacity: 0.25,
          }}
        />
      )}

      {/* Petit “status” debug discret dans la console */}
      {(() => {
        if (reculLoading) {
          console.log("[CadastreMap] Reculs: chargement…");
          return null;
        }
        if (reculsInfo?.zone_code) {
          console.log("[CadastreMap] Reculs OK:", reculsInfo);
        }
        return null;
      })()}
    </MapContainer>
  );
};
