#!/usr/bin/env node
/**
 * Capture Services Dashboard — Airtable -> static data.json builder
 *
 * Pulls records from the GLOBAL Airtable table ("AT Quarterly Performance" view),
 * aggregates them into compact buckets, and writes capture-services/data.json for
 * the static dashboards (mttrcaptureservices.github.io/capture-services/) to
 * consume client-side. Feeds BOTH the Capture Services & Client Dashboard
 * (index.html) and the Capture Technician Dashboard (technician.html) from a
 * single Airtable fetch/pass — adding the technician-sliced cubes below is
 * purely additive (new top-level keys) so index.html's existing behavior is
 * unaffected.
 *
 * Requires: AIRTABLE_TOKEN env var (Airtable Personal Access Token with read
 * access to base appGPiaxVj615p7EP). Node 18+ (uses built-in fetch).
 *
 * Two-tier bucketing, mirroring the source Excel/Google-Sheet formulas exactly:
 *  - `cube` / `reqCube`: keyed by client (+ year/month/region/status) — used when
 *    the Client Dashboard's MP Client filter is set to a specific client.
 *  - `globalCube` / `globalReqCube`: keyed WITHOUT a client dimension, with their
 *    own independent Job-ID dedup — used for the "All Clients" (unfiltered) view,
 *    AND as the "All Technicians" unfiltered view on the Technician Dashboard
 *    (same underlying GLOBAL-table math; the Excel's own formulas use identical
 *    unfiltered SUMIFS/UNIQUE logic on both tabs when no slicer is set).
 *  - `techCube` / `techReqCube`: keyed by technician (+ year/month/region/status)
 *    — used when the Technician Dashboard's Capture Technician filter is set to
 *    a specific person. Mirrors `cube`/`reqCube` exactly, just keyed by the
 *    Airtable `Vendor Name` field instead of `MP Client`.
 *  - `coordCube` / `coordReqCube`: keyed by coordinator (+ year/month/region/status)
 *    — used when the Coordinator Dashboard's Capture Coordinator filter is set
 *    to a specific person. Mirrors `cube`/`reqCube`, keyed by the Airtable
 *    `Coordinator Name` field (NOT `Capture Coordinator`, which is a different,
 *    code-like field — verified `Coordinator Name` is the one holding
 *    human-readable first names matching the source workbook's Top 10 list).
 *  - `globalCube` additionally carries `ctCsatResp`/`ctCsatSum` (Capture-Tech
 *    satisfaction, field `CSAT - Capture Tech Satisfaction`) so the Technician
 *    Dashboard's CSAT card can read it from the SAME bucket used for
 *    revenue/jobs/models, rather than a duplicate structure. It also carries
 *    `p2sSum`/`s2cSum` (sums of `Pending to Scheduled (days/hrs)` and
 *    `Scheduled to Complete (days/hrs)`) for the Coordinator Dashboard's two
 *    turnaround-time KPIs in its "All Coordinators" unfiltered view — divide
 *    by the bucket's own `models` count to get the workbook's "X.XX days" figure.
 *  - `clientYear`: per-client per-year revenue/jobs/clm, for the Client
 *    Dashboard's Top 10 Clients by Revenue table.
 *  - `techYear`: per-technician per-year cost/jobs/clm, for the Technician
 *    Dashboard's Top 10 Technicians by Cost table.
 *  - `coordYear`: per-coordinator per-year revenue/jobs/clm/captureSize, for the
 *    Coordinator Dashboard's Top 10 Coordinators by Revenue table (also shows
 *    summed `Capture Size - Requested`).
 *
 * This matters because a true "no filter" unique-Job-ID count is NOT the same
 * as summing already-per-client/per-tech-deduped counts (the same Job ID can
 * appear under slightly different client/vendor string values). The original
 * spreadsheet's GLOBAL formulas run their own unfiltered UNIQUE(FILTER(...))
 * rather than summing the per-slice breakdowns, so this replicates that.
 *
 * See project memory "capture-services-dashboard-data-model" for the full
 * formula-to-field mapping this script implements (tab 1 + tab 2).
 */

