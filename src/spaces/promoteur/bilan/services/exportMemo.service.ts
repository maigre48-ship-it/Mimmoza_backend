// src/spaces/promoteur/bilan/services/exportMemo.service.ts
import { saveAs } from "file-saver";
import html2canvas from "html2canvas";
import jsPDF from "jspdf";
import {
  Document,
  Packer,
  Paragraph,
  HeadingLevel,
  TextRun,
} from "docx";

import type { Snapshot, AiSyntheseResponse } from "../types/aiSynthese.types";
import { normalizeProject } from "./snapshotNormalize.service";

function safeStr(v: any, fallback = "—") {
  const s = (v === null || v === undefined) ? "" : String(v);
  return s.trim() ? s : fallback;
}

function filenameBase(snapshot: Snapshot | null) {
  const p = normalizeProject(snapshot);
  const base = p.title.replace(/[^\w\- ]+/g, "").slice(0, 60).trim().replace(/\s+/g, "_");
  return base || "mimmoza_analyse";
}

export async function exportAnalysisToDocx(args: {
  snapshot: Snapshot | null;
  ai: AiSyntheseResponse | null;
}) {
  const { snapshot, ai } = args;
  const p = normalizeProject(snapshot);

  const pluSummary = safeStr((snapshot as any)?.plu?.summary);
  const marketSummary = safeStr((snapshot as any)?.market?.summary);
  const risquesSummary = safeStr((snapshot as any)?.risques?.summary);
  const bilan = (snapshot as any)?.bilan || {};
  const bilanLine =
    bilan?.marge_pct !== undefined
      ? `Marge : ${bilan.marge_pct}% · TRI : ${safeStr(bilan.tri_pct)}% · CA : ${bilan.ca ? `${Number(bilan.ca).toLocaleString()} €` : "—"}`
      : "—";

  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: "Note d’investissement — Analyse projet", heading: HeadingLevel.TITLE }),
          new Paragraph({ text: `Projet : ${p.title}` }),
          new Paragraph({ text: `Adresse : ${p.addressLine}` }),
          new Paragraph({ text: `${p.parcelLabel}` }),
          new Paragraph({ text: `Type de projet : ${p.projectTypeLabel}` }),
          new Paragraph({ text: "" }),

          new Paragraph({ text: "Synthèse modules Mimmoza", heading: HeadingLevel.HEADING_1 }),

          new Paragraph({ text: "PLU & Faisabilité", heading: HeadingLevel.HEADING_2 }),
          new Paragraph(pluSummary),

          new Paragraph({ text: "Étude de marché", heading: HeadingLevel.HEADING_2 }),
          new Paragraph(marketSummary),

          new Paragraph({ text: "Risques", heading: HeadingLevel.HEADING_2 }),
          new Paragraph(risquesSummary),

          new Paragraph({ text: "Bilan promoteur", heading: HeadingLevel.HEADING_2 }),
          new Paragraph(bilanLine),

          new Paragraph({ text: "" }),
          new Paragraph({ text: "Analyse IA (banque / comité)", heading: HeadingLevel.HEADING_1 }),
          new Paragraph({
            children: [
              new TextRun({
                text: safeStr(ai?.markdown, "Analyse IA non générée."),
              }),
            ],
          }),
        ],
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  saveAs(blob, `${filenameBase(snapshot)}.docx`);
}

export async function exportAnalysisToPdf(args: {
  elementId: string; // id du bloc HTML à exporter
  snapshot: Snapshot | null;
}) {
  const { elementId, snapshot } = args;
  const el = document.getElementById(elementId);
  if (!el) throw new Error("Bloc analyse introuvable pour export PDF.");

  const canvas = await html2canvas(el, { scale: 2, useCORS: true });
  const imgData = canvas.toDataURL("image/png");

  const pdf = new jsPDF("p", "mm", "a4");
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();

  // Fit image to page width
  const imgWidth = pageWidth;
  const imgHeight = (canvas.height * imgWidth) / canvas.width;

  let position = 0;
  let heightLeft = imgHeight;

  pdf.addImage(imgData, "PNG", 0, position, imgWidth, imgHeight);
  heightLeft -= pageHeight;

  while (heightLeft > 0) {
    position = heightLeft - imgHeight;
    pdf.addPage();
    pdf.addImage(imgData, "PNG", 0, position, imgWidth, imgHeight);
    heightLeft -= pageHeight;
  }

  pdf.save(`${filenameBase(snapshot)}.pdf`);
}
