#!/usr/bin/env node
/**
 * Capture Services Dashboard — CT Issues section data builder
 *
 * Writes `capture-services/ct-issues.json`, consumed client-side by
 * capture-services/ctissues.html (the 4th dashboard section).
 *
 * DELIBERATELY STANDALONE. It does NOT touch build-capture-services-data.mjs or
 * capture-services/data.json — the three existing dashboards keep their exact
 * pipeline and numbers. Add this as a second step in the same GitHub Action.
 *
 * Requires: AIRTABLE_TOKEN (PAT with read access to BOTH appm03zXsTZJvY9vY and
 * appGPiaxVj615p7EP). Node 18+ (built-in fetch).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS DOESN'T COME FROM THE GLOBAL REPORTING TABLE
 * ---------------------------------------------------------------------------
 * Verified 2026-08-23 against appGPiaxVj615p7EP / tblSJTugOUJZBbBaN (135,377
 * records):
 *   - There is NO CT/QA Issues field on that table at all.
 *   - The CT-attribution Job Status choices are effectively unused there:
 *     "Cancelled by CT" = 4 records, "CT ALT" = 2, "CT Outreach" = 1,
 *     "CT Declined"/"CT Unavailable"/"CT Negotiations" = 0.
 *   - Even on those records, `Interface Reporting Year` / `Month` are
 *     structurally BLANK, because the `Interface Reporting Status` formula only
 *     emits Complete/Work In Progress for a whitelist of statuses that excludes
 *     every CT-* status — and Year/Month are gated on that formula.
 * So CT-presented issues cannot be counted, dated, or trended from the
 * reporting table. The authoritative source is the CT Issue Log, per the
 * `capture-services-airtable-expert` skill.
 *
 * ---------------------------------------------------------------------------
 * SOURCE OF TRUTH: the CT Issue Log
 * ---------------------------------------------------------------------------
 * appm03zXsTZJvY9vY (Capture Technician Directory) / tbl8zsiBhxBvuW8vS.
 * Governing rule from the skill: ONE ROW = ONE CT ASSIGNMENT. Two rows for the
 * same job are correct when the technician differs.
 *
 * Technician identity: `{CT Name}` (updated 2026-08-24, was `{Scheduling
 * City}`). Ricardo added `CT Name` directly on the CT Issue Log table — a
 * lookup through `{Scheduling City}` (the linked-record identity field) into
 * `Global Scheduling/Ops`'s `Main POC` field. `{Scheduling City}`'s own
 * primary-field value is an encoded string ("Seattle, WA - 005 - Pro3" —
 * city + sequence + tier), not a person's name, and the same technician can
 * appear under several such encoded strings. `CT Name` collapses that back to
 * one real name per technician (verified 2026-08-24: 70-71 distinct
 * technicians via CT Name across 229 rows, all populated, vs. more distinct
 * values under the old Scheduling-City-primary-field approach) — this also
 * brings this page's technician dimension much closer to `Vendor Name` on the
 * Technician dashboard, though the two still are not a guaranteed 1:1 tie
 * (different source tables, no cross-check performed).
 *
 * Metric contract this script honours (all from the skill's "metric definitions
 * — get these right" section):
 *   - Row counts are ASSIGNMENTS. Distinct jobs is a separate, smaller number
 *     and is emitted separately. The page labels both explicitly.
 *   - Dedupe, if ever needed, is on {Assignment Signature} — NEVER on
 *     {Parent Base Record ID}, whose repeats are legitimate history.
 *   - {CT Issue} is sparse (43 of 226 rows) and MUTABLE — it is overwritten in
 *     place by Flow B, so the log holds CURRENT state, not history. It is
 *     therefore never charted as a time series.
 *   - {Job Status} on a log row is the status AT THE MOMENT THAT ASSIGNMENT WAS
 *     RECORDED, not the job's current status.
 *   - `Created` is when the row was LOGGED, not when the event happened. Rows
 *     created during the log's initial-load window are flagged `seed:true` and
 *     excluded from the month trend (see SEED_CUTOFF).
 *
 * ---------------------------------------------------------------------------
 * ENRICHMENT JOIN (best-effort, reported honestly)
 * ---------------------------------------------------------------------------
 * Each log row's Job ID is looked up in the GLOBAL reporting table in batched
 * filterByFormula requests (~8 requests for ~190 distinct job IDs) purely to
 * attach region / MP Client / CT rate / capture size. Notes:
 *   - Every matched Job ID returns 2+ GLOBAL rows (parent + per-unit children),
 *     so we keep only the parent (Floor/Unit/Suite === "Parent Record", falling
 *     back to Parent-Child? === "No" — the v4.2-verified rule).
 *   - Vacasa Job IDs in the log use a `VAC105 - <20 digits>` shape that does not
 *     exist in GLOBAL (which uses `VAC105-MMDDYY#####-####`). Those will not
 *     match. Unmatched counts are published in `coverage` and surfaced on the
 *     page rather than hidden.
 *   - The join is for CONTEXT ONLY. No headline KPI depends on it; region is
 *     presented as "matched jobs only" wherever it appears.
 */