import fs from 'fs';

const BASE_ID = 'appGPiaxVj615p7EP';
const TABLE_ID = 'tblSJTugOUJZBbBaN'; // GLOBAL
const VIEW_ID = 'viw2z6hlI0ASSIL12'; // Interface Month Year - Quarterly Performance (AT Quarterly Performance)

const FIELDS = [
  'MP Client',
  'Vendor Name',
  'Coordinator Name',
  'Sync Source_Derived',
  'Region_Derived',
  'USD',
  'CT Rate USD',
  'Interface Reporting Status',
  'Interface Reporting Month',
  'Interface Reporting Year',
  'Reporting Request Date/Time',
  'Job ID',
  'CSAT - Satisfaction of Service',
  'CSAT - Service Score',
  'CSAT - Capture Tech Satisfaction',
  'Capture Size - Requested',
  'Pending to Scheduled (days/hrs)',
  'Scheduled to Complete (days/hrs)',
];

const TOKEN = process.env.AIRTABLE_TOKEN;
if (!TOKEN) {
  console.error('Missing AIRTABLE_TOKEN environment variable.');
  process.exit(1);
}

function regionBucket(syncSource, regionDerived) {
  if (syncSource === "Special Op's") return 'SpecOps';
  if (regionDerived === 'EMEA') return 'EMEA';
  if (regionDerived === 'APAC') return 'APAC';
  if (syncSource === 'NORAM' || regionDerived === 'NORAM') return 'NORAM';
  return 'OTHER';
}

function statusCode(status) {
  if (status === 'Complete') return 'C';
  if (status === 'Work In Progress') return 'W';
  return 'O';
}

