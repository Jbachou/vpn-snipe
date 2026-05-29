const express = require('express');
const cors = require('cors');
const path = require('path');
const fetch = require('node-fetch');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let posts = [];
let editQueue = [];
let lastScan = null;
let isScanning = false;

const VPN_SIGNALS = [
  "can't watch","cant watch","not available in","blocked in","streaming abroad",
  "bypass","unblock","geoblocked","vpn","proxy","outside my country",
  "outside the us","outside uk","outside the uk","isp throttl","censorship",
  "surveillance","moving to china","moving to russia","moving to uae",
  "region locked","access netflix","watch nfl","watch formula","geo restrict",
  "region block","ip block","unavailable in","watch from abroad",
  "stream abroad","internet restriction","firewall","great firewall",
  "content blocked","not in my country","restricted in",
  "vpn recommendation","vpn suggestions","which vpn","best vpn","free vpn",
  "need a vpn","use a vpn","vpn for","without vpn"
];

const SNIPE_SUBS = [
  'expats','digitalnomad','IWantOut','moving','cordcutters','Piracy',
  'soccer','football','nfl','formula1','cricket','nba',
  'China','dubai','UAE','AskReddit','NoStupidQuestions','YouShouldKnow','LifeProTips'
];

function detectSignals(post) {
  const text = ((post.title || '') + ' ' + (post.selftext || '')).toLowerCase();
  return VPN_SIGNALS.filter(kw => text.includes(kw));
}

function calcScore(post, signals) {
  let score = signals.length * 25;
  const ageMin = (Date.now() - post.created * 1000) / 60000;
  if (ageMin < 15) score += 60;
  else if (ageMin < 30) score += 45;
  else if (ageMin < 60) score += 30;
  else if (ageMin < 120) score += 15;
  else if (ageMin < 360) score += 5;
  if (post.num_comments === 0) score += 50;
  else if (post.num_comments <= 2) score += 30;
  else if (post.num_comments <= 5) score += 15;
  return score;
}

// Fetch Reddit avec plusieurs stratégies
async function fetchSubReddit(sub) {
  const strategies = [
    // Strategy 1: User-Agent Reddit script
    async () => {
      const r = await fetch(`https://www.reddit.com/r/${sub}/new.json?limit=25&raw_json=1`, {
        headers: {
          'User-Agent': 'VPNSnipe/1.0 (Node.js; contact: admin@vpnsnipe.com)',
          'Accept': 'application/json',
        },
        timeout: 8000
      });
      if (r.ok) return r.json();
      console.log(`[S1] r/${sub} status: ${r.status}`);
      throw new Error('status ' + r.status);
    },
    // Strategy 2: old.reddit
    async () => {
      const r = await fetch(`https://old.reddit.com/r/${sub}/new.json?limit=25&raw_json=1`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)', 'Accept': 'application/json' },
        timeout: 8000
      });
      if (r.ok) return r.json();
      throw new Error('old.reddit status ' + r.status);
    },
    // Strategy 3: .json direct avec autre UA
    async () => {
      const r = await fetch(`https://www.reddit.com/r/${sub}.json?limit=25&sort=new`, {
        headers: { 'User-Agent': 'curl/7.79.1', 'Accept': '*/*' },
        timeout: 8000
      });
      if (r.ok) return r.json();
      throw new Error('curl UA status ' + r.status);
    }
  ];

  for (let i = 0; i < strategies.length; i++) {
    try {
      const d = await strategies[i]();
      if (d && d.data && d.data.children) {
        console.log(`[FETCH] r/${sub} ok via strategy ${i+1}, ${d.data.children.length} posts`);
        return d.data.children.map(c => ({ ...c.data, subreddit: sub }));
      }
    } catch(e) {
      console.log(`[FETCH] r/${sub} strategy ${i+1} failed: ${e.message}`);
    }
  }
  return [];
}