import fs from 'fs';

// Read lazily inside main() rather than at module load, so this file can be
// imported by a test harness without a token present.
const token = () => process.env.AIRTABLE_TOKEN;

// ---------------------------------------------------------------------------
// CT Issue Log — base/table/field IDs are authoritative, from the
// capture-services-airtable-expert skill (re-verified via get_table_schema
// 2026-08-23). Field IDs are used (returnFieldsByFieldId=true) rather than
// names, because the same concept is named differently across the two bases
// ("CT/QA Issues" in the parent base vs "CT Issue" here) and IDs can't drift.
// ---------------------------------------------------------------------------
const LOG_BASE = 'appm03zXsTZJvY9vY';
const LOG_TABLE = 'tbl8zsiBhxBvuW8vS';
const LF = {
  parentRecordId: 'fldSRR1eBFjaFcejC',
  schedulingCity: 'fldwzgAc3XT28ZQlu', // linked record — kept for context/debugging only, NOT used for technician identity anymore
  techCityAssignment: 'fldnuc9eHglJKppFZ',
  // multipleLookupValues: Scheduling City -> Global Scheduling/Ops "Main POC".
  // The REST API resolves lookup fields server-side and returns the looked-up
  // value directly (an array of strings for a text lookup) — no second table
  // fetch needed, unlike the old Scheduling-City-link-ID resolution this
  // replaced. THIS is the capture technician's real name and the technician
  // identity on this page.
  ctName: 'fld5QSP3OK8qbfh5z',
  ctIssue: 'fldUDFIuTBozbvSfa', // multipleSelects, sparse + mutable
  jobStatus: 'fldkjSTayP5GWcS3m',
  coordinatorName: 'fldpYrNpMmvQEf6tZ', // free text, comma-joined multi-name
  jobId: 'fldNafX2o3O3trG9Z',
  created: 'fldqrqxmpSeDv37zO',
  signature: 'fldHcjQly483PWnke',
};

// GLOBAL reporting table — same base/table/view the other three dashboards use.
// Fields are referenced BY NAME here (proven to work in
// build-capture-services-data.mjs) since not every name has a published ID.
const REPORT_BASE = 'appGPiaxVj615p7EP';
const REPORT_TABLE = 'tblSJTugOUJZBbBaN';
const REPORT_FIELDS = [
  'Job ID',
  'MP Client',
  'Vendor Name',
  'Sync Source_Derived',
  'Region_Derived',
  'Parent-Child?',
  'Floor/Unit/Suite',
  'CT Rate USD',
  'Job Rate USD',
  'Capture Size - Requested',
];

// ---------------------------------------------------------------------------
// Business rules — confirmed by Ricardo 2026-08-23
// ---------------------------------------------------------------------------

// "CT-caused disruption" headline metric. CT ALT (reassignment) is DELIBERATELY
// excluded: a reassignment is not necessarily the technician's fault. It is
// still reported, in its own card and its own trend series, just never folded
// into the headline. Same for rows whose status is Complete / Cancelled in
// Advance — those exist in the log because a quality issue was recorded after
// the fact, not because the CT dropped the job.
const CT_CAUSED_STATUSES = ['Cancelled by CT', 'CT Declined', 'CT Unavailable'];
const REASSIGNMENT_STATUSES = ['CT ALT'];