function monthFromDateStr(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

async function fetchAllRecords() {
  const records = new Map(); // dedupe by record id, defensively
  let offset;
  let page = 0;
  const fieldsQS = FIELDS.map((f) => 'fields%5B%5D=' + encodeURIComponent(f)).join('&');
  do {
    const url =
      `https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}?view=${VIEW_ID}&pageSize=100&${fieldsQS}` +
      (offset ? `&offset=${offset}` : '');
    const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Airtable API error ${res.status}: ${body}`);
    }
    const data = await res.json();
    for (const r of data.records) records.set(r.id, r);
    offset = data.offset;
    page += 1;
    if (page % 20 === 0) console.error(`  ...${records.size} records fetched (page ${page})`);
    await new Promise((r) => setTimeout(r, 210)); // stay under Airtable's 5 req/s limit
  } while (offset);
  return Array.from(records.values());
}

function bump(map, key, factory, apply) {
  let b = map.get(key);
  if (!b) {
    b = factory();
    map.set(key, b);
  }
  apply(b);
}

function main() {
  console.error(`Fetching records from Airtable base ${BASE_ID} / table ${TABLE_ID} / view ${VIEW_ID} ...`);
  fetchAllRecords()
    .then((records) => {
      console.error(`Fetched ${records.length} unique records. Aggregating...`);

      const clientIndex = new Map();
      function clientIdx(name) {
        const key = (name || 'Unknown').trim();
        if (!clientIndex.has(key)) clientIndex.set(key, clientIndex.size);
        return clientIndex.get(key);
      }

      const techIndex = new Map();
      function techIdx(name) {
        const key = (name || 'Unknown').trim();
        if (!techIndex.has(key)) techIndex.set(key, techIndex.size);
        return techIndex.get(key);
      }

      const coordIndex = new Map();
      function coordIdx(name) {
        const key = (name || 'Unknown').trim();
        if (!coordIndex.has(key)) coordIndex.set(key, coordIndex.size);
        return coordIndex.get(key);
      }

      const compCube = new Map(); // per-client: c|y|m|r|s
      const globalCube = new Map(); // no client/tech/coord dim: y|m|r|s (also carries ctCsat*, p2sSum/s2cSum)
      const reqCube = new Map(); // per-client: c|y|m|r
      const globalReqCube = new Map(); // no client dim: y|m|r
      const clientYear = new Map(); // c|y (Top 10 Clients support)

      const techCube = new Map(); // per-technician: t|y|m|r|s
      const techReqCube = new Map(); // per-technician: t|y|m|r
      const techYear = new Map(); // t|y (Top 10 Technicians support)

      const coordCube = new Map(); // per-coordinator: co|y|m|r|s
      const coordReqCube = new Map(); // per-coordinator: co|y|m|r
      const coordYear = new Map(); // co|y (Top 10 Coordinators support)

      const fySet = new Set();

      for (const rec of records) {
        const f = rec.fields;
        const client = (f['MP Client'] || 'Unknown').trim();
        const c = clientIdx(client);
        const vendor = f['Vendor Name'] ? f['Vendor Name'].trim() : null;
        const t = vendor ? techIdx(vendor) : null;
        const coordName = f['Coordinator Name'] ? f['Coordinator Name'].trim() : null;
        const co = coordName ? coordIdx(coordName) : null;
        const region = regionBucket(f['Sync Source_Derived'], f['Region_Derived']);
        const status = statusCode(f['Interface Reporting Status']);
        const y = f['Interface Reporting Year'];
        const m = f['Interface Reporting Month'];
        const usd = typeof f['USD'] === 'number' ? f['USD'] : 0;
        const cost = typeof f['CT Rate USD'] === 'number' ? f['CT Rate USD'] : 0;
        const jobId = f['Job ID'] || null;
        const csatScore = f['CSAT - Satisfaction of Service'];
        const csatHigh = f['CSAT - Service Score'];
        const ctCsatScore = f['CSAT - Capture Tech Satisfaction'];
        const captureSize = typeof f['Capture Size - Requested'] === 'number' ? f['Capture Size - Requested'] : 0;
        const p2s = f['Pending to Scheduled (days/hrs)'];
        const s2c = f['Scheduled to Complete (days/hrs)'];

        if (y) fySet.add(y);

        if (y && m && status !== 'O') {
          for (const rg of [region, 'ALL']) {
            bump(
              compCube,
              `${c}|${y}|${m}|${rg}|${status}`,
              () => ({ c, y, m, r: rg, s: status, rev: 0, cost: 0, jobIds: new Set(), models: 0, csatResp: 0, csatHigh: 0, csatSum: 0 }),
              (b) => {
                b.rev += usd;
                b.cost += cost;
                if (jobId) b.jobIds.add(jobId);
                b.models += 1;
                if (typeof csatScore === 'number') {
                  b.csatResp += 1;
                  b.csatSum += csatScore;
                  if (typeof csatHigh === 'number') b.csatHigh += csatHigh;
                }
              }
            );
            bump(
              globalCube,
              `${y}|${m}|${rg}|${status}`,
              () => ({
                y,
                m,
                r: rg,
                s: status,
                rev: 0,
                cost: 0,
                jobIds: new Set(),
                models: 0,
                csatResp: 0,
                csatHigh: 0,
                csatSum: 0,
                ctCsatResp: 0,
                ctCsatSum: 0,
                p2sSum: 0,
                s2cSum: 0,
              }),
              (b) => {
                b.rev += usd;
                b.cost += cost;
                if (jobId) b.jobIds.add(jobId);
                b.models += 1;
                if (typeof csatScore === 'number') {
                  b.csatResp += 1;
                  b.csatSum += csatScore;
                  if (typeof csatHigh === 'number') b.csatHigh += csatHigh;
                }
                if (typeof ctCsatScore === 'number') {
                  b.ctCsatResp += 1;
                  b.ctCsatSum += ctCsatScore;
                }
                if (typeof p2s === 'number') b.p2sSum += p2s;
                if (typeof s2c === 'number') b.s2cSum += s2c;
              }
            );
            if (t !== null) {
              // Reuses the SAME `rg` from the outer `for (const rg of [region, 'ALL'])`
              // loop this block lives in — do not add a second nested fan-out loop
              // here, or every technician bucket gets double/quadruple-counted.
              bump(
                techCube,
                `${t}|${y}|${m}|${rg}|${status}`,
                () => ({ t, y, m, r: rg, s: status, rev: 0, cost: 0, jobIds: new Set(), models: 0, ctCsatResp: 0, ctCsatSum: 0 }),
                (b) => {
                  b.rev += usd;
                  b.cost += cost;
                  if (jobId) b.jobIds.add(jobId);
                  b.models += 1;
                  if (typeof ctCsatScore === 'number') {
                    b.ctCsatResp += 1;
                    b.ctCsatSum += ctCsatScore;
                  }
                }
              );
            }
            if (co !== null) {
              // Same fan-out reuse note as the technician block above.
              bump(
                coordCube,
                `${co}|${y}|${m}|${rg}|${status}`,
                () => ({ co, y, m, r: rg, s: status, rev: 0, cost: 0, jobIds: new Set(), models: 0, p2sSum: 0, s2cSum: 0 }),
                (b) => {
                  b.rev += usd;
                  b.cost += cost;
                  if (jobId) b.jobIds.add(jobId);
                  b.models += 1;
                  if (typeof p2s === 'number') b.p2sSum += p2s;
                  if (typeof s2c === 'number') b.s2cSum += s2c;
                }
              );
            }
          }
        }

        const reqDate = monthFromDateStr(f['Reporting Request Date/Time']);
        if (reqDate && jobId) {
          for (const rg of [region, 'ALL']) {
            bump(
              reqCube,
              `${c}|${reqDate.year}|${reqDate.month}|${rg}`,
              () => ({ c, y: reqDate.year, m: reqDate.month, r: rg, req: new Set(), comp: new Set() }),
              (b) => {
                b.req.add(jobId);
                if (status === 'C') b.comp.add(jobId);
              }
            );
            bump(
              globalReqCube,
              `${reqDate.year}|${reqDate.month}|${rg}`,
              () => ({ y: reqDate.year, m: reqDate.month, r: rg, req: new Set(), comp: new Set() }),
              (b) => {
                b.req.add(jobId);
                if (status === 'C') b.comp.add(jobId);
              }
            );
            if (t !== null) {
              bump(
                techReqCube,
                `${t}|${reqDate.year}|${reqDate.month}|${rg}`,
                () => ({ t, y: reqDate.year, m: reqDate.month, r: rg, req: new Set(), comp: new Set() }),
                (b) => {
                  b.req.add(jobId);
                  if (status === 'C') b.comp.add(jobId);
                }
              );
            }
            if (co !== null) {
              bump(
                coordReqCube,
                `${co}|${reqDate.year}|${reqDate.month}|${rg}`,
                () => ({ co, y: reqDate.year, m: reqDate.month, r: rg, req: new Set(), comp: new Set() }),
                (b) => {
                  b.req.add(jobId);
                  if (status === 'C') b.comp.add(jobId);
                }
              );
            }
          }
          fySet.add(reqDate.year);
        }

        if (y && status === 'C') {
          bump(
            clientYear,
            `${c}|${y}`,
            () => ({ c, y, revenue: 0, jobIds: new Set(), clm: 0 }),
            (cy) => {
              cy.revenue += usd;
              if (jobId) cy.jobIds.add(jobId);
              cy.clm += 1;
            }
          );
          if (t !== null) {
            bump(
              techYear,
              `${t}|${y}`,
              () => ({ t, y, cost: 0, jobIds: new Set(), clm: 0 }),
              (ty) => {
                ty.cost += cost;
                if (jobId) ty.jobIds.add(jobId);
                ty.clm += 1;
              }
            );
          }
          if (co !== null) {
            bump(
              coordYear,
              `${co}|${y}`,
              () => ({ co, y, revenue: 0, jobIds: new Set(), clm: 0, captureSize: 0 }),
              (cy) => {
                cy.revenue += usd;
                if (jobId) cy.jobIds.add(jobId);
                cy.clm += 1;
                cy.captureSize += captureSize;
              }
            );
          }
        }
      }

      function cubeOut(map, keyName) {
        return Array.from(map.values()).map((b) => {
          const o = {
            y: b.y,
            m: b.m,
            r: b.r,
            s: b.s,
            rev: round2(b.rev),
            cost: round2(b.cost),
            jobs: b.jobIds.size,
            models: b.models,
          };
          if ('csatResp' in b) {
            o.csatResp = b.csatResp;
            o.csatHigh = b.csatHigh;
            o.csatSum = round2(b.csatSum);
          }
          if ('ctCsatResp' in b) {
            o.ctCsatResp = b.ctCsatResp;
            o.ctCsatSum = round2(b.ctCsatSum);
          }
          if ('p2sSum' in b) {
            o.p2sSum = round2(b.p2sSum);
            o.s2cSum = round2(b.s2cSum);
          }
          if (keyName) o[keyName] = b[keyName];
          return o;
        });
      }
      function reqCubeOut(map, keyName) {
        return Array.from(map.values()).map((b) => {
          const o = { y: b.y, m: b.m, r: b.r, req: b.req.size, comp: b.comp.size };
          if (keyName) o[keyName] = b[keyName];
          return o;
        });
      }

      const clientYearOut = Array.from(clientYear.values()).map((cy) => ({
        c: cy.c,
        y: cy.y,
        rev: round2(cy.revenue),
        jobs: cy.jobIds.size,
        clm: cy.clm,
      }));

      const techYearOut = Array.from(techYear.values()).map((ty) => ({
        t: ty.t,
        y: ty.y,
        cost: round2(ty.cost),
        jobs: ty.jobIds.size,
        clm: ty.clm,
      }));

      const coordYearOut = Array.from(coordYear.values()).map((cy) => ({
        co: cy.co,
        y: cy.y,
        rev: round2(cy.revenue),
        jobs: cy.jobIds.size,
        clm: cy.clm,
        captureSize: round2(cy.captureSize),
      }));

      const clients = Array.from(clientIndex.keys());
      const technicians = Array.from(techIndex.keys());
      const coordinators = Array.from(coordIndex.keys());
      const fiscalYears = Array.from(fySet).sort((a, b) => a - b);

      const out = {
        generatedAt: new Date().toISOString(),
        sourceRecordCount: records.length,
        fiscalYears,
        clients,
        technicians,
        coordinators,
        cube: cubeOut(compCube, 'c'),
        globalCube: cubeOut(globalCube, null),
        reqCube: reqCubeOut(reqCube, 'c'),
        globalReqCube: reqCubeOut(globalReqCube, null),
        clientYear: clientYearOut,
        techCube: cubeOut(techCube, 't'),
        techReqCube: reqCubeOut(techReqCube, 't'),
        techYear: techYearOut,
        coordCube: cubeOut(coordCube, 'co'),
        coordReqCube: reqCubeOut(coordReqCube, 'co'),
        coordYear: coordYearOut,
      };

      const outPath = 'capture-services/data.json';
      fs.mkdirSync('capture-services', { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(out));
      console.error(
        `Wrote ${outPath} — ${clients.length} clients, ${technicians.length} technicians, ${coordinators.length} coordinators, ${fiscalYears.length} fiscal years, ` +
          `${out.cube.length} per-client buckets, ${out.globalCube.length} global buckets, ${out.techCube.length} per-tech buckets, ${out.coordCube.length} per-coordinator buckets.`
      );
    })
    .catch((err) => {
      console.error('Build failed:', err);
      process.exit(1);
    });
}

main();