// DEBUG: tester le fetch Reddit directement
app.get('/api/test-fetch', async (req, res) => {
  const sub = req.query.sub || 'expats';
  console.log(`[TEST] Testing fetch for r/${sub}`);
  const results = [];
  const ua_list = [
    'VPNSnipe/1.0',
    'Mozilla/5.0 (Windows NT 10.0)',
    'curl/7.79.1',
    'python-requests/2.28.0'
  ];
  for (const ua of ua_list) {
    try {
      const r = await fetch(`https://www.reddit.com/r/${sub}/new.json?limit=3&raw_json=1`, {
        headers: { 'User-Agent': ua, 'Accept': 'application/json' },
        timeout: 6000
      });
      const body = await r.text();
      results.push({ ua, status: r.status, ok: r.ok, preview: body.slice(0, 100) });
    } catch(e) {
      results.push({ ua, error: e.message });
    }
  }
  res.json(results);
});

app.post('/api/push', (req, res) => {
  const { results } = req.body;
  if (!Array.isArray(results)) return res.status(400).json({ error: 'invalid' });
  const seen = new Set(posts.map(p => p.id));
  let added = 0;
  results.forEach(p => { if (!seen.has(p.id)) { seen.add(p.id); posts.unshift(p); added++; } });
  const cutoff = Date.now() / 1000 - 48 * 3600;
  posts = posts.filter(p => p.created > cutoff || p.done).slice(0, 300);
  lastScan = new Date().toISOString();
  res.json({ ok: true, added });
});

app.post('/api/scan', async (req, res) => {
  if (isScanning) return res.json({ ok: false, message: 'already scanning' });
  isScanning = true;
  const subsToScan = req.body.subs || SNIPE_SUBS;
  console.log(`[SCAN] Starting ${subsToScan.length} subs`);
  const allResults = [];
  for (let i = 0; i < subsToScan.length; i += 4) {
    const batch = subsToScan.slice(i, i + 4);
    const batchResults = await Promise.all(batch.map(fetchSubReddit));
    batchResults.forEach(r => allResults.push(...r));
    if (i + 4 < subsToScan.length) await new Promise(r => setTimeout(r, 800));
  }
  const seen = new Set();
  const unique = allResults.filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; });
  const filtered = unique.filter(p => detectSignals(p).length > 0);
  const seen2 = new Set(posts.map(p => p.id));
  let added = 0;
  filtered.forEach(p => {
    if (!seen2.has(p.id)) {
      const signals = detectSignals(p);
      const score = calcScore(p, signals);
      seen2.add(p.id);
      posts.unshift({
        id: p.id, sub: p.subreddit, subreddit: p.subreddit,
        title: p.title, permalink: p.permalink,
        url: 'https://reddit.com' + p.permalink,
        author: p.author, score: p.score, ups: p.score,
        comments: p.num_comments, num_comments: p.num_comments,
        created: p.created, selftext: (p.selftext || '').slice(0, 500),
        opportunityScore: score, matchedKeywords: signals,
        intent: 'vpn_need', skipped: false, done: false
      });
      added++;
    }
  });
  const cutoff = Date.now() / 1000 - 48 * 3600;
  posts = posts.filter(p => p.created > cutoff || p.done).slice(0, 300);
  lastScan = new Date().toISOString();
  isScanning = false;
  console.log(`[SCAN] Done +${added} new, total=${posts.length}, scanned=${unique.length}, signal=${filtered.length}`);
  res.json({ ok: true, added, total: posts.length, scanned: unique.length, vpn_signal: filtered.length });
});

app.get('/api/posts', (req, res) => {
  res.json({ posts: posts.filter(p => !p.skipped), lastScan, isScanning, editQueue: editQueue.filter(i => !i.doneEdit) });
});

app.get('/api/status', (req, res) => {
  res.json({ posts: posts.length, editQueue: editQueue.length, lastScan, isScanning });
});

app.post('/api/skip', (req, res) => {
  const { id } = req.body;
  const p = posts.find(x => x.id === id);
  if (p) p.skipped = true;
  res.json({ ok: true });
});

app.post('/api/done', (req, res) => {
  const { id } = req.body;
  const p = posts.find(x => x.id === id);
  if (p) { p.done = true; p.skipped = true; }
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`VPN Snipe server running on port ${PORT}`));
