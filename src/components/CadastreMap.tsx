import { useEffect, useRef } from "react";
import L, { Map as LeafletMap, GeoJSON } from "leaflet";
import "leaflet/dist/leaflet.css";

type CadastreType = "parcelles" | "batiments" | "sections";

interface CadastreMapProps {
  insee: string;
  type?: CadastreType;
  height?: string;
}

// 🔧 IMPORTANT : ton URL Supabase depuis .env
// Exemple : VITE_SUPABASE_URL=https://xxxxx.supabase.co
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;

export function CadastreMap({
  insee,
  type = "parcelles",
  height = "500px",
}: CadastreMapProps) {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const leafletMapRef = useRef<LeafletMap | null>(null);
  const geoJsonLayerRef = useRef<GeoJSON | null>(null);

  // -------------------------------------------------------
  // 1. Initialisation de la carte une seule fois
  // -------------------------------------------------------
  useEffect(() => {
    if (!mapRef.current) return;
    if (leafletMapRef.current) return; // déjà initialisée

    const map = L.map(mapRef.current).setView([46.5, 2.5], 6); // Vue France
    leafletMapRef.current = map;

    // Fond de carte OSM
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 20,
      attribution: "© OpenStreetMap contributors",
    }).addTo(map);

    return () => {
      map.remove();
      leafletMapRef.current = null;
    };
  }, []);

  // -------------------------------------------------------
  // 2. Chargement du GeoJSON quand insee ou type change
  // -------------------------------------------------------
  useEffect(() => {
    const map = leafletMapRef.current;
    if (!map) return;

    if (!SUPABASE_URL) {
      console.error("❌ VITE_SUPABASE_URL manquant dans .env");
      return;
    }

    const url = `${SUPABASE_URL}/functions/v1/cadastre-geojson-proxy?insee=${insee}&type=${type}`;

    // On supprime l'ancienne couche si elle existe
    if (geoJsonLayerRef.current) {
      map.removeLayer(geoJsonLayerRef.current);
      geoJsonLayerRef.current = null;
    }

    async function loadGeoJson() {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const geojson = await res.json();

        // Nouvelle couche GeoJSON
        const layer = L.geoJSON(geojson, {
          style: {
            weight: 1,
            opacity: 0.7,
            fillOpacity: 0.12,
            color: "#0077ff",
          },
          onEachFeature: (feature, layer) => {
            const props: any = feature.properties || {};

            const idParcelle =
              props.id ||
              props.numero ||
              props.idu ||
              props.IDU ||
              "Parcelle";

            const surface =
              props.contenance ||
              props.surface ||
              props.SURFACE ||
              "N/A";

            layer.on("click", () => {
              layer
                .bindPopup(
                  `
                    <div style="font-size:13px;line-height:1.4;">
                      <strong>Parcelle :</strong> ${idParcelle}<br/>
                      <strong>Surface :</strong> ${surface} m²
                    </div>
                  `
                )
                .openPopup();
            });
          },
        }).addTo(map);

        geoJsonLayerRef.current = layer;

        // Auto-zoom sur les parcelles
        const bounds = layer.getBounds();
        if (bounds.isValid()) {
          map.fitBounds(bounds, { padding: [20, 20] });
        }
      } catch (err) {
        console.error("Erreur chargement cadastre :", err);
      }
    }

    loadGeoJson();
  }, [insee, type]);

  // -------------------------------------------------------
  // Render
  // -------------------------------------------------------
  return (
    <div
      ref={mapRef}
      style={{
        width: "100%",
        height,
        borderRadius: "12px",
        border: "1px solid #ddd",
        overflow: "hidden",
      }}
    />
  );
}

