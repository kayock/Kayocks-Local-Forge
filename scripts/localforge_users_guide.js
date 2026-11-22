// LocalForge Users Guide — docx builder (skill: docx, route create, recipe R1 + DM-1, 3-section TOC)
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  ImageRun, PageBreak, Header, Footer, PageNumber, NumberFormat, SectionType,
  AlignmentType, HeadingLevel, WidthType, BorderStyle, ShadingType,
  LevelFormat, TableOfContents, TableLayoutType,
} = require("docx");
const fs = require("fs");
const path = require("path");

const chapters = [...require("./guide-content-a.js"), ...require("./guide-content-b.js")];

// ── palette: DM-1 Deep Cyan (tech/AI) ──
const P = {
  bg: "162235", titleColor: "FFFFFF", subtitleColor: "B0B8C0", metaColor: "90989F",
  footerColor: "687078", accent: "37DCF2",
  h1: "162235", h2: "1B6B7A", body: "1A2B40", grey: "5B6B7D",
  table: { headerBg: "1B6B7A", headerText: "FFFFFF", innerLine: "C8DDE2", surface: "EDF3F5" },
};

const NB = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const noBorders = { top: NB, bottom: NB, left: NB, right: NB };
const allNoBorders = { top: NB, bottom: NB, left: NB, right: NB, insideHorizontal: NB, insideVertical: NB };

function safeText(v, ph) {
  if (v === undefined || v === null || v === "" || String(v) === "NaN" || String(v) === "undefined") return ph || "[missing]";
  return String(v);
}

// ── cover helpers (design-system.md) ──
function estimateTextWidth(text, pt) {
  let w = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    const isCJK = (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3000 && code <= 0x303f) || (code >= 0xff00 && code <= 0xffef);
    w += isCJK ? pt * 20 : pt * 11;
  }
  return w;
}
function splitTitleLines(title, charsPerLine) {
  if (title.length <= charsPerLine) return [title];
  const breakAfter = new Set([..."，。、；：！？", ..."的与和及之在于为", ..."-_—–·/", ..." \t"]);
  const lines = [];
  let remaining = title;
  while (remaining.length > charsPerLine) {
    let breakAt = -1;
    for (let i = charsPerLine; i >= Math.floor(charsPerLine * 0.6); i--) {
      if (i < remaining.length && breakAfter.has(remaining[i - 1])) { breakAt = i; break; }
    }
    if (breakAt === -1) {
      const limit = Math.min(remaining.length, Math.ceil(charsPerLine * 1.3));
      for (let i = charsPerLine + 1; i < limit; i++) {
        if (breakAfter.has(remaining[i - 1])) { breakAt = i; break; }
      }
    }
    if (breakAt === -1) breakAt = charsPerLine;
    lines.push(remaining.slice(0, breakAt).trim());
    remaining = remaining.slice(breakAt).trim();
  }
  if (remaining) lines.push(remaining);
  if (lines.length > 1 && lines[lines.length - 1].length <= 2) {
    const last = lines.pop();
    lines[lines.length - 1] += " " + last;
  }
  return lines;
}
function calcTitleLayout(title, maxWidthTwips, preferredPt = 40, minPt = 24) {
  // width-aware: average char width for this title at pt
  const avgChar = (pt) => Math.max(estimateTextWidth(title, pt) / Math.max(title.length, 1), 1);
  const charsPerLine = (pt) => Math.floor(maxWidthTwips / avgChar(pt));
  let titlePt = preferredPt;
  let lines;
  while (titlePt >= minPt) {
    const cpl = charsPerLine(titlePt);
    if (cpl < 2) { titlePt -= 2; continue; }
    lines = splitTitleLines(title, cpl);
    if (lines.length <= 3) break;
    titlePt -= 2;
  }
  if (!lines || lines.length > 3) {
    lines = splitTitleLines(title, charsPerLine(minPt));
    titlePt = minPt;
  }
  return { titlePt, titleLines: lines };
}
function calcCoverSpacing(params) {
  const { titleLineCount = 1, titlePt = 36, hasSubtitle = false, hasEnglishLabel = false,
    metaLineCount = 0, fixedHeight = 800, pageHeight = 16838, marginTop = 0, marginBottom = 0 } = params;
  const SAFETY = 1200;
  const usableHeight = pageHeight - marginTop - marginBottom - SAFETY;
  const titleHeight = titleLineCount * (titlePt * 23 + 200);
  const subtitleHeight = hasSubtitle ? (12 * 23 + 600) : 0;
  const englishLabelHeight = hasEnglishLabel ? (9 * 23 + 600) : 0;
  const metaHeight = metaLineCount * (10 * 23 + 100);
  const implicitParaHeight = 3 * 300;
  const contentHeight = titleHeight + subtitleHeight + englishLabelHeight + metaHeight + fixedHeight + implicitParaHeight;
  const remainingSpace = usableHeight - contentHeight;
  const safeRemaining = Math.max(remainingSpace, 400);
  const FOOTER_MIN = 800;
  const rawTop = Math.floor(safeRemaining * 0.45);
  const rawBottom = Math.floor(safeRemaining * 0.45);
  const bottomSpacing = Math.max(rawBottom, FOOTER_MIN);
  const topSpacing = Math.max(rawTop - Math.max(0, FOOTER_MIN - rawBottom), 400);
  const midSpacing = Math.max(safeRemaining - topSpacing - bottomSpacing, 0);
  return { topSpacing, midSpacing, bottomSpacing };
}

