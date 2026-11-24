// Backtest: run the engine against real Global Requests records and compare
// price code (and, for SF, the Job Rate 2.0 base) with what Airtable stored.
// Usage: node backtest.js snapshot.json jobs.json
const fs = require("fs");
const E = require("../engine.js");
const snap = JSON.parse(fs.readFileSync(process.argv[2]));
const jobs = JSON.parse(fs.readFileSync(process.argv[3])).records;

const sel = v => (v && typeof v === "object" && !Array.isArray(v) ? v.name : v);
let codeN = 0, codeOK = 0, rateN = 0, rateOK = 0;
const codeFail = {}, rateFail = [];
for (const j of jobs) {
  const c = j.cellValuesByFieldId;
  const stored = (c.fldWnHDfDCBf1lncD || [])[0];
  if (!stored) continue;
  const name = stored.name;
  if (/Refer to|CUSTOM|cancel/i.test(name)) continue;
  const pt = c.fldRanHKS5d1wYaiI;
  if (!pt || /PRO|PERIMETER|AMENITY/.test(pt)) continue; // service suffixes are out of MVP scope
  const unitName = sel(c.fld0WKRHsAbejeRca) || "";
  const unit = /m2|Metre/i.test(unitName) ? "m2" : "ft2";
  const q = {
    region: c.fldL6hbm6ntvrIfZ7, priceType: pt, property: sel(c.fldczvYXmWlt84KTx) || "Commercial",
    unit, size: Number(c.fldGP2ZwdeE0tU8ZJ || 0), discount: Number(c.fldn6wb7ICBUzOrTj || 0),
    customMin: Array.isArray(c.fldms6EdWWxM0mY98) ? c.fldms6EdWWxM0mY98[0] : c.fldms6EdWWxM0mY98,
    internal: /MATTERPORT INTERNAL/i.test(c.fld2p6DsMPNDokRzy || ""),
    convert: false, // Airtable compares the size as entered
  };
  // the UK GBP suffix is keyed on job currency, not region — use the record's currency
  const cur = sel(c.fldUwREpRJdVpvyjE);
  const r = E.quoteResolved(snap, q);
  codeN++;
  const got = r.ok ? r.code : "∅";
  if (got === name) codeOK++;
  else { const k = `${name} vs ${got} (${q.region}/${pt}/${q.property}/${unit}/${cur})`; codeFail[k] = (codeFail[k] || 0) + 1; }
  // rate check: SF only, uncancelled, matching code
  if (r.ok && got === name && /SF/.test(pt) && c.fldFxkCzy4zD5NSTO === 1 && c.fldqGdqTqBWqbjnnm === 1 && typeof c.fld1UtVuEY9QXfa8J === "number") {
    rateN++;
    if (Math.abs(r.rate - c.fld1UtVuEY9QXfa8J) < 0.005) rateOK++;
    else rateFail.push(`${c.fldMvDGkmYLnasOXk} ${name} size ${q.size} disc ${q.discount} cm ${q.customMin}: stored ${c.fld1UtVuEY9QXfa8J} got ${r.rate}`);
  }
}
console.log(`price code: ${codeOK}/${codeN} match`);
console.log(`SF base rate: ${rateOK}/${rateN} match`);
const top = Object.entries(codeFail).sort((a, b) => b[1] - a[1]).slice(0, 25);
for (const [k, n] of top) console.log("  code miss", n, k);
for (const s of rateFail.slice(0, 25)) console.log("  rate miss", s);
