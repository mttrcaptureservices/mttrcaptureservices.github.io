// Nightly snapshot: reads Airtable, trims to what the calculator needs, encrypts it,
// and writes job-rate/data/jrc.enc.json.
//
// Env:
//   AIRTABLE_TOKEN  read-only personal access token (scopes: data.records:read on Parent Base)
//   CALC_USERS      one line per user:  email,saltBase64,keyBase64   (made by job-rate/enroll.html)
//   OUT             output path (default job-rate/data/jrc.enc.json)
//   LOCAL_SNAPSHOT  optional path to an already-built plain snapshot JSON (testing only)
const fs = require("fs");
const path = require("path");
const { webcrypto: crypto } = require("crypto");
const { transform, F } = require("./transform.js");

const BASE = "appT5E3pJK2FE6cwB";
const TABLES = {
  pricebook: { id: "tblvLTsoDdvi9uVTr", fields: [F.code, F.lab, F.min, F.max, F.price, F.rate, F.round, F.ptype, F.cc, F.letter, F.tier, F.cur, F.pov] },
  clients: { id: "tblRW3zlWQm1w4H3S", fields: [F.cName, F.cPt, F.cPo, F.cStart, F.cD1, F.cD2, F.cD3, F.cDn, F.cMin, F.cStatus] },
  countries: { id: "tblx4O2tk0P1Jlx7b", fields: [F.kName, F.kCode] },
};
const ITER = 600000;

async function fetchAll(token, t) {
  const out = [];
  let offset;
  do {
    const u = new URL(`https://api.airtable.com/v0/${BASE}/${t.id}`);
    u.searchParams.set("pageSize", "100");
    u.searchParams.set("returnFieldsByFieldId", "true");
    t.fields.forEach(f => u.searchParams.append("fields[]", f));
    if (offset) u.searchParams.set("offset", offset);
    const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`Airtable ${t.id} ${r.status}: ${await r.text()}`);
    const j = await r.json();
    out.push(...j.records);
    offset = j.offset;
  } while (offset);
  return out;
}

const b64 = buf => Buffer.from(buf).toString("base64");
const unb64 = s => new Uint8Array(Buffer.from(s, "base64"));

async function sha256hex(s) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Buffer.from(h).toString("hex");
}

async function encrypt(snapshot, usersText) {
  const users = usersText.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  if (!users.length) throw new Error("CALC_USERS is empty — enrol at least one user.");
  const dataKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const rawDataKey = new Uint8Array(await crypto.subtle.exportKey("raw", dataKey));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, dataKey, new TextEncoder().encode(JSON.stringify(snapshot)));
  const env = {};
  for (const line of users) {
    const [email, salt, kek] = line.split(",").map(s => s.trim());
    if (!email || !salt || !kek) throw new Error(`Bad CALC_USERS line for "${email || "?"}"`);
    const k = await crypto.subtle.importKey("raw", unb64(kek), "AES-GCM", false, ["encrypt"]);
    const wiv = crypto.getRandomValues(new Uint8Array(12));
    const wk = await crypto.subtle.encrypt({ name: "AES-GCM", iv: wiv }, k, rawDataKey);
    env[await sha256hex(email.toLowerCase())] = { salt, iv: b64(wiv), wk: b64(wk) };
  }
  return { v: 1, generatedAt: snapshot.generatedAt, iter: ITER, iv: b64(iv), ct: b64(ct), users: env };
}

(async () => {
  let snap;
  if (process.env.LOCAL_SNAPSHOT) snap = JSON.parse(fs.readFileSync(process.env.LOCAL_SNAPSHOT));
  else {
    const token = process.env.AIRTABLE_TOKEN;
    if (!token) throw new Error("AIRTABLE_TOKEN is not set.");
    const [p, c, k] = await Promise.all([fetchAll(token, TABLES.pricebook), fetchAll(token, TABLES.clients), fetchAll(token, TABLES.countries)]);
    snap = transform(p, c, k);
    if (snap.bands.length < 1000 || snap.clients.length < 50 || snap.countries.length < 20)
      throw new Error(`Snapshot looks incomplete (${snap.bands.length} bands, ${snap.clients.length} clients, ${snap.countries.length} countries); not publishing.`);
  }
  const out = process.env.OUT || "job-rate/data/jrc.enc.json";
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(await encrypt(snap, process.env.CALC_USERS || "")));
  console.log(`Wrote ${out}: ${snap.bands.length} bands, ${snap.clients.length} clients, ${snap.countries.length} countries.`);
})().catch(e => { console.error(e.message); process.exit(1); });
