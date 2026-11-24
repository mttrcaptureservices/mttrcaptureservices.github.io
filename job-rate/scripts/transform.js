// Turns raw Airtable records (cellValuesByFieldId shape OR REST "fields" keyed by field ID)
// into the trimmed pricing snapshot the calculator reads.
const F = {
  // Global PriceBooks tblvLTsoDdvi9uVTr
  code: "fldjdooVmc1bl1TM7", lab: "fldVpUp2h3gRTkHqx", min: "flddc1aXlW4lVjeHP", max: "fldsNNfeszaYaNxb2",
  price: "fldFPD9EtzvGXzivn", rate: "fldWvp3xGeM6CkR1o", round: "fldSwC6U6fQme9xIp", ptype: "fldJfLCdTay0GZmXc",
  cc: "fldbrVURUiYlZSnfV", letter: "fldlyekFFSS7ZWryf", tier: "fldnF6z4W7x8cx0rH", cur: "fldeqM738F4V1Dwrc", pov: "fldJEgl1uEUDuJERa",
  // MP Client Data tblRW3zlWQm1w4H3S
  cName: "fldCwXWEgIrtSSGr7", cPt: "fldVqzc3Ip4QDyKlV", cPo: "fldQNozcHul7MdeNI", cStart: "fldKxumBcyremvdkj",
  cD1: "fldzSvKWCZrFAZ5QY", cD2: "fldg8wSEbxA5A1Ks4", cD3: "fldj0ZjZLzuvIDLET", cDn: "fldT71CiTsdE3klcf",
  cMin: "fldadmcQ3Mah0Yl4E", cStatus: "fldAmvBXwGYQ33j3d",
  // Country Data tblx4O2tk0P1Jlx7b
  kName: "fldKsKSjFLxctZhFW", kCode: "fldv8FPWCjKnWd8dc",
};

const cells = r => r.cellValuesByFieldId || r.fields || {};
const sel = v => (v && typeof v === "object" ? v.name : v);
const num = v => (v === undefined || v === null || v === "" ? undefined : Number(v));

function bandUnit(label) {
  const t = String(label || "").toLowerCase();
  if (/m2|m²|sqm/.test(t)) return "m2";
  if (/ft|sq/.test(t)) return "ft2";
  return null;
}

function transform(pricebook, clients, countries) {
  const bands = [];
  for (const r of pricebook) {
    const c = cells(r);
    if (!c[F.code] || c[F.cc] == null || c[F.min] == null || c[F.max] == null) continue;
    bands.push({
      code: c[F.code], lab: c[F.lab] || "", min: num(c[F.min]), max: num(c[F.max]),
      p: num(c[F.price]) || 0, r: num(c[F.rate]) || 0, rd: c[F.round] == null ? undefined : Number(c[F.round]),
      pt: sel(c[F.ptype]), cc: c[F.cc], l: c[F.letter] || "", tier: c[F.tier] || "",
      cur: sel(c[F.cur]) || "", pov: num(c[F.pov]), unit: bandUnit(c[F.lab]),
    });
  }
  const cl = [];
  for (const r of clients) {
    const c = cells(r);
    if (!c[F.cName] || c[F.cStatus]) continue; // live contracts only (blank Contract Status)
    const o = { n: String(c[F.cName]).trim(), pt: c[F.cPt] ? String(c[F.cPt]).trim() : undefined };
    if (c[F.cPo]) o.po = String(c[F.cPo]).trim();
    if (c[F.cStart]) o.cs = c[F.cStart];
    for (const [k, f] of [["d1", F.cD1], ["d2", F.cD2], ["d3", F.cD3], ["dn", F.cDn], ["cm", F.cMin]]) if (c[f] != null && c[f] !== 0) o[k] = Number(c[f]);
    cl.push(o);
  }
  cl.sort((a, b) => a.n.localeCompare(b.n));
  const ks = [];
  for (const r of countries) {
    const c = cells(r);
    if (c[F.kName]) ks.push({ n: String(c[F.kName]).trim(), c: c[F.kCode] || null });
  }
  ks.sort((a, b) => a.n.localeCompare(b.n));
  return { generatedAt: new Date().toISOString(), bands, clients: cl, countries: ks };
}

module.exports = { transform, F };
