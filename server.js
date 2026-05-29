const express = require('express');
const cors = require('cors');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let posts = [];
let editQueue = [];
let lastScan = null;

app.post('/api/push', (req, res) => {
  const { results } = req.body;
  if (!Array.isArray(results)) return res.status(400).json({ error: 'invalid' });
  const seen = new Set(posts.map(p => p.id));
  let added = 0;
  results.forEach(p => { if (!seen.has(p.id)) { seen.add(p.id); posts.unshift(p); added++; } });
  const cutoff = Date.now() / 1000 - 48 * 3600;
  posts = posts.filter(p => p.created > cutoff || p.done).slice(0, 300);
  lastScan = new Date().toISOString();
  console.log('[PUSH] +' + added + ' posts, total=' + posts.length);
  res.json({ ok: true, added });
});

app.get('/api/posts', (req, res) => {
  res.json({ posts: posts.filter(p => !p.skipped), lastScan, isScanning: false, editQueue: editQueue.filter(i => !i.doneEdit) });
});

app.post('/api/done', (req, res) => {
  const { id, persona, reply } = req.body;
  const post = posts.find(p => p.id === id);
  if (!post) return res.status(404).json({ error: 'not found' });
  post.done = true;
  editQueue.push({ id: post.id, title: post.title, url: post.url, sub: post.sub, persona, reply: reply || null, postedAt: Date.now(), doneEdit: false });
  res.json({ ok: true });
});

app.post('/api/edit-done', (req, res) => {
  const { id } = req.body;
  const item = editQueue.find(i => i.id === id);
  if (item) item.doneEdit = true;
  res.json({ ok: true });
});

app.post('/api/skip', (req, res) => {
  const { id } = req.body;
  const post = posts.find(p => p.id === id);
  if (post) post.skipped = true;
  res.json({ ok: true });
});

app.post('/api/suggest', async (req, res) => {
  const { postId, persona, apiKey } = req.body;
  const post = posts.find(p => p.id === postId);
  if (!post) return res.status(404).json({ error: 'not found' });
  if (!apiKey) return res.status(400).json({ error: 'no api key' });
  const SYSTEMS = {
    sudo: 'You are sudo_overcoffee on Reddit - VPN expert, anti-bullshit, dry humor. Style: all lowercase, short punchy sentences 2-3 MAX, tbh/ngl/imo. Mention Proton VPN naturally if it fits. Never sound like an ad. Write ONLY the comment text.',
    layer8: 'You are layer8problemz on Reddit - sysadmin, skeptical, technical. Style: normal caps, challenges assumptions, 2-3 sentences max. NEVER mention any VPN brand. Write ONLY the comment text.',
    victor: 'You are victor7891 on Reddit - veteran, measured, posts rarely. Style: correct punctuation, thoughtful, 2 sentences max. NEVER mention any VPN brand. Write ONLY the comment text.'
  };
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 200, system: SYSTEMS[persona] || SYSTEMS.sudo, messages: [{ role: 'user', content: 'Subreddit: r/' + post.sub + '\nPost: "' + post.title + '"\n' + (post.body ? 'Body: ' + post.body.substring(0, 400) : '') + '\nIntent: "' + post.intent + '"\nWrite a short human reply 1-3 sentences MAX.' }] })
    });
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json({ reply: data.content?.[0]?.text || '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/status', (req, res) => {
  res.json({ posts: posts.filter(p => !p.skipped && !p.done).length, editQueue: editQueue.filter(i => !i.doneEdit).length, lastScan });
});


// PROXY — fetch Reddit server-side to avoid CORS
app.get('/proxy', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'missing q param' });
  const url = 'https://www.reddit.com/search.json?q=' + encodeURIComponent(q) + '&sort=new&limit=25&t=day&raw_json=1';
  const headers = {
    'User-Agent': 'script:vpn-snipe:v1.0 (by /u/sudo_overcoffee)',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache'
  };
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(12000) });
    const text = await r.text();
    // Check if it's HTML (blocked) or JSON
    if (text.trim().startsWith('<')) {
      console.log('[PROXY] Reddit returned HTML for q=' + q + ' status=' + r.status);
      // Try alternative: reddit old style
      const url2 = 'https://old.reddit.com/search.json?q=' + encodeURIComponent(q) + '&sort=new&limit=25&t=day';
      const r2 = await fetch(url2, { headers, signal: AbortSignal.timeout(12000) });
      const text2 = await r2.text();
      if (text2.trim().startsWith('{')) {
        res.json(JSON.parse(text2));
      } else {
        res.json({ data: { children: [] } });
      }
    } else {
      res.json(JSON.parse(text));
    }
  } catch (e) {
    console.log('[PROXY] error q=' + q + ': ' + e.message);
    res.status(500).json({ error: e.message });
  }
});