// Test / internal / do-not-use technician identities, excluded from every KPI,
// chart and table. The excluded row count is published in `coverage` so the
// page still reconciles to the raw Airtable row count.
export function isTestIdentity(name) {
  if (!name) return false;
  return /^XX\s/i.test(name) || /\bTEST\b/i.test(name) || /\bDNU\b/i.test(name);
}

// The log went live 2026-07-21 and its first rows include a direct backfill of
// jobs that carried CT/QA issues but sat outside Flow A's statuses (the skill
// records 38 such rows, written straight to the directory). Those rows' Created
// timestamps are the BACKFILL date, not the event date, so they are flagged
// `seed:true` and excluded from the month-over-month trend — they still count
// in every total. Adjust this one constant if the seeding window changes.
const SEED_CUTOFF = '2026-07-25T00:00:00.000Z';

// Issue families. Driven by the option-name prefixes actually used in the
// {CT Issue} field, so a newly added option lands in the right family without a
// code change (anything unrecognised falls into 'Other' rather than vanishing).
export function issueFamily(name) {
  if (/^QA:/i.test(name)) return 'Quality';
  if (/^On-site:/i.test(name)) return 'On-site';
  if (/^SLA;/i.test(name)) return 'SLA';
  if (/^CT (Cancellation|Reschedule)$/i.test(name) || /^Reschedule ASAP$/i.test(name)) return 'Scheduling churn';
  return 'Other';
}

// Same region bucketing as build-capture-services-data.mjs v4 (including the
// VACASA re-slice) so a region label means the same thing on all four pages.
export function regionBucket(syncSource, regionDerived) {
  if (syncSource === "Special Op's") return 'SpecOps';
  if (syncSource === 'VACASA') return 'VACASA';
  if (regionDerived === 'EMEA') return 'EMEA';
  if (regionDerived === 'APAC') return 'APAC';
  if (syncSource === 'NORAM' || regionDerived === 'NORAM') return 'NORAM';
  return 'OTHER';
}

// v4.2-verified parent-record rule (see build-capture-services-data.mjs).
export function isParentRecord(parentChild, floorUnitSuite) {
  if (floorUnitSuite === 'Parent Record') return true;
  return parentChild === 'No';
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Cell-shape normalisers
//
// The raw REST API and the Airtable MCP tools return DIFFERENT shapes for the
// same field, and getting this wrong fails silently — every value parses as
// empty, so counts come out as zero rather than throwing:
//
//   field type          REST API                 MCP tools
//   singleSelect        "Cancelled by CT"        {id, name, color}
//   multipleSelects     ["QA: Missing 360s"]     [{id, name, color}]
//   multipleRecordLinks ["recXXXXXXXXXXXXXX"]    [{id, name}]
//
// These helpers accept either, so the builder is correct whichever client is
// used, and a future switch to the MCP tools can't silently zero the dashboard.
// ---------------------------------------------------------------------------
export function selName(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'object' && typeof v.name === 'string') return v.name.trim();
  return '';
}

export function multiNames(v) {
  if (!Array.isArray(v)) return [];
  return v.map(selName).filter(Boolean);
}

// Linked-record cells: return record IDs (REST) resolved through `nameById`, or
// the embedded names (MCP) when they are already present.
export function linkNames(v, nameById) {
  if (!Array.isArray(v)) return [];
  return v
    .map((item) => {
      if (typeof item === 'string') return (nameById.get(item) || '').trim();
      if (item && typeof item === 'object') {
        if (typeof item.name === 'string') return item.name.trim();
        if (typeof item.id === 'string') return (nameById.get(item.id) || '').trim();
      }
      return '';
    })
    .filter(Boolean);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function airtableGet(url) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token()}` } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Airtable API error ${res.status} for ${url}\n${body}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Fetch: CT Issue Log (small — ~226 rows)
// ---------------------------------------------------------------------------
async function fetchIssueLog() {
  const fieldsQS = Object.values(LF)
    .map((f) => 'fields%5B%5D=' + encodeURIComponent(f))
    .join('&');
  const out = [];
  let offset;
  do {
    const url =
      `https://api.airtable.com/v0/${LOG_BASE}/${LOG_TABLE}` +
      `?pageSize=100&returnFieldsByFieldId=true&${fieldsQS}` +
      (offset ? `&offset=${encodeURIComponent(offset)}` : '');
    const data = await airtableGet(url);
    out.push(...data.records);
    offset = data.offset;
    await sleep(210); // stay under Airtable's 5 req/s limit
  } while (offset);
  return out;
}