// ── Recipe R1: Pure Paragraph Cover (left-aligned) ──
function buildCoverR1(config) {
  const padL = 1200, padR = 800;
  const availableWidth = 11906 - padL - padR - 300;
  const { titlePt, titleLines } = calcTitleLayout(config.title, availableWidth, 36, 24);
  const titleSize = titlePt * 2;
  const spacing = calcCoverSpacing({
    titleLineCount: titleLines.length, titlePt,
    hasSubtitle: !!config.subtitle, hasEnglishLabel: !!config.englishLabel,
    metaLineCount: (config.metaLines || []).length, fixedHeight: 400,
  });
  const accentLeft = { style: BorderStyle.SINGLE, size: 8, color: P.accent, space: 12 };
  const children = [];
  children.push(new Paragraph({ spacing: { before: spacing.topSpacing } }));
  if (config.englishLabel) {
    children.push(new Paragraph({
      indent: { left: padL, right: padR }, spacing: { after: 500 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: P.accent, space: 8 } },
      children: [new TextRun({ text: config.englishLabel.split("").join("  "), size: 18, color: P.accent, font: { ascii: "Calibri", eastAsia: "SimHei" }, characterSpacing: 40 })],
    }));
  }
  for (let i = 0; i < titleLines.length; i++) {
    children.push(new Paragraph({
      indent: { left: padL },
      spacing: { after: i < titleLines.length - 1 ? 100 : 300, line: Math.ceil(titlePt * 23), lineRule: "atLeast" },
      children: [new TextRun({ text: titleLines[i], size: titleSize, bold: true, color: P.titleColor, font: { eastAsia: "SimHei", ascii: "Arial" } })],
    }));
  }
  if (config.subtitle) {
    children.push(new Paragraph({
      indent: { left: padL }, spacing: { after: 800 },
      children: [new TextRun({ text: config.subtitle, size: 24, color: P.subtitleColor, font: { eastAsia: "Microsoft YaHei", ascii: "Arial" } })],
    }));
  }
  for (const line of (config.metaLines || [])) {
    children.push(new Paragraph({
      indent: { left: padL + 200 }, spacing: { after: 80 },
      border: { left: accentLeft },
      children: [new TextRun({ text: safeText(line), size: 24, color: P.metaColor, font: { eastAsia: "Microsoft YaHei", ascii: "Arial" } })],
    }));
  }
  children.push(new Paragraph({ spacing: { before: spacing.bottomSpacing } }));
  children.push(new Paragraph({
    indent: { left: padL, right: padR },
    border: { top: { style: BorderStyle.SINGLE, size: 2, color: P.accent, space: 8 } },
    spacing: { before: 200 },
    children: [
      new TextRun({ text: config.footerLeft || "", size: 16, color: P.footerColor, font: { ascii: "Arial" } }),
      new TextRun({ text: "                                        " }),
      new TextRun({ text: config.footerRight || "", size: 16, color: P.footerColor, font: { ascii: "Arial" } }),
    ],
  }));
  return [new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    borders: allNoBorders,
    rows: [new TableRow({
      height: { value: 16838, rule: "exact" },
      children: [new TableCell({ shading: { type: ShadingType.CLEAR, fill: P.bg }, borders: noBorders, verticalAlign: "top", children })],
    })],
  })];
}