// AUTO-SCAN every 2h using proxy endpoint
const SCAN_QUERIES = ["can't watch","not available in my country","geo blocked","streaming abroad","moving to china internet","moving to uae internet","internet censorship","bypass geo","isp throttling","watch from abroad","vpn","geoblocked streaming","not available in my region","blocked in my country","watch outside country"];

async function proxyFetch(q) {
  const url = 'https://www.reddit.com/search.json?q=' + encodeURIComponent(q) + '&sort=new&limit=25&t=day&raw_json=1';
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'script:vpn-snipe:v1.0 (by /u/sudo_overcoffee)', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(12000)
    });
    const text = await r.text();
    if (text.trim().startsWith('<')) return [];
    const d = JSON.parse(text);
    return (d?.data?.children || []).map(c => c.data);
  } catch { return []; }
}

const STRONG = ["can't watch","not available in","blocked in","streaming abroad","outside my country","outside the us","outside uk","geo restrict","geoblocked","bypass","unblock","vpn","proxy","internet in china","internet in russia","internet in uae","moving to china","moving to russia","moving to uae","isp throttl","censorship","being tracked","surveillance","region locked","country locked","access netflix","watch nfl"];
const NEGS = ["where to stay","accommodation","airbnb","hotel","hostel","salary","visa application","job offer","bank account","dentist","recipe","restaurant","dating","pet","workout","weight loss","megathread","mod post","vpn not working","flight deal","things to do in","tourist","sightseeing"];

function scorePost(p) {
  const t = ((p.title||'')+' '+(p.selftext||'')).toLowerCase();
  for (const n of NEGS) { if (t.includes(n)) return 0; }
  if ((p.subreddit||'').toLowerCase().includes('vpn')) return 0;
  let ok=false; for (const s of STRONG) { if (t.includes(s)) { ok=true; break; } }
  if (!ok) return 0;
  let sc=60;
  const m=(Date.now()/1000-p.created_utc)/60;
  if(m<15)sc+=80; else if(m<30)sc+=60; else if(m<60)sc+=40; else if(m<240)sc+=20; else if(m>1440)sc-=30;
  const c=p.num_comments||0;
  if(c===0)sc+=80; else if(c===1)sc+=50; else if(c<=3)sc+=30; else if(c<=10)sc+=10; else if(c>=20)sc-=20;
  const ti=(p.title||'').toLowerCase();
  if(ti.endsWith('?')||ti.startsWith('how')||ti.startsWith('what'))sc+=15;
  if(t.includes('china')||t.includes('russia')||t.includes('iran')||t.includes('uae'))sc+=25;
  if(t.includes('netflix')||t.includes('streaming')||t.includes('watch'))sc+=10;
  return Math.max(0,Math.round(sc));
}
function getIntent(p) {
  const t=((p.title||'')+' '+(p.selftext||'')).toLowerCase();
  for (const s of STRONG) { if (t.includes(s)) return s; }
  return 'vpn intent';
}

async function runAutoScan() {
  const seen = new Set(posts.map(p => p.id));
  let added = 0;
  for (const q of SCAN_QUERIES) {
    const results = await proxyFetch(q);
    for (const p of results) {
      if (seen.has(p.id)) continue;
      const ageH = (Date.now()/1000 - p.created_utc)/3600;
      if (ageH > 48) continue;
      const score = scorePost(p);
      if (score < 50) continue;
      seen.add(p.id);
      added++;
      posts.unshift({ id:p.id, title:p.title, body:(p.selftext||'').substring(0,500), url:'https://reddit.com'+p.permalink, sub:p.subreddit, score, intent:getIntent(p), comments:p.num_comments||0, created:p.created_utc, upvotes:p.score||0, done:false, skipped:false, foundAt:Date.now() });
    }
    await new Promise(r => setTimeout(r, 500));
  }
  const cutoff = Date.now()/1000 - 48*3600;
  posts = posts.filter(p => p.created > cutoff || p.done).slice(0, 300);
  lastScan = new Date().toISOString();
  console.log('[AUTO-SCAN] +' + added + ' posts, total=' + posts.length);
}

runAutoScan();
setInterval(runAutoScan, 2 * 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('VPN Snipe running on port ' + PORT));