// ---------------------------------------------------------------------------
// Fetch: enrichment lookup for a set of Job IDs, batched
// ---------------------------------------------------------------------------
const JOIN_BATCH = 20;

async function fetchEnrichment(jobIds) {
  const fieldsQS = REPORT_FIELDS.map((f) => 'fields%5B%5D=' + encodeURIComponent(f)).join('&');
  const byJobId = new Map(); // jobId -> parent record fields
  const ids = Array.from(jobIds);

  for (let i = 0; i < ids.length; i += JOIN_BATCH) {
    const batch = ids.slice(i, i + JOIN_BATCH);
    const formula =
      'OR(' + batch.map((id) => `{Job ID}="${String(id).replace(/"/g, '\\"')}"`).join(',') + ')';
    let offset;
    do {
      const url =
        `https://api.airtable.com/v0/${REPORT_BASE}/${REPORT_TABLE}` +
        `?pageSize=100&${fieldsQS}&filterByFormula=${encodeURIComponent(formula)}` +
        (offset ? `&offset=${encodeURIComponent(offset)}` : '');
      const data = await airtableGet(url);
      for (const rec of data.records) {
        const f = rec.fields;
        const jid = f['Job ID'];
        if (!jid) continue;
        const parent = isParentRecord(f['Parent-Child?'], f['Floor/Unit/Suite']);
        // Prefer the parent row; only fall back to a child row if no parent has
        // been seen for this job (better a region than nothing).
        const existing = byJobId.get(jid);
        if (!existing || (parent && !existing.__parent)) {
          byJobId.set(jid, { ...f, __parent: parent });
        }
      }
      offset = data.offset;
      await sleep(210);
    } while (offset);
    console.error(`  ...enrichment ${Math.min(i + JOIN_BATCH, ids.length)}/${ids.length} job IDs looked up`);
  }
  return byJobId;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
export async function main() {
  if (!token()) {
    console.error('Missing AIRTABLE_TOKEN environment variable.');
    process.exit(1);
  }
  console.error(`Fetching CT Issue Log ${LOG_BASE}/${LOG_TABLE} ...`);
  const raw = await fetchIssueLog();
  console.error(`Fetched ${raw.length} log rows.`);

  const totalRows = raw.length;

  // ---- Parse + filter -----------------------------------------------------
  const excludedTest = [];
  const testIdentities = new Set();
  const parsed = [];

  for (const rec of raw) {
    const f = rec.fields || {};
    const ctNames = multiNames(f[LF.ctName]);
    const tech = ctNames.length ? ctNames[0] : '';
    const status = selName(f[LF.jobStatus]);
    const issues = multiNames(f[LF.ctIssue]);
    const jobId = f[LF.jobId] ? String(f[LF.jobId]).trim() : '';
    const created = f[LF.created] || rec.createdTime || null;
    const signature = f[LF.signature] ? String(f[LF.signature]) : '';
    // Coordinator Name is FREE TEXT holding comma-joined multi-coordinator
    // strings ("Jordan Saiz, Kevin Curtis"), not a collaborator field — so it is
    // split, or one person's work is scattered across several buckets.
    const coordinators = (f[LF.coordinatorName] ? String(f[LF.coordinatorName]) : '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const row = {
      recId: rec.id,
      parentRecId: f[LF.parentRecordId] ? String(f[LF.parentRecordId]) : '',
      tech,
      status,
      issues,
      jobId,
      created,
      signature,
      coordinators,
    };

    if (isTestIdentity(tech)) {
      testIdentities.add(tech);
      excludedTest.push(row);
      continue;
    }
    parsed.push(row);
  }

  console.error(`Excluded ${excludedTest.length} test-identity rows (${testIdentities.size} identities).`);

  // ---- Duplicate-signature audit -----------------------------------------
  // A true duplicate is two rows sharing an Assignment Signature. The last full
  // audit found zero; if one ever appears it is a real defect, so it is surfaced
  // on the page rather than quietly deduped away.
  const sigCounts = new Map();
  for (const r of parsed) {
    if (!r.signature) continue;
    sigCounts.set(r.signature, (sigCounts.get(r.signature) || 0) + 1);
  }
  const duplicateSignatures = Array.from(sigCounts.entries())
    .filter(([, n]) => n > 1)
    .map(([sig, n]) => ({ sig, n }));

  // ---- Enrichment join ----------------------------------------------------
  const jobIds = new Set(parsed.map((r) => r.jobId).filter(Boolean));
  console.error(`Looking up ${jobIds.size} distinct Job IDs in ${REPORT_BASE}/${REPORT_TABLE} ...`);
  const enrich = await fetchEnrichment(jobIds);
  const matchedJobs = new Set();
  const unmatchedJobs = [];
  for (const jid of jobIds) {
    if (enrich.has(jid)) matchedJobs.add(jid);
    else unmatchedJobs.push(jid);
  }
  console.error(`Enrichment matched ${matchedJobs.size}/${jobIds.size} job IDs.`);

  // ---- Index tables -------------------------------------------------------
  const techIndex = new Map();
  const coordIndex = new Map();
  const statusIndex = new Map();
  const issueIndex = new Map();
  const clientIndex = new Map();
  const idxOf = (map, key) => {
    if (!map.has(key)) map.set(key, map.size);
    return map.get(key);
  };

  const seedCutoffMs = Date.parse(SEED_CUTOFF);
  let seededRows = 0;
  let logStart = null;
  let logEnd = null;

  const rows = parsed.map((r) => {
    const d = r.created ? new Date(r.created) : null;
    const valid = d && !isNaN(d.getTime());
    if (valid) {
      if (!logStart || d < logStart) logStart = d;
      if (!logEnd || d > logEnd) logEnd = d;
    }
    const seed = valid ? d.getTime() < seedCutoffMs : false;
    if (seed) seededRows += 1;

    const e = r.jobId ? enrich.get(r.jobId) : null;
    const region = e ? regionBucket(e['Sync Source_Derived'], e['Region_Derived']) : null;
    const clientName = e && e['MP Client'] ? String(e['MP Client']).trim() : null;

    return {
      j: r.jobId,                                  // Job ID (verbatim)
      pr: r.parentRecId,                           // Parent Base Record ID
      t: idxOf(techIndex, r.tech || 'Unassigned'), // technician = CT Name (lookup: Scheduling City -> Main POC)
      st: idxOf(statusIndex, r.status || 'Unknown'),
      co: r.coordinators.map((c) => idxOf(coordIndex, c)),
      iss: r.issues.map((i) => idxOf(issueIndex, i)),
      y: valid ? d.getUTCFullYear() : null,        // LOG year  (not event year)
      m: valid ? d.getUTCMonth() + 1 : null,       // LOG month (not event month)
      d: valid ? d.toISOString() : null,
      seed,                                        // logged during initial load
      rg: region,                                  // enrichment only — may be null
      cl: clientName === null ? null : idxOf(clientIndex, clientName),
      ctRate: e && typeof e['CT Rate USD'] === 'number' ? round2(e['CT Rate USD']) : null,
      jobRate: e && typeof e['Job Rate USD'] === 'number' ? round2(e['Job Rate USD']) : null,
      size: e && typeof e['Capture Size - Requested'] === 'number' ? e['Capture Size - Requested'] : null,
    };
  });

  // -------------------------------------------------------------------------
  // Sanity gate.
  //
  // A field-shape mismatch (see the normalisers above) does NOT throw — it
  // parses every cell as empty and produces a dashboard of confident-looking
  // zeros. That shipped once. These assertions make that failure loud: better a
  // red build than a page telling Ricardo there were no CT cancellations.
  // -------------------------------------------------------------------------
  const problems = [];
  if (rows.length) {
    const unknownStatus = rows.filter((r) => statusIndex.size && Array.from(statusIndex.keys())[r.st] === 'Unknown').length;
    if (unknownStatus / rows.length > 0.5) {
      problems.push(`${unknownStatus}/${rows.length} rows have no Job Status — the Job Status cell shape is probably not what the parser expects`);
    }
    if (rows.length > 20 && techIndex.size < 2) {
      problems.push(`only ${techIndex.size} distinct technician(s) across ${rows.length} rows — the CT Name lookup is probably failing`);
    }
    const unassigned = rows.filter((r) => Array.from(techIndex.keys())[r.t] === 'Unassigned').length;
    if (unassigned / rows.length > 0.5) {
      problems.push(`${unassigned}/${rows.length} rows have no technician — the CT Name lookup is probably failing`);
    }
    const ctCaused = rows.filter((r) => CT_CAUSED_STATUSES.includes(Array.from(statusIndex.keys())[r.st])).length;
    const reassign = rows.filter((r) => REASSIGNMENT_STATUSES.includes(Array.from(statusIndex.keys())[r.st])).length;
    if (ctCaused === 0 && reassign === 0) {
      problems.push('no row matched any CT-caused or reassignment status — status names are probably not being read correctly');
    }
  }
  if (problems.length) {
    console.error('\nSANITY CHECK FAILED — refusing to write ct-issues.json:');
    problems.forEach((p) => console.error('  - ' + p));
    console.error('\nThe existing ct-issues.json (if any) is left untouched.');
    process.exit(1);
  }

  const years = Array.from(new Set(rows.map((r) => r.y).filter((y) => y !== null))).sort((a, b) => a - b);

  const out = {
    generatedAt: new Date().toISOString(),
    source: {
      base: LOG_BASE,
      table: LOG_TABLE,
      label: 'CT Issue Log (Capture Technician Directory)',
      url: `https://airtable.com/${LOG_BASE}/${LOG_TABLE}`,
    },
    rules: {
      ctCausedStatuses: CT_CAUSED_STATUSES,
      reassignmentStatuses: REASSIGNMENT_STATUSES,
      seedCutoff: SEED_CUTOFF,
      grain: 'one row = one CT assignment',
      timeAxis: 'row Created (when logged), not when the event happened',
    },
    coverage: {
      totalRows,
      includedRows: rows.length,
      excludedTestRows: excludedTest.length,
      testIdentities: Array.from(testIdentities).sort(),
      seededRows,
      logStart: logStart ? logStart.toISOString() : null,
      logEnd: logEnd ? logEnd.toISOString() : null,
      distinctJobs: jobIds.size,
      distinctParentRecords: new Set(parsed.map((r) => r.parentRecId).filter(Boolean)).size,
      distinctTechnicians: new Set(parsed.map((r) => r.tech).filter(Boolean)).size,
      joinMatchedJobs: matchedJobs.size,
      joinUnmatchedJobs: unmatchedJobs.length,
      unmatchedSample: unmatchedJobs.slice(0, 12),
      duplicateSignatures,
    },
    technicians: Array.from(techIndex.keys()),
    coordinators: Array.from(coordIndex.keys()),
    statuses: Array.from(statusIndex.keys()),
    issueTypes: Array.from(issueIndex.keys()),
    issueFamilies: Array.from(issueIndex.keys()).map((n) => issueFamily(n)),
    clients: Array.from(clientIndex.keys()),
    years,
    rows,
  };

  fs.mkdirSync('capture-services', { recursive: true });
  const outPath = 'capture-services/ct-issues.json';
  fs.writeFileSync(outPath, JSON.stringify(out));
  console.error(
    `Wrote ${outPath} — ${rows.length} rows in scope (${excludedTest.length} test rows excluded), ` +
      `${techIndex.size} technicians, ${issueIndex.size} issue types, ` +
      `${matchedJobs.size}/${jobIds.size} job IDs enriched, ${duplicateSignatures.length} duplicate signatures.`
  );
}

// Only run when executed directly (`node build-ct-issues-data.mjs`), so a test
// harness can import the pure helpers and drive main() with a mocked fetch.
const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error('Build failed:', err);
    process.exit(1);
  });
}
