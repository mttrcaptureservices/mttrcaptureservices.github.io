#!/usr/bin/env node
const fs = require('fs');
const https = require('https');
const path = require('path');

const JIRA_EMAIL = process.env.JIRA_EMAIL || 'rguzman@costar.com';
const JIRA_TOKEN = process.env.JIRA_API_TOKEN;
const ASSIGNEE_ID = '6138f20b70405d0068f806c0';
const SKIP = ['idea', 'on hold', 'on-hold'];

function jiraPost(body) {
  const auth = Buffer.from(JIRA_EMAIL + ':' + JIRA_TOKEN).toString('base64');
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'matterport.atlassian.net',
      path: '/rest/api/3/search',
      method: 'POST',
      headers: { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/json', 'Accept': 'application/json' }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

async function fetchJira(jql) {
  const r = await jiraPost({ jql, fields: ['summary','status','priority','issuetype','updated','assignee'], maxResults: 50 });
  if (r.errorMessages) throw new Error(r.errorMessages.join(', '));
  return (r.issues || []).filter(i => !SKIP.includes((i.fields.status?.name||'').toLowerCase()));
}

function isToday(d) { return new Date(d).toDateString() === new Date().toDateString(); }

function label(d) {
  const now = new Date(), date = new Date(d);
  if (date.toDateString() === now.toDateString()) return { l: date.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:'America/Los_Angeles'}), today: true };
  const diff = Math.floor((now-date)/86400000);
  return { l: diff===1?'yesterday':diff<7?diff+'d ago':date.toLocaleDateString('en-US',{month:'numeric',day:'numeric'}), today: false };
}

function statusBadge(s) {
  const sl=(s||'').toLowerCase();
  if(sl.includes('progress')) return ['badge-inprogress','In Progress'];
  if(sl.includes('testing')) return ['badge-testing','In Testing'];
  return ['badge-todo','To Do'];
}

function sortIssues(arr) {
  return arr.sort((a,b) => {
    const pa=(a.fields.priority?.name||'').toLowerCase(), pb=(b.fields.priority?.name||'').toLowerCase();
    const ua=['p0','p1','critical','blocker'].some(x=>pa.includes(x))?1:0;
    const ub=['p0','p1','critical','blocker'].some(x=>pb.includes(x))?1:0;
    if(ua!==ub) return ub-ua;
    return new Date(b.fields.updated)-new Date(a.fields.updated);
  });
}

function card(issue) {
  const f=issue.fields, t=label(f.updated||'');
  const [sCls,sLabel]=statusBadge(f.status?.name);
  const type=f.issuetype?.name||'Task', epic=type.toLowerCase().includes('epic');
  const prio=f.priority?.name||'', urgent=['p0','p1','critical','blocker'].some(x=>prio.toLowerCase().includes(x));
  const isMe=f.assignee?.accountId===ASSIGNEE_ID;
  return `<a class="issue-card${urgent?' urgent-card':''}" href="https://matterport.atlassian.net/browse/${issue.key}" target="_blank">
    <div class="issue-icon ${epic?'icon-epic':'icon-task'}">${epic?'⚡':'📋'}</div>
    <div class="issue-body">
      <div class="issue-top"><span class="issue-key">${issue.key}</span><span class="issue-summary">${f.summary||''}</span></div>
      <div class="issue-meta">
        ${urgent?'<span class="badge badge-p1">🔴 '+prio+'</span>':''}
        <span class="badge ${sCls}">${sLabel}</span>
        <span class="badge ${epic?'badge-epic':'badge-task'}">${type}</span>
        ${!isMe?'<span class="issue-assignee">→ '+f.assignee?.displayName+'</span>':''}
        <span class="updated-time${t.today?' updated-today':''}">${t.today?'⚡ ':''}${t.l}</span>
      </div>
    </div></a>`;
}

function section(title, items) {
  if(!items.length) return '';
  return `<div class="section"><div class="section-header"><span class="section-title">${title}</span><span class="section-badge">${items.length}</span></div>${items.map(card).join('')}</div>`;
}