// ── body building blocks ──
function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 360, after: 160, line: 312 },
    children: [new TextRun({ text, bold: true, size: 32, color: P.h1, font: { ascii: "Calibri", eastAsia: "SimHei" } })],
  });
}
function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 240, after: 120, line: 312 },
    children: [new TextRun({ text, bold: true, size: 26, color: P.h2, font: { ascii: "Calibri", eastAsia: "SimHei" } })],
  });
}
// body paragraph; supports **bold** inline segments
function p(text, opts = {}) {
  const runs = [];
  const parts = String(text).split("**");
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    runs.push(new TextRun({ text: parts[i], bold: i % 2 === 1, size: 22, color: P.body, font: { ascii: "Calibri", eastAsia: "Microsoft YaHei" } }));
  }
  return new Paragraph({ alignment: AlignmentType.LEFT, spacing: { after: 120, line: 312 }, children: runs, ...opts });
}
function stepPara(text, ref) {
  const runs = [];
  const parts = String(text).split("**");
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    runs.push(new TextRun({ text: parts[i], bold: i % 2 === 1, size: 22, color: P.body, font: { ascii: "Calibri", eastAsia: "Microsoft YaHei" } }));
  }
  return new Paragraph({ numbering: { reference: ref, level: 0 }, spacing: { after: 100, line: 312 }, children: runs });
}
function tableTitle(text) {
  return new Paragraph({
    keepNext: true, spacing: { before: 160, after: 80, line: 312 },
    children: [new TextRun({ text, bold: true, size: 21, color: P.h2, font: { ascii: "Calibri", eastAsia: "SimHei" } })],
  });
}
function cell(text, opts = {}) {
  const { header = false, width, fill } = opts;
  const runs = String(text).split("**").filter(Boolean).map((t, i) =>
    new TextRun({
      text: t, bold: header || i % 2 === 1, size: header ? 21 : 20,
      color: header ? P.table.headerText : P.body, font: { ascii: "Calibri", eastAsia: "Microsoft YaHei" },
    }));
  return new TableCell({
    children: [new Paragraph({ alignment: AlignmentType.LEFT, spacing: { line: 276 }, children: runs })],
    shading: { type: ShadingType.CLEAR, fill: header ? P.table.headerBg : (fill || "FFFFFF") },
    margins: { top: 70, bottom: 70, left: 120, right: 120 },
    width: width ? { size: width, type: WidthType.PERCENTAGE } : undefined,
  });
}
function table(spec) {
  const n = spec.headers.length;
  const widths = spec.widths || spec.headers.map(() => Math.floor(100 / n));
  const rows = [new TableRow({
    tableHeader: true, cantSplit: true,
    children: spec.headers.map((t, i) => cell(t, { header: true, width: widths[i] })),
  })];
  spec.rows.forEach((r, idx) => {
    rows.push(new TableRow({
      cantSplit: true,
      children: r.map((t, i) => cell(t, { width: widths[i], fill: idx % 2 === 0 ? "FFFFFF" : P.table.surface })),
    }));
  });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: P.table.headerBg },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: P.table.headerBg },
      left: NB, right: NB,
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: P.table.innerLine },
      insideVertical: NB,
    },
    rows,
  });
}
function noteBox(title, text) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: NB, bottom: NB, right: NB, left: { style: BorderStyle.SINGLE, size: 12, color: P.table.headerBg }, insideHorizontal: NB, insideVertical: NB },
    rows: [new TableRow({
      cantSplit: true,
      children: [new TableCell({
        shading: { type: ShadingType.CLEAR, fill: P.table.surface },
        margins: { top: 100, bottom: 100, left: 160, right: 160 },
        children: [
          new Paragraph({ spacing: { after: 60, line: 300 }, children: [new TextRun({ text: title, bold: true, size: 21, color: P.h2, font: { ascii: "Calibri" } })] }),
          new Paragraph({ spacing: { line: 300 }, children: String(text).split("**").filter(Boolean).map((t, i) => new TextRun({ text: t, bold: i % 2 === 1, size: 21, color: P.body, font: { ascii: "Calibri" } })) }),
        ],
      })],
    })],
  });
}
function pngSize(file) {
  const b = fs.readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}
let figCount = 0;
function figure(file, caption) {
  figCount += 1;
  const { w, h } = pngSize(file);
  const displayWidth = 560;
  const displayHeight = Math.round(displayWidth * (h / w));
  return [
    new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { before: 160, after: 60 },
      children: [new ImageRun({ data: fs.readFileSync(file), transformation: { width: displayWidth, height: displayHeight }, type: "png" })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { after: 200, line: 300 },
      children: [new TextRun({ text: "Figure " + figCount + ": " + caption, size: 19, color: P.grey, italics: true, font: { ascii: "Calibri" } })],
    }),
  ];
}

