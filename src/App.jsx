import React, { useState, useEffect, useRef } from "react";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker?url";
import Fuse from "fuse.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

// --- same helpers from before ---
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

function normalizeHindi(str) {
  if (!str || typeof str !== "string") return "";
  let s = str.normalize("NFC");
  s = s.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ");
  s = s.replace(/[^\u0900-\u097F\s।॥\-–—]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/(.)\1{2,}/g, "$1$1");
  return s;
}

// --- mapping persistence helpers ---
const MAPPINGS_KEY = "pdfHindiMappings_v1";

function loadMappings() {
  try {
    const raw = localStorage.getItem(MAPPINGS_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
function saveMappings(mapObj) {
  try {
    localStorage.setItem(MAPPINGS_KEY, JSON.stringify(mapObj));
  } catch {}
}

// Replace occurrences in text by mapping preferences (map garbled -> correct)
function applyMappingsToText(text, mappings) {
  if (!mappings || Object.keys(mappings).length === 0) return text;
  // We try to replace longer keys first to avoid partial overlap
  const keys = Object.keys(mappings).sort((a, b) => b.length - a.length);
  let out = text;
  for (const k of keys) {
    if (!k) continue;
    const safe = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(safe, "g");
    out = out.replace(re, mappings[k]);
  }
  return out;
}

export default function App() {
  const [pdfRows, setPdfRows] = useState([]); // {page, text, textNorm}
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [mappings, setMappings] = useState(loadMappings());
  const [teachInput, setTeachInput] = useState(""); // user-provided correct text for teach action
  const fuseRef = useRef(null);

  // Rebuild index whenever rows or mappings change
  const buildIndex = (rows, currentMappings) => {
    // Apply mapping to original text to produce textMapped (for display/search)
    const rowsWithMapped = rows.map((r) => {
      const mapped = applyMappingsToText(r.text, currentMappings);
      return { ...r, textMapped: mapped, textNormMapped: normalizeHindi(mapped) };
    });
    // Build Fuse on textNormMapped
    fuseRef.current = new Fuse(rowsWithMapped, {
      keys: ["textNormMapped"],
      includeScore: true,
      threshold: 0.45,
      distance: 100,
      ignoreLocation: true,
    });
    setPdfRows(rowsWithMapped);
  };

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
        const lines =
          pageText.split(/\r\n|\n|  |।|॥/).map((l) => l.trim()).filter(Boolean) || [
            pageText.trim(),
          ];
        lines.forEach((ln) => {
          rows.push({ page: p, text: ln, textNorm: normalizeHindi(ln) });
        });
      }
      buildIndex(rows, mappings);
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

  // When mappings change, persist and rebuild index
  useEffect(() => {
    saveMappings(mappings);
    // rebuild index using existing original rows (we have original in pdfRows as text)
    // gather original rows (if pdfRows has textMapped version, get original text backup)
    const originalRows = pdfRows.length
      ? pdfRows.map((r) => ({ page: r.page, text: r.text || r.textMapped || "" }))
      : [];
    if (originalRows.length) buildIndex(originalRows, mappings);
  }, [mappings]);

  // Search pipeline as before but using mapped text
  useEffect(() => {
    if (!query || !fuseRef.current) {
      setResults([]);
      return;
    }
    const qRaw = query.trim();
    const q = normalizeHindi(qRaw);

    // 1) exact on mapped raw text (fast)
    const exact = pdfRows.filter((r) => (r.textMapped || r.text).includes(qRaw));
    if (exact.length) {
      setResults(exact);
      return;
    }
    // 2) exact on normalized mapped text
    const exactNorm = pdfRows.filter((r) => (r.textNormMapped || r.textNorm).includes(q));
    if (exactNorm.length) {
      setResults(exactNorm);
      return;
    }
    // 3) Fuse fuzzy
    const fuseRes = fuseRef.current.search(q);
    if (fuseRes && fuseRes.length) {
      const good = fuseRes.filter((r) => (r.score ?? 1) <= 0.55);
      if (good.length) {
        setResults(good.map((g) => g.item));
        return;
      }
    }
    // 4) Levenshtein fallback on mapped normalized
    const levMatches = pdfRows
      .map((r) => ({ r, sim: similarity(r.textNormMapped || r.textNorm, q) }))
      .filter((o) => o.sim >= 0.62)
      .sort((a, b) => b.sim - a.sim)
      .map((o) => o.r);
    if (levMatches.length) {
      setResults(levMatches);
      return;
    }

    setResults([]);
  }, [query, pdfRows]);

  // Teach mapping: map a garbled snippet -> correct user-provided text
  function teachMapping(garbled, correct) {
    if (!garbled || !correct) return;
    const newMap = { ...mappings };
    newMap[garbled] = correct;
    setMappings(newMap);
    // Rebuild index will be triggered by effect on mappings
  }

  // Auto-suggest: given user-pasted correct text, try to find a best candidate garbled row and offer mapping
  function suggestMappingForPaste(correctText) {
    if (!correctText || pdfRows.length === 0) return null;
    const q = normalizeHindi(correctText);
    // search top candidates in fuse (they are garbled but normalized)
    if (!fuseRef.current) return null;
    const cand = fuseRef.current.search(q, { limit: 8 });
    if (!cand || cand.length === 0) return null;
    // pick top item textMapped as suggested garble
    const top = cand[0].item;
    // If exact similarity good, propose mapping
    const sim = similarity(top.textNormMapped || top.textNorm, q);
    return { garbled: top.text, mapped: correctText, sim, page: top.page };
  }

  // UI helper: remove a mapping
  function removeMapping(garbled) {
    if (!mappings[garbled]) return;
    const copy = { ...mappings };
    delete copy[garbled];
    setMappings(copy);
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-5xl mx-auto bg-white p-6 rounded-2xl shadow">
        <h1 className="text-2xl font-semibold mb-4">PDF Hindi Search — Teach Mappings</h1>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Upload PDF (Hindi)</label>
            <input type="file" accept="application/pdf" onChange={handleFile} className=" bg-green-600 p-2 rounded-xl text-white" />
            <div className="text-xs text-slate-400 mt-1">
              If text looks garbled in results, teach mappings once and future searches become accurate.
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Search Hindi Name</label>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Type name like प्रेमबाई or मांगीलाल"
              className="w-full rounded-md border px-3 py-2"
            />
          </div>

          <div className="flex items-center gap-4">
            <div className="text-sm text-slate-600">Rows indexed: {pdfRows.length}</div>
            {loading && <div className="text-blue-500">Extracting...</div>}
            <div className="ml-auto text-xs text-slate-500">Mappings saved to localStorage</div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <h2 className="text-lg font-medium mb-2">Results ({results.length})</h2>
              <div className="space-y-2 max-h-96 overflow-auto">
                {results.length === 0 && !loading && <div className="text-sm text-slate-400">No matches</div>}
                {results.map((m, i) => (
                  <div key={i} className="p-3 border rounded-lg bg-slate-50">
                    <div className="flex items-center justify-between">
                      <div className="text-xs text-slate-500">Page {m.page}</div>
                      <div className="text-xs text-slate-500">Norm: {m.textNormMapped || m.textNorm}</div>
                    </div>
                    <div className="mt-2 text-sm leading-relaxed">{highlightMappedText(m.textMapped || m.text, query)}</div>
                    
                  </div>
                ))}
              </div>
            </div>

            <div>
              <h2 className="text-lg font-medium mb-2">Mappings ({Object.keys(mappings).length})</h2>
              <div className="space-y-2 max-h-96 overflow-auto">
                {Object.keys(mappings).length === 0 && <div className="text-sm text-slate-400">No mappings yet</div>}
                {Object.entries(mappings).map(([g, c]) => (
                  <div key={g} className="p-3 border rounded-lg bg-slate-50 flex items-start justify-between">
                    <div>
                      <div className="text-xs text-slate-500">Garbled</div>
                      <div className="font-medium">{g}</div>
                      <div className="text-xs text-slate-500 mt-1">Mapped → {c}</div>
                    </div>
                    <div className="flex flex-col gap-2">
                      <button onClick={() => {
                        // quick search mapped value
                        setQuery(c);
                      }} className="text-sm px-2 py-1 border rounded">Search mapped</button>
                      <button onClick={() => removeMapping(g)} className="text-sm px-2 py-1 border rounded">Remove</button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-4">
                <h3 className="text-sm font-medium mb-2">Auto-suggest mapping</h3>
                <p className="text-xs text-slate-500 mb-2">Paste the correct name and click Suggest — it'll find a top garbled candidate.</p>
                <AutoSuggestBox pdfRows={pdfRows} onAccept={(garbled, correct) => {
                  teachMapping(garbled, correct);
                }} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// tiny component to help auto-suggest mapping
function AutoSuggestBox({ pdfRows, onAccept }) {
  const [input, setInput] = useState("");
  const [suggest, setSuggest] = useState(null);

  useEffect(() => {
    if (!input || pdfRows.length === 0) {
      setSuggest(null);
      return;
    }
    const q = normalizeHindi(input);
    // naive local search for candidate by similarity on textNorm
    const ranked = pdfRows
      .map((r) => ({ r, sim: similarity(r.textNorm || r.text, q) }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 6);
    if (ranked.length > 0 && ranked[0].sim > 0.35) {
      setSuggest({ garbled: ranked[0].r.text, mapped: input, sim: ranked[0].sim, page: ranked[0].r.page });
    } else {
      setSuggest(null);
    }
  }, [input, pdfRows]);

  return (
    <div className="space-y-2">
      <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Paste correct text (e.g., मांगीलाल)" className="w-full rounded-md border px-3 py-2 text-sm" />
      {suggest ? (
        <div className="p-3 border rounded bg-slate-50">
          <div className="text-xs text-slate-500">Suggested mapping (sim: {suggest.sim.toFixed(2)})</div>
          <div className="font-medium mt-1">{suggest.garbled} → {suggest.mapped}</div>
          <div className="mt-2 flex gap-2">
            <button onClick={() => onAccept(suggest.garbled, suggest.mapped)} className="px-3 py-1 bg-green-600 text-white rounded text-sm">Accept</button>
          </div>
        </div>
      ) : (
        <div className="text-xs text-slate-400">No suggestion yet — try a different paste or extract the garbled row from results and use Teach.</div>
      )}
    </div>
  );
}

// Highlight mapped text (simple)
function highlightMappedText(text, qRaw) {
  if (!qRaw) return <span>{text}</span>;
  try {
    const q = qRaw.trim();
    const idx = text.indexOf(q);
    if (idx !== -1) {
      return (
        <>
          {text.slice(0, idx)}
          <mark className="bg-yellow-200 rounded px-0.5">{text.slice(idx, idx + q.length)}</mark>
          {text.slice(idx + q.length)}
        </>
      );
    }
  } catch {}
  return <span>{text}</span>;
}