function threadCard(t) {
  const jira=t.jiraKey?`<a class="badge badge-jira-link" href="https://matterport.atlassian.net/browse/${t.jiraKey}" target="_blank" onclick="event.stopPropagation()" style="text-decoration:none">${t.jiraKey} ↗</a>`:'';
  return `<div class="thread-card" onclick="window.open('${t.url}','_blank')">
    <div class="thread-avatar" style="background:${t.color}">${t.initials}</div>
    <div class="issue-body">
      <div class="issue-top"><span style="font-size:13px;font-weight:600">${t.author}</span></div>
      <div style="font-size:13px;color:#3c3c43;margin-bottom:6px;line-height:1.4">${t.summary}</div>
      <div class="issue-meta"><span class="badge ${t.statusCls}">${t.status}</span>${jira}<span class="updated-time">${t.date}</span><span style="font-size:11px;color:#6e6e73">🤖 ${t.note}</span></div>
    </div></div>`;
}

async function main() {
  console.log('Fetching Jira...');
  const [mine, team] = await Promise.all([
    fetchJira('assignee = "'+ASSIGNEE_ID+'" AND statusCategory != Done AND updated >= -90d ORDER BY updated DESC'),
    fetchJira('project = COP AND updated >= -7d AND statusCategory != Done AND assignee != "'+ASSIGNEE_ID+'" ORDER BY updated DESC')
  ]);

  const seen = new Set(mine.map(i=>i.key));
  const teamOnly = team.filter(i=>!seen.has(i.key));

  const todayItems   = sortIssues(mine.filter(i=>isToday(i.fields.updated)));
  const activeItems  = sortIssues(mine.filter(i=>!isToday(i.fields.updated)&&(i.fields.status?.name||'').toLowerCase().includes('progress')));
  const testingItems = sortIssues(mine.filter(i=>!isToday(i.fields.updated)&&(i.fields.status?.name||'').toLowerCase().includes('testing')));
  const todoItems    = sortIssues(mine.filter(i=>{ const s=(i.fields.status?.name||'').toLowerCase(); return !isToday(i.fields.updated)&&!s.includes('progress')&&!s.includes('testing'); }));

  let threadsData = { lastUpdated: new Date().toISOString(), threads: [] };
  const tp = path.join(__dirname, '..', 'threads.json');
  if (fs.existsSync(tp)) threadsData = JSON.parse(fs.readFileSync(tp,'utf8'));
  const threads = threadsData.threads || [];
  const clarkDate = new Date(threadsData.lastUpdated).toLocaleDateString('en-US',{month:'numeric',day:'numeric',year:'numeric'});

  const now = new Date();
  const snapshotDate = now.toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric',timeZone:'America/Los_Angeles'});
  const refreshTime = now.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:'America/Los_Angeles'})+' PT';

  let body = section('⚡ Updated Today', todayItems);
  body += section('🔄 In Progress', activeItems);
  body += section('🧪 In Testing', testingItems);
  body += section('📌 To Do / Backlog', todoItems);
  if(teamOnly.length) body += '<div class="divider"></div>'+section('👥 Team · COP (7 days)', sortIssues(teamOnly));
  body += `<div class="divider"></div><div class="section"><div class="section-header"><span class="section-title">👀 Pending Teams Threads</span><span class="section-badge">${threads.length}</span><span style="font-size:11px;color:#aeaeb2;margin-left:4px">· via Clark · ${clarkDate}</span></div>${threads.length?threads.map(threadCard).join(''):'<div class="empty">No pending threads.</div>'}</div>`;

  const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Needs Your Attention – Ricardo</title>
