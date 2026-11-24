/* Job Rate Calculator — pricing engine.
 * Mirrors, for one standalone line with no fees:
 *   - Parent Base automation "Client: Size Tier/Price Code (Created)" wfloDTK7ZfBLhBEck (price code)
 *   - {Job Rate 2.0 base} fld1UtVuEY9QXfa8J for SF price types, {Job Rate 1.0} fld8wHDkEORdMKumY base terms otherwise
 *   - {Price Type} fldRanHKS5d1wYaiI and {Discount} fldn6wb7ICBUzOrTj
 * Works in the browser (window.JRC) and in Node (module.exports).
 */
(function (root) {
  const SQFT_PER_SQM = 10.7639;
  const COMMERCIAL_GROUPS = ["OC", "SOC", "SF", "SOSF"];

  // Airtable ROUND: half away from zero, negative precision rounds to tens.
  function atRound(x, p) {
    const f = Math.pow(10, p);
    const v = Math.abs(x) * f;
    const r = Math.round(v + 1e-9) / f;
    return x < 0 ? -r : r;
  }

  function norm(s) { return String(s == null ? "" : s).trim().toLowerCase(); }

  function unitOf(s) {
    const t = norm(s);
    if (!t) return null;
    if (/m2|m²|sqm|sq\.? ?m(\b|et)|metre|meter/.test(t)) return "m2";
    if (/ft|sq\.? ?f|feet|foot|sf\b/.test(t)) return "ft2";
    return null;
  }

  function propertyOf(s) {
    const t = norm(s);
    if (!t || t === "c") return "Commercial";
    if (t === "r" || t.startsWith("res")) return "Residential";
    if (t === "m" || t === "mf" || t.startsWith("multi")) return "Multi Family";
    if (t.startsWith("manu")) return "Manufacturing";
    if (t.startsWith("com")) return "Commercial";
    return null;
  }

  function letterFor(priceType, property) {
    if (COMMERCIAL_GROUPS.includes(priceType)) return "C";
    if (property === "Commercial" || property === "Manufacturing") return "C";
    if (property === "Residential") return "R";
    if (property === "Multi Family") return "M";
    return "C";
  }

  function clientDiscount(c, quoteDate, priceType) {
    if (!c) return 0;
    if (c.cs && quoteDate >= new Date(c.cs)) return Number(c.dn || 0);
    return (/VACA/.test(priceType) ? 0 : Number(c.d1 || 0)) + Number(c.d2 || 0) + Number(c.d3 || 0);
  }

  function clientPriceType(c, quoteDate, size) {
    if (!c || !c.pt) return { pt: "SF", defaulted: !c };
    let pt = c.pt;
    if (c.cs && quoteDate >= new Date(c.cs)) pt = c.po || c.pt;
    else if (/QUALCO/.test(c.pt) && size > 300) pt = "SF";
    return { pt, defaulted: false };
  }

  /* Core quote. All inputs already resolved:
   * { region, priceType, property, unit, size, discount, customMin, internal, convert }
   * Returns { ok, code, range, rate, currency, band, sizeUsed, unitUsed, reason } */
  function quoteResolved(snap, q) {
    const letterBase = letterFor(q.priceType, q.property);
    const wantGBP = q.region === "UK" && q.unit === "m2";
    const letter = letterBase + (wantGBP ? "GBP" : "");
    const pool = snap.bands.filter(b => b.cc === q.region && b.pt === q.priceType && b.l === letter);
    if (!pool.length) return { ok: false, reason: `No ${q.region} pricebook for price type ${q.priceType} / ${letter}.` };
    const hits = [];
    for (const b of pool) {
      let s = q.size, u = q.unit;
      if (q.convert !== false && b.unit && u && b.unit !== u) {
        s = u === "m2" ? q.size * SQFT_PER_SQM : q.size / SQFT_PER_SQM;
        s = Math.round(s);
        u = b.unit;
      }
      if (b.min <= s && s <= b.max) hits.push({ b, s, u });
    }
    if (hits.length === 0) return { ok: false, reason: `Size is outside every ${q.region}${q.priceType}${letter} band.` };
    if (hits.length > 1) return { ok: false, reason: `Ambiguous: ${hits.length} bands match (${hits.map(h => h.b.code).join(", ")}).` };
    const { b, s, u } = hits[0];
    const code = q.region + q.priceType + letter + b.tier;
    const min = q.customMin ? q.customMin : b.min;
    const p = Number(b.p || 0), r = Number(b.r || 0);
    const disc = Number(q.discount || 0);
    let rate;
    if (q.internal) rate = 0;
    else if (/SF/.test(q.priceType)) {
      const raw = (q.property === "Residential" && !code.endsWith("L")) ? p : (s - (min - 1)) * r + p;
      rate = atRound(raw * (1 - disc), b.rd != null && b.rd !== "" ? Number(b.rd) : 2);
    } else {
      let raw;
      if (/POV/.test(q.priceType)) {
        raw = s > (min - 1) ? Math.ceil((s - (min - 1)) / (b.pov || 1)) * r + (min - 1) * p : p * s;
      } else if (q.property === "Residential" && code.endsWith("L")) raw = (s - 6000) * r + p;
      else if (q.property === "Residential") raw = p;
      else raw = (s - (min - 1)) * r + p;
      rate = raw * (1 - (code === "CUSTOM" ? 0 : disc));
      rate = Math.round(rate * 100) / 100;
    }
    return { ok: true, code, range: b.lab, rate, currency: b.cur, band: b, sizeUsed: s, unitUsed: u, converted: u !== q.unit };
  }

  function findCountry(snap, s) {
    const t = norm(s);
    if (!t) return null;
    const alias = { us: "USA", "u.s.": "USA", "united states": "USA", america: "USA", "u.k.": "UK", "united kingdom": "UK", gb: "UK", "great britain": "UK", england: "UK", uae: "UAE", "united arab emirates": "UAE", ca: "Canada", "canada cad": "Canada (CAD)", nz: "New Zealand", au: "Australia", hk: "Hong Kong", sg: "Singapore", jp: "Japan", de: "Germany", fr: "France", es: "Spain", it: "Italy", nl: "Netherlands", ch: "Switzerland", ie: "Ireland", in: "India", kr: "South Korea", korea: "South Korea", mx: "Mexico", br: "Brazil" };
    const target = norm(alias[t] || s);
    return snap.countries.find(c => norm(c.n) === target) || snap.countries.find(c => norm(c.n).startsWith(target)) || null;
  }

  function findClient(snap, s) {
    const t = norm(s);
    if (!t) return null;
    const exact = snap.clients.find(c => norm(c.n) === t);
    if (exact) return exact;
    const starts = snap.clients.filter(c => norm(c.n).startsWith(t));
    if (starts.length === 1) return starts[0];
    const inc = snap.clients.filter(c => norm(c.n).includes(t));
    if (inc.length === 1) return inc[0];
    return null;
  }

  function clientCandidates(snap, s) {
    const t = norm(s);
    return t ? snap.clients.filter(c => norm(c.n).includes(t)).slice(0, 8).map(c => c.n) : [];
  }

  /* User-facing quote from raw inputs. Applies the defaults:
   * country → USA, price type → SF, property → Commercial, unit → ft2. */
  function quote(snap, raw, opts) {
    const notes = [];
    const quoteDate = (opts && opts.date) || new Date();
    const size = Number(String(raw.size == null ? "" : raw.size).replace(/,/g, "").trim());
    let country = findCountry(snap, raw.country);
    if (!raw.country) { country = findCountry(snap, "USA"); notes.push("Country defaulted to US"); }
    else if (!country) return { ok: false, reason: `Unknown country "${raw.country}".`, notes };
    if (!country.c) return { ok: false, reason: `${country.n} has no pricing region in Country Data.`, notes };
    if (country.n === "Canada") notes.push("Canada prices on the US/USD book; ask for Canada (CAD) for the CAD book");
    let unit = unitOf(raw.unit);
    if (!raw.unit) { unit = "ft2"; }
    else if (!unit) return { ok: false, reason: `Unknown area unit "${raw.unit}".`, notes };
    let property = propertyOf(raw.property);
    if (!raw.property) notes.push("Property type defaulted to Commercial");
    else if (!property) return { ok: false, reason: `Unknown property type "${raw.property}".`, notes };
    let client = null;
    if (raw.client) {
      client = findClient(snap, raw.client);
      if (!client) {
        const c = clientCandidates(snap, raw.client);
        return { ok: false, reason: c.length ? `"${raw.client}" matches several clients: ${c.join(", ")}.` : `No active MP Client matches "${raw.client}".`, notes };
      }
    }
    if (!(size > 0)) return { ok: false, reason: "Size is missing or not a number.", notes };
    const ptr = clientPriceType(client, quoteDate, size);
    if (ptr.defaulted) notes.push("Price type defaulted to SF (no MP Client)");
    const res = quoteResolved(snap, {
      region: country.c, priceType: ptr.pt, property, unit, size,
      discount: clientDiscount(client, quoteDate, ptr.pt),
      customMin: client && client.cm, internal: client && /MATTERPORT INTERNAL/i.test(client.n),
      convert: true
    });
    res.notes = notes;
    res.input = { country: country.n, region: country.c, unit, property, client: client ? client.n : null, priceType: ptr.pt, size };
    if (res.ok && res.converted) notes.push(`Converted ${size.toLocaleString()} ${unit} to ${res.sizeUsed.toLocaleString()} ${res.unitUsed} for this pricebook`);
    return res;
  }

  /* Rule-based chat parser. Pulls size+unit, country, property and client out of free text. */
  function parseRequest(snap, text) {
    const out = {};
    let t = " " + String(text || "") + " ";
    const m = t.match(/(\d[\d,]*(?:\.\d+)?)\s*(k\b)?\s*(sq\.?\s*ft|sqft|square\s*feet|square\s*foot|ft2|ft²|sf\b|sq\.?\s*m(?:et(?:er|re)s?)?|sqm|square\s*met(?:er|re)s?|m2|m²)?/i);
    if (m) {
      let n = Number(m[1].replace(/,/g, ""));
      if (m[2]) n *= 1000;
      out.size = n;
      if (m[3]) out.unit = unitOf(m[3]);
    }
    if (/\bresidential\b|\bhome\b|\bhouse\b|\bapartment\b|\bcondo\b/i.test(t)) out.property = "Residential";
    else if (/multi[\s-]?family/i.test(t)) out.property = "Multi Family";
    else if (/manufactur/i.test(t)) out.property = "Manufacturing";
    else if (/commercial|office|retail|warehouse|store/i.test(t)) out.property = "Commercial";
    const lower = t.toLowerCase();
    // Longest client name contained in the text wins.
    let best = null;
    for (const c of snap.clients) { const n = c.n.toLowerCase(); if (n.length > 2 && lower.includes(n) && (!best || n.length > best.length)) best = n, out.client = c.n; }
    if (!out.client) {
      const fm = t.match(/\bfor\s+([A-Za-z0-9&'().\- ]{2,40}?)(?=\s+(?:in|at|located|with|,|$)|[,.?!]|\s*$)/i);
      if (fm) out.client = fm[1].trim();
    }
    let bestC = null;
    for (const c of snap.countries) { const n = c.n.toLowerCase(); if (/deprecated|somewhere/.test(n)) continue; const re = new RegExp("\\b" + n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b"); if (re.test(lower) && (!bestC || n.length > bestC.length)) bestC = n, out.country = c.n; }
    if (!out.country) {
      const cities = { toronto: "Canada", vancouver: "Canada", montreal: "Canada", calgary: "Canada", london: "UK", manchester: "UK", paris: "France", berlin: "Germany", munich: "Germany", madrid: "Spain", sydney: "Australia", melbourne: "Australia", singapore: "Singapore", tokyo: "Japan", dubai: "UAE", "hong kong": "Hong Kong", zurich: "Switzerland", geneva: "Switzerland", amsterdam: "Netherlands", dublin: "Ireland", "tel aviv": "Israel", mumbai: "India", seoul: "South Korea" };
      for (const k in cities) if (lower.includes(k)) { out.country = cities[k]; break; }
      if (!out.country && /\b(usa|u\.s\.|united states)\b/.test(lower)) out.country = "USA";
      if (!out.country && /\b(uk|united kingdom)\b/.test(lower)) out.country = "UK";
    }
    return out;
  }

  const API = { quote, quoteResolved, parseRequest, findClient, findCountry, letterFor, atRound, unitOf, propertyOf };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.JRC = API;
})(typeof window !== "undefined" ? window : globalThis);
