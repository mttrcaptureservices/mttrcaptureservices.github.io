#!/usr/bin/env node
/**
 * Capture Services Dashboard — Airtable -> static data.json builder
 *
 * Pulls records from the GLOBAL Airtable table ("AT Quarterly Performance" view),
 * aggregates them into compact buckets, and writes capture-services/data.json for
 * the static dashboards (mttrcaptureservices.github.io/capture-services/) to
 * consume client-side. Feeds the Client Dashboard (index.html), the Capture
 * Technician Dashboard (technician.html), and the Capture Coordinator Dashboard
 * (coordinator.html) from a single Airtable fetch/pass.
 *
 * Requires: AIRTABLE_TOKEN env var (Airtable Personal Access Token with read
 * access to base appGPiaxVj615p7EP). Node 18+ (uses built-in fetch).
 *
 * Two-tier bucketing, mirroring the source Excel/Google-Sheet formulas exactly:
 *  - `cube` / `reqCube`: keyed by client (+ year/month/region/status) — used when
 *    the Client Dashboard's MP Client filter is set to a specific client.
 *  - `globalCube` / `globalReqCube`: keyed WITHOUT a client dimension, with their
 *    own independent Job-ID dedup — used for the "All Clients" (unfiltered) view,
 *    AND as the "All Technicians"/"All Coordinators" unfiltered view on the other
 *    two dashboards (same underlying GLOBAL-table math; the Excel's own formulas
 *    use identical unfiltered SUMIFS/UNIQUE logic on all tabs when no slicer is set).
 *  - `techCube` / `techReqCube`: keyed by technician (Airtable `Vendor Name` field).
 *  - `coordCube` / `coordReqCube`: keyed by coordinator (Airtable `Coordinator Name`
 *    field, NOT `Capture Coordinator`, which is a different, code-like field).
 *  - `globalCube` additionally carries `ctCsatResp`/`ctCsatSum` (Capture-Tech
 *    satisfaction) and `p2sSum`/`s2cSum` (Coordinator turnaround-time sums).
 *  - `clientYear` / `techYear` / `coordYear`: per-entity per-year revenue or cost,
 *    for each dashboard's Top 10 table.
 *
 * v4 additions (2026-07-14 business-unit feedback round):
 *  - `regionBucket()` now recognizes a 5th region tag, 'VACASA', driven by the
 *    Airtable `Sync Source_Derived` field (which itself already derives "VACASA"
 *    when the raw Sync Source is "Global Parent Base" + the MP Client name
 *    contains "Vacasa", OR when Sync Source is literally "VACASA"). IMPORTANT
 *    caveat: prior to this change, VACASA records were silently falling into the
 *    NORAM bucket (their `Region_Derived` is "NORAM"), so NORAM's totals will
 *    shift down once this ships — GLOBAL ('ALL') totals are unaffected, this is
 *    purely a re-slice of what was already being counted.
 *  - Each cube bucket now also accumulates job-rate/job-size/model-size sums,
 *    read from the `Job Rate USD` and `Capture Size` fields, split by the
 *    Airtable `Parent-Child?` field: a bucket's "parent" records (Parent-Child?
 *    !== 'Yes') carry the per-job billing rate and the job's total capture size;
 *    its "child" records (Parent-Child? === 'Yes') are individual models within
 *    that job, each with their own (usually smaller) capture size. This mirrors
 *    the source workbook's own per-record structure (verified empirically: a
 *    job's parent record holds the full Job Rate USD + total Capture Size, while
 *    each child model record carries its own slice of Capture Size and often a
 *    $0 or repeated Job Rate USD, since billing happens at the job level).
 *  - `reqCube` / `globalReqCube` / `techReqCube` / `coordReqCube` now track a
 *    third bucket, `cancelled` (in addition to the existing `req`/`comp` Job-ID
 *    sets), so the dashboards can show a single ordered-jobs cohort split into
 *    Completed / Cancelled / (residual) In Progress. A job counts as cancelled
 *    only if its raw `Job Status` text matches a cancellation variant (case-
 *    insensitive "cancel") AND it was NOT already counted Complete via the
 *    `Interface Reporting Status` formula — this deliberately excludes "Cancelled
 *    Last Minute" jobs, which the source formula (and this pipeline, unchanged)
 *    still bills/counts as Complete, per Ricardo's explicit call (2026-07-14):
 *    keep that revenue-facing number exactly as it was, don't double-bucket it.
 *
 * v4.1 correction (2026-07-14, same day): "CLM" in the Top 10 tables does NOT
 * mean "total model/deliverable record count" (that was a wrong guess in the
 * original v4 build). Per Ricardo: CLM = "Cancelled Last Minute" — a count of
 * this bucket's/entity's jobs whose raw `Job Status` field is literally
 * "Cancelled Last Minute", deduped by Job ID the exact same way `jobs`/
 * Completed is (NOT a raw record count). Since "Cancelled Last Minute" always
 * maps to Complete status (see above), CLM is always <= Completed for the same
 * slice — e.g. United Healthcare Group FY2026: Completed 652, CLM 29. Tracked
 * via a `clmJobIds` Set alongside `jobIds` on every cube bucket and every
 * clientYear/techYear/coordYear entry, output as `clm`.
 *
 * This matters because a true "no filter" unique-Job-ID count is NOT the same
 * as summing already-per-client/per-tech-deduped counts (the same Job ID can
 * appear under slightly different client/vendor string values). The original
 * spreadsheet's GLOBAL formulas run their own unfiltered UNIQUE(FILTER(...))
 * rather than summing the per-slice breakdowns, so this replicates that.
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
  'Job Status',
  'Job Rate USD',
  'Capture Size',
  'Parent-Child?',
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
  if (syncSource === 'VACASA') return 'VACASA';
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

function isCancelledJobStatus(jobStatus) {
  return typeof jobStatus === 'string' && /cancel/i.test(jobStatus);
}

function isParentRecord(parentChild) {
  // Airtable "Parent-Child?" field: 'Yes' marks a child/model record nested
  // under a job; 'No' (or blank, treated the same) marks the parent/job-level
  // record that carries the true per-job billing rate and total capture size.
  return parentChild !== 'Yes';
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
      const globalCube = new Map(); // no client/tech/coord dim: y|m|r|s (also carries ctCsat*, p2sSum/s2cSum, jobRate*/jobSize*/modelSize*)
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

      const cubeFactory = (extra) => ({
        rev: 0,
        cost: 0,
        jobIds: new Set(),
        models: 0,
        jobRateSum: 0,
        jobRateCount: 0,
        jobSizeSum: 0,
        jobSizeCount: 0,
        modelSizeSum: 0,
        modelSizeCount: 0,
        clmJobIds: new Set(),
        ...extra,
      });

      function applyCubeBase(b, { usd, cost, jobId, isParent, jobRate, captureSize, jobStatus }) {
        b.rev += usd;
        b.cost += cost;
        if (jobId) b.jobIds.add(jobId);
        b.models += 1;
        if (isParent) {
          if (typeof jobRate === 'number') {
            b.jobRateSum += jobRate;
            b.jobRateCount += 1;
          }
          if (typeof captureSize === 'number') {
            b.jobSizeSum += captureSize;
            b.jobSizeCount += 1;
          }
        } else if (typeof captureSize === 'number') {
          b.modelSizeSum += captureSize;
          b.modelSizeCount += 1;
        }
        // "CLM" = Cancelled Last Minute — the dashboards' Top 10 tables show a
        // count of this bucket's jobs whose raw Job Status is literally
        // "Cancelled Last Minute", deduped by Job ID exactly like `jobs`/
        // `Completed` above (NOT a raw record count — corrected 2026-07-14
        // per Ricardo; CLM does not mean "total model/deliverable records").
        if (jobId && jobStatus === 'Cancelled Last Minute') b.clmJobIds.add(jobId);
      }

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
        const jobStatus = f['Job Status'] || null;
        const jobRate = typeof f['Job Rate USD'] === 'number' ? f['Job Rate USD'] : null;
        const captureSize = typeof f['Capture Size'] === 'number' ? f['Capture Size'] : null;
        const isParent = isParentRecord(f['Parent-Child?']);
        const csatScore = f['CSAT - Satisfaction of Service'];
        const csatHigh = f['CSAT - Service Score'];
        const ctCsatScore = f['CSAT - Capture Tech Satisfaction'];
        const p2s = f['Pending to Scheduled (days/hrs)'];
        const s2c = f['Scheduled to Complete (days/hrs)'];

        if (y) fySet.add(y);

        const cubeExtra = { usd, cost, jobId, isParent, jobRate, captureSize, jobStatus };

        if (y && m && status !== 'O') {
          for (const rg of [region, 'ALL']) {
            bump(
              compCube,
              `${c}|${y}|${m}|${rg}|${status}`,
              () => cubeFactory({ c, y, m, r: rg, s: status, csatResp: 0, csatHigh: 0, csatSum: 0 }),
              (b) => {
                applyCubeBase(b, cubeExtra);
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
              () =>
                cubeFactory({
                  y,
                  m,
                  r: rg,
                  s: status,
                  csatResp: 0,
                  csatHigh: 0,
                  csatSum: 0,
                  ctCsatResp: 0,
                  ctCsatSum: 0,
                  p2sSum: 0,
                  s2cSum: 0,
                }),
              (b) => {
                applyCubeBase(b, cubeExtra);
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
                () => cubeFactory({ t, y, m, r: rg, s: status, ctCsatResp: 0, ctCsatSum: 0 }),
                (b) => {
                  applyCubeBase(b, cubeExtra);
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
                () => cubeFactory({ co, y, m, r: rg, s: status, p2sSum: 0, s2cSum: 0 }),
                (b) => {
                  applyCubeBase(b, cubeExtra);
                  if (typeof p2s === 'number') b.p2sSum += p2s;
                  if (typeof s2c === 'number') b.s2cSum += s2c;
                }
              );
            }
          }
        }

        const reqDate = monthFromDateStr(f['Reporting Request Date/Time']);
        if (reqDate) {
          // A record counts as "cancelled" in the ordered cohort only if its raw
          // Job Status says so AND it wasn't already billed/counted as Complete
          // (e.g. "Cancelled Last Minute" stays under Completed only — see header
          // note). This keeps Completed/Cancelled mutually exclusive.
          const cancelled = status !== 'C' && isCancelledJobStatus(jobStatus);
          const reqFactory = () => ({
            req: new Set(),
            comp: new Set(),
            cancelled: new Set(),
            reqModels: 0,
            compModels: 0,
            cancelledModels: 0,
          });
          const applyReq = (b) => {
            if (jobId) {
              b.req.add(jobId);
              if (status === 'C') b.comp.add(jobId);
              if (cancelled) b.cancelled.add(jobId);
            }
            // Model-level (record) counts — deliberately NOT deduped by Job ID,
            // since one job can include multiple model records (see
            // Parent-Child?/Number of Children). Mirrors the "Count of Models"
            // convention used elsewhere in this pipeline (models = raw record
            // count, jobs = unique Job ID count).
            b.reqModels += 1;
            if (status === 'C') b.compModels += 1;
            if (cancelled) b.cancelledModels += 1;
          };
          for (const rg of [region, 'ALL']) {
            bump(reqCube, `${c}|${reqDate.year}|${reqDate.month}|${rg}`, () => ({ c, y: reqDate.year, m: reqDate.month, r: rg, ...reqFactory() }), applyReq);
            bump(globalReqCube, `${reqDate.year}|${reqDate.month}|${rg}`, () => ({ y: reqDate.year, m: reqDate.month, r: rg, ...reqFactory() }), applyReq);
            if (t !== null) {
              bump(techReqCube, `${t}|${reqDate.year}|${reqDate.month}|${rg}`, () => ({ t, y: reqDate.year, m: reqDate.month, r: rg, ...reqFactory() }), applyReq);
            }
            if (co !== null) {
              bump(coordReqCube, `${co}|${reqDate.year}|${reqDate.month}|${rg}`, () => ({ co, y: reqDate.year, m: reqDate.month, r: rg, ...reqFactory() }), applyReq);
            }
          }
          fySet.add(reqDate.year);
        }

        if (y && status === 'C') {
          const isClm = jobId && jobStatus === 'Cancelled Last Minute';
          bump(
            clientYear,
            `${c}|${y}`,
            () => ({ c, y, revenue: 0, jobIds: new Set(), clmJobIds: new Set() }),
            (cy) => {
              cy.revenue += usd;
              if (jobId) cy.jobIds.add(jobId);
              if (isClm) cy.clmJobIds.add(jobId);
            }
          );
          if (t !== null) {
            bump(
              techYear,
              `${t}|${y}`,
              () => ({ t, y, cost: 0, jobIds: new Set(), clmJobIds: new Set() }),
              (ty) => {
                ty.cost += cost;
                if (jobId) ty.jobIds.add(jobId);
                if (isClm) ty.clmJobIds.add(jobId);
              }
            );
          }
          if (co !== null) {
            bump(
              coordYear,
              `${co}|${y}`,
              () => ({ co, y, revenue: 0, jobIds: new Set(), clmJobIds: new Set(), captureSize: 0 }),
              (cy) => {
                cy.revenue += usd;
                if (jobId) cy.jobIds.add(jobId);
                if (isClm) cy.clmJobIds.add(jobId);
                cy.captureSize += typeof f['Capture Size - Requested'] === 'number' ? f['Capture Size - Requested'] : 0;
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
            jrSum: round2(b.jobRateSum),
            jrCnt: b.jobRateCount,
            jsSum: round2(b.jobSizeSum),
            jsCnt: b.jobSizeCount,
            msSum: round2(b.modelSizeSum),
            msCnt: b.modelSizeCount,
            clm: b.clmJobIds.size,
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
          const o = {
            y: b.y,
            m: b.m,
            r: b.r,
            req: b.req.size,
            comp: b.comp.size,
            cancelled: b.cancelled.size,
            reqModels: b.reqModels,
            compModels: b.compModels,
            cancelledModels: b.cancelledModels,
          };
          if (keyName) o[keyName] = b[keyName];
          return o;
        });
      }

      const clientYearOut = Array.from(clientYear.values()).map((cy) => ({
        c: cy.c,
        y: cy.y,
        rev: round2(cy.revenue),
        jobs: cy.jobIds.size,
        clm: cy.clmJobIds.size,
      }));

      const techYearOut = Array.from(techYear.values()).map((ty) => ({
        t: ty.t,
        y: ty.y,
        cost: round2(ty.cost),
        jobs: ty.jobIds.size,
        clm: ty.clmJobIds.size,
      }));

      const coordYearOut = Array.from(coordYear.values()).map((cy) => ({
        co: cy.co,
        y: cy.y,
        rev: round2(cy.revenue),
        jobs: cy.jobIds.size,
        clm: cy.clmJobIds.size,
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