<style>
:root{color-scheme:light}*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f7;color:#1d1d1f;font-size:14px;line-height:1.5;padding:20px}
.header{display:flex;align-items:center;justify-content:space-between;margin-bottom:4px}
.header h1{font-size:20px;font-weight:700}
.subtitle{font-size:13px;color:#6e6e73;margin-bottom:4px}
.refresh-info{font-size:11px;color:#aeaeb2;margin-bottom:14px}
.source-row{display:flex;align-items:center;gap:6px;margin-bottom:14px;flex-wrap:wrap}
.source-chip{background:#fff;border:1px solid #e5e5ea;border-radius:20px;padding:4px 12px;font-size:12px;color:#6e6e73;display:flex;align-items:center;gap:5px}
.source-dot{width:7px;height:7px;border-radius:50%;background:#007aff}
.source-dot.green{background:#34c759}.source-dot.orange{background:#ff9500}
.teams-chip{background:#ede6ff;color:#5856d6;border-radius:20px;padding:4px 10px;font-size:12px;display:flex;align-items:center;gap:4px}
.section{margin-bottom:20px}
.section-header{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.section-title{font-size:13px;font-weight:600;color:#6e6e73;text-transform:uppercase;letter-spacing:.5px}
.section-badge{background:#e5e5ea;color:#6e6e73;border-radius:10px;padding:1px 7px;font-size:11px;font-weight:600}
.issue-card{background:#fff;border-radius:10px;padding:14px 16px;margin-bottom:8px;border:1px solid #e5e5ea;cursor:pointer;display:flex;align-items:flex-start;gap:12px;text-decoration:none;color:inherit;transition:all .15s}
.issue-card:hover{border-color:#007aff;box-shadow:0 2px 8px rgba(0,122,255,.12)}
.issue-card.urgent-card{border-left:3px solid #ff3b30}
.issue-icon{width:28px;height:28px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0;margin-top:1px}
.icon-task{background:#e3f0ff}.icon-epic{background:#f0e6ff}
.issue-body{flex:1;min-width:0}
.issue-top{display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap}
.issue-key{font-size:12px;font-weight:600;color:#007aff;white-space:nowrap}
.issue-summary{font-size:14px;font-weight:500;color:#1d1d1f}
.issue-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.issue-assignee{font-size:11px;color:#6e6e73}
.badge{border-radius:5px;padding:2px 8px;font-size:11px;font-weight:600;white-space:nowrap}
.badge-todo{background:#e8f0ff;color:#0055cc}
.badge-inprogress{background:#fff4e0;color:#b35900}
.badge-testing{background:#e6f9ed;color:#1a7a45}
.badge-p1{background:#ffe5e5;color:#cc0000}
.badge-epic{background:#ede6ff;color:#5500cc}
.badge-task{background:#e8f4ff;color:#0066aa}
.badge-investigating{background:#f5f0ff;color:#5500cc}
.badge-fix-deployed{background:#e6f9ed;color:#1a7a45}
.badge-jira-link{background:#e8f0ff;color:#0055cc}
.badge-waiting{background:#fff4e0;color:#b35900}
.updated-time{font-size:11px;color:#aeaeb2;white-space:nowrap}
.updated-today{color:#ff6b00;font-weight:600}
.divider{height:1px;background:#e5e5ea;margin:4px 0 12px}
.thread-card{background:#fff;border-radius:10px;padding:14px 16px;margin-bottom:8px;border:1px solid #e5e5ea;border-left:3px solid #5856d6;cursor:pointer;display:flex;align-items:flex-start;gap:12px;transition:all .15s}
.thread-card:hover{border-color:#5856d6;box-shadow:0 2px 8px rgba(88,86,214,.12)}
.thread-avatar{width:28px;height:28px;border-radius:50%;color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;margin-top:1px}
.empty{background:#fff;border:1px solid #e5e5ea;border-radius:10px;padding:16px;color:#6e6e73;text-align:center}
</style>
</head>
<body>
<div class="header"><h1>Needs Your Attention</h1></div>
<div class="subtitle">${snapshotDate}</div>
<div class="refresh-info">🔄 Auto-refreshed every 30 min Mon–Fri · Last updated: ${refreshTime} · Jira live · Teams via Clark</div>
<div class="source-row">
<div class="source-chip"><div class="source-dot"></div> Jira · Matterport</div>
<div class="source-chip"><div class="source-dot green"></div> Assigned to you</div>
<div class="source-chip"><div class="source-dot orange"></div> Team (COP · 7d)</div>
<div class="teams-chip">👀 Teams · Clark</div>
</div>
${body}
</body>
</html>`;

  fs.writeFileSync(path.join(__dirname,'..','attention-dashboard.html'), HTML, 'utf8');
  console.log('Done! '+mine.length+' assigned, '+teamOnly.length+' team, '+threads.length+' threads');
}

main().catch(e=>{ console.error('Failed:', e.message); process.exit(1); });