// ── map content blocks to docx elements ──
const numberingConfigs = [];
let stepCounter = 0;
function blocksToChildren(chapterIndex, blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.p !== undefined) { out.push(p(b.p, b.opts || {})); continue; }
    if (b.h2 !== undefined) { out.push(h2(b.h2)); continue; }
    if (b.steps !== undefined) {
      stepCounter += 1;
      const ref = "steps-" + chapterIndex + "-" + stepCounter;
      numberingConfigs.push({
        reference: ref,
        levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 620, hanging: 360 } } } }],
      });
      for (const s of b.steps) out.push(stepPara(s, ref));
      continue;
    }
    if (b.table !== undefined) {
      if (b.table.title) out.push(tableTitle(b.table.title));
      out.push(table(b.table));
      out.push(new Paragraph({ spacing: { after: 120 }, children: [] }));
      continue;
    }
    if (b.note !== undefined) {
      out.push(noteBox(b.note.title, b.note.text));
      out.push(new Paragraph({ spacing: { after: 120 }, children: [] }));
      continue;
    }
    if (b.fig !== undefined) { out.push(...figure(b.fig.path, b.fig.caption)); continue; }
  }
  return out;
}

const bodyChildren = [];
chapters.forEach((ch, i) => {
  bodyChildren.push(h1(ch.h1));
  bodyChildren.push(...blocksToChildren(i + 1, ch.blocks));
});

// ── headers/footers ──
const docHeader = new Header({
  children: [new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { after: 0 },
    children: [new TextRun({ text: "LocalForge Users Guide", size: 18, color: "808080", font: { ascii: "Calibri" } })],
  })],
});
const pageFooter = () => new Footer({
  children: [new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ children: [PageNumber.CURRENT], size: 18, color: "808080", font: { ascii: "Calibri" } })],
  })],
});

// ── document ──
const pgSize = { width: 11906, height: 16838 };
const pgMargin = { top: 1440, bottom: 1440, left: 1701, right: 1417 };

const doc = new Document({
  numbering: { config: numberingConfigs },
  styles: {
    default: {
      document: {
        run: { font: { ascii: "Calibri", eastAsia: "Microsoft YaHei" }, size: 22, color: P.body },
        paragraph: { spacing: { line: 312 } },
      },
      heading1: { run: { font: { ascii: "Calibri", eastAsia: "SimHei" }, size: 32, bold: true, color: P.h1 }, paragraph: { spacing: { before: 360, after: 160, line: 312 } } },
      heading2: { run: { font: { ascii: "Calibri", eastAsia: "SimHei" }, size: 26, bold: true, color: P.h2 }, paragraph: { spacing: { before: 240, after: 120, line: 312 } } },
    },
  },
  sections: [
    { // Section 1: cover — margin 0, no page numbers, no footer
      properties: { page: { size: pgSize, margin: { top: 0, bottom: 0, left: 0, right: 0 } } },
      children: buildCoverR1({
        title: "LocalForge Users Guide",
        subtitle: "Multi-Machine Setup and Collaborative Builds, in Plain Language",
        englishLabel: "LOCALFORGE",
        metaLines: [
          "Applies to: LocalForge 0.4.4 (companion and IDE)",
          "Written for the three-machine fleet: Windows Dell, Ubuntu Station, Ubuntu Portable",
          "No terminal experience required for normal use",
        ],
        footerLeft: "LocalForge",
        footerRight: "November 2026",
      }),
    },
    { // Section 2: front matter (TOC) — Roman numerals
      properties: {
        type: SectionType.NEXT_PAGE,
        page: { size: pgSize, margin: pgMargin, pageNumbers: { start: 1, formatType: NumberFormat.UPPER_ROMAN } },
      },
      footers: { default: pageFooter() },
      children: [
        new Paragraph({
          alignment: AlignmentType.CENTER, spacing: { before: 480, after: 360 },
          children: [new TextRun({ text: "Table of Contents", bold: true, size: 32, color: P.h1, font: { ascii: "Calibri", eastAsia: "SimHei" } })],
        }),
        new TableOfContents("Table of Contents", { hyperlink: true, headingStyleRange: "1-2" }),
        new Paragraph({
          spacing: { before: 200 },
          children: [new TextRun({
            text: "Note: this table of contents is generated via field codes. After editing the document, right-click the table and choose \"Update Field\" to refresh page numbers.",
            italics: true, size: 18, color: "888888", font: { ascii: "Calibri" },
          })],
        }),
        new Paragraph({ children: [new PageBreak()] }),
      ],
    },
    { // Section 3: body — Arabic starting at 1
      properties: {
        type: SectionType.NEXT_PAGE,
        page: { size: pgSize, margin: pgMargin, pageNumbers: { start: 1, formatType: NumberFormat.DECIMAL } },
      },
      headers: { default: docHeader },
      footers: { default: pageFooter() },
      children: bodyChildren,
    },
  ],
});

const OUT = "/home/z/my-project/download/LocalForge-Users-Guide.docx";
Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync(OUT, buf);
  console.log("written", OUT, buf.length, "bytes;", "figures:", figCount, "numbered lists:", numberingConfigs.length);
});
