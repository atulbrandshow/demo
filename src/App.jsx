import React, { useState, useEffect, useRef } from "react";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker?url";
import Fuse from "fuse.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

/**
 * Utility: Levenshtein distance -> similarity [0..1]
 */
function levenshteinDistance(a, b) {
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const matrix = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0)
  );
  for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return matrix[a.length][b.length];
}
function similarity(a, b) {
  const ld = levenshteinDistance(a, b);
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - ld / maxLen;
}

/**
 * Normalization pipeline for Devanagari text
 * - NFC normalization
 * - keep only Devanagari unicode range + common punctuation/spaces
 * - collapse multiple identical characters (common garbling)
 * - remove control & invisible chars
 * - basic mapping for some frequent garble patterns (expandable)
 */
function normalizeHindi(str) {
  if (!str || typeof str !== "string") return "";
  let s = str.normalize("NFC");

  // remove invisible/control characters
  s = s.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ");

  // keep Devanagari block (0900–097F) and whitespace and basic punctuation
  s = s.replace(/[^\u0900-\u097F\s।॥\-–—]/g, " ");

  // collapse multiple spaces
  s = s.replace(/\s+/g, " ").trim();

  // collapse repeated identical consonants/vowel signs that appear from garbage,
  // e.g., "ममम" -> "म", but be careful to not over-collapse legitimate doubling.
  s = s.replace(/(.)\1{2,}/g, "$1$1"); // keep up to two if repeated many times

  // small mapping fixes for frequent corruptions (you can expand this map)
  const fixes = [
    // these are examples — expand if you see more garbled outputs
    ["पममबरई", "प्रेमबाई"],
    ["पममबरै", "प्रेमबाई"],
    ["पममबई", "प्रेमबाई"],
    ["जयररम", "जयराम"],
  ];
  for (const [bad, good] of fixes) {
    if (s.includes(bad)) s = s.split(bad).join(good);
  }

  return s;
}

export default function App() {
  const [pdfRows, setPdfRows] = useState([]); // {page, text, textNorm}
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const fuseRef = useRef(null);

  async function extractTextFromPDF(arrayBuffer) {
    setLoading(true);
    try {
      const doc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      const rows = [];
      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        const strings = content.items.map((it) => it.str);
        const pageText = strings.join(" ");
        // split heuristics: many PDFs lose newlines; try splitting on heavy spaces or punctuation
        const lines =
          pageText.split(/\r\n|\n|  |।|॥/).map((l) => l.trim()).filter(Boolean) || [
            pageText.trim(),
          ];
        lines.forEach((ln) => {
          const textNorm = normalizeHindi(ln);
          rows.push({ page: p, text: ln, textNorm });
        });
      }

      setPdfRows(rows);

      // Build Fuse index on normalized text
      fuseRef.current = new Fuse(rows, {
        keys: ["textNorm"],
        includeScore: true,
        threshold: 0.45, // tweak: lower -> stricter, higher -> looser
        distance: 100,
        ignoreLocation: true,
      });

      setResults([]);
    } catch (err) {
      console.error("PDF parsing error:", err);
      alert("Error reading PDF: " + (err.message || err));
    } finally {
      setLoading(false);
    }
  }

  const handleFile = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const buffer = await f.arrayBuffer();
    await extractTextFromPDF(buffer);
  };

  // Search logic: try exact -> normalized exact -> fuse fuzzy -> levenshtein fallback
  useEffect(() => {
    if (!query || pdfRows.length === 0) {
      setResults([]);
      return;
    }
    const qRaw = query.trim();
    const q = normalizeHindi(qRaw);
    // 1) exact fast search on raw text (helps if pdf has exact)
    const exact = pdfRows.filter((r) => r.text.includes(qRaw));
    if (exact.length) {
      setResults(exact);
      return;
    }
    // 2) exact on normalized text
    const exactNorm = pdfRows.filter((r) => r.textNorm.includes(q));
    if (exactNorm.length) {
      setResults(exactNorm);
      return;
    }
    // 3) fuse fuzzy search on normalized text
    if (fuseRef.current) {
      const fuseRes = fuseRef.current.search(q);
      if (fuseRes && fuseRes.length) {
        // filter by reasonable score (lower score = better; includeScore true)
        const good = fuseRes.filter((r) => (r.score ?? 1) <= 0.55); // tweakable
        if (good.length) {
          setResults(good.map((g) => g.item));
          return;
        }
      }
    }
    // 4) Levenshtein similarity fallback across normalized text
    const levMatches = pdfRows
      .map((r) => ({ r, sim: similarity(r.textNorm, q) }))
      .filter((o) => o.sim >= 0.62) // tweak threshold; 0.62 is forgiving
      .sort((a, b) => b.sim - a.sim)
      .map((o) => o.r);
    if (levMatches.length) {
      setResults(levMatches);
      return;
    }

    // nothing found
    setResults([]);
  }, [query, pdfRows]);

  return (
    <div className="min-h-screen p-6 bg-slate-50">
      <div className="max-w-4xl mx-auto bg-white p-6 rounded-2xl shadow">
        <h1 className="text-2xl font-semibold mb-4">PDF Hindi Search — Robust</h1>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Upload PDF (Hindi)
            </label>
            <input type="file" accept="application/pdf" onChange={handleFile} className="bg-green-600 rounded-xl text-white w-48 p-3" />
            <div className="text-xs text-slate-400 mt-1">
              Use the local PDF (no CDN workers). Extraction may vary by PDF.
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Search Hindi Name
            </label>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Type name like प्रेमबाई or जयराम"
              className="w-full rounded-md border px-3 py-2"
            />
          </div>

          <div className="flex items-center justify-between text-sm text-slate-600">
            <span>Rows indexed: {pdfRows.length}</span>
            {loading && <span className="text-blue-500">Extracting...</span>}
          </div>

          <div>
            <h2 className="text-lg font-medium mb-2">Results ({results.length})</h2>
            <div className="space-y-2 max-h-96 overflow-auto">
              {!loading && results.length === 0 && (
                <div className="text-sm text-slate-400">No matches</div>
              )}
              {results.map((m, i) => (
                <div key={i} className="p-3 border rounded-lg flex items-center gap-5 bg-slate-50 leading-relaxed">
                  <div className="text-sm font-semibold text-slate-500 mb-1">Page {m.page}</div>
                  <div className="text-sm">{query}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}