#!/usr/bin/env node
/**
 * Capture Services Dashboard — Airtable -> static data.json builder
 *
 * Pulls records from the GLOBAL Airtable table ("AT Quarterly Performance" view),
 * aggregates them into compact buckets, and writes capture-services/data.json for
 * the static dashboard (mttrcaptureservices.github.io/capture-services/) to
 * consume client-side.
 *
 * Requires: AIRTABLE_TOKEN env var (Airtable Personal Access Token with read
 * access to base appGPiaxVj615p7EP). Node 18+ (uses built-in fetch).
 *
 * Two-tier bucketing, mirroring the source Excel/Google-Sheet formulas exactly:
 *  - `cube` / `reqCube`: keyed by client (+ year/month/region/status) — used when
 *    the dashboard's MP Client filter is set to a specific client.
 *  - `globalCube` / `globalReqCube`: keyed WITHOUT a client dimension, with their
 *    own independent Job-ID dedup — used for the "All Clients" (unfiltered) view.
 *    This matters because a true "no client filter" unique-Job-ID count is NOT
 *    the same as summing already-per-client-deduped counts (the same Job ID can
 *    appear under slightly different client-string values). The original
 *    spreadsheet's GLOBAL formulas run their own unfiltered UNIQUE(FILTER(...))
 *    rather than summing the per-client breakdowns, so this replicates that.
 *
 * See project memory "capture-services-dashboard-data-model" for the full
 * formula-to-field mapping this script implements.
 */

import fs from 'fs';

const BASE_ID = 'appGPiaxVj615p7EP';
const TABLE_ID = 'tblSJTugOUJZBbBaN'; // GLOBAL
const VIEW_ID = 'viw2z6hlI0ASSIL12'; // Interface Month Year - Quarterly Performance (AT Quarterly Performance)

const FIELDS = [
  'MP Client',
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

      const compCube = new Map(); // per-client: c|y|m|r|s
      const globalCube = new Map(); // no client dim: y|m|r|s
      const reqCube = new Map(); // per-client: c|y|m|r
      const globalReqCube = new Map(); // no client dim: y|m|r
      const clientYear = new Map(); // c|y (Top 10 support)
      const fySet = new Set();

      for (const rec of records) {
        const f = rec.fields;
        const client = (f['MP Client'] || 'Unknown').trim();
        const c = clientIdx(client);
        const region = regionBucket(f['Sync Source_Derived'], f['Region_Derived']);
        const status = statusCode(f['Interface Reporting Status']);
        const y = f['Interface Reporting Year'];
        const m = f['Interface Reporting Month'];
        const usd = typeof f['USD'] === 'number' ? f['USD'] : 0;
        const cost = typeof f['CT Rate USD'] === 'number' ? f['CT Rate USD'] : 0;
        const jobId = f['Job ID'] || null;
        const csatScore = f['CSAT - Satisfaction of Service'];
        const csatHigh = f['CSAT - Service Score'];

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
              () => ({ y, m, r: rg, s: status, rev: 0, cost: 0, jobIds: new Set(), models: 0, csatResp: 0, csatHigh: 0, csatSum: 0 }),
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
        }
      }

      function cubeOut(map, hasClient) {
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
            csatResp: b.csatResp,
            csatHigh: b.csatHigh,
            csatSum: round2(b.csatSum),
          };
          if (hasClient) o.c = b.c;
          return o;
        });
      }
      function reqCubeOut(map, hasClient) {
        return Array.from(map.values()).map((b) => {
          const o = { y: b.y, m: b.m, r: b.r, req: b.req.size, comp: b.comp.size };
          if (hasClient) o.c = b.c;
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

      const clients = Array.from(clientIndex.keys());
      const fiscalYears = Array.from(fySet).sort((a, b) => a - b);

      const out = {
        generatedAt: new Date().toISOString(),
        sourceRecordCount: records.length,
        fiscalYears,
        clients,
        cube: cubeOut(compCube, true),
        globalCube: cubeOut(globalCube, false),
        reqCube: reqCubeOut(reqCube, true),
        globalReqCube: reqCubeOut(globalReqCube, false),
        clientYear: clientYearOut,
      };

      const outPath = 'capture-services/data.json';
      fs.mkdirSync('capture-services', { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(out));
      console.error(
        `Wrote ${outPath} — ${clients.length} clients, ${fiscalYears.length} fiscal years, ` +
          `${out.cube.length} per-client buckets, ${out.globalCube.length} global buckets.`
      );
    })
    .catch((err) => {
      console.error('Build failed:', err);
      process.exit(1);
    });
}

main();
