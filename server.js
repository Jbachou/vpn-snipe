const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SCAN_INTERVAL_MS = 2 * 60 * 60 * 1000;
const EDIT_DELAY_DAYS = 7;

const SEARCH_QUERIES = [
  "can't watch",
  "not available in my country",
  "geo blocked",
  "streaming abroad",
  "moving to china internet",
  "moving to uae internet",
  "internet censorship",
  "bypass geo",
  "isp throttling",
  "watch from abroad",
  "vpn",
  "geoblocked streaming",
  "not available in my region",
  "blocked in my country",
  "watch outside country"
];

const STRONG_SIGNALS = [
  "can't watch", "cannot watch", "cant watch",
  "not available in", "not available here",
  "blocked in", "blocked outside",
  "streaming abroad", "stream from abroad",
  "how to watch outside", "watch outside",
  "outside my country", "outside the us", "outside uk", "outside usa",
  "geo restrict", "geoblocked", "geo block", "geo-block",
  "bypass", "unblock",
  "watch abroad", "watch from abroad",
  "vpn", "proxy",
  "internet in china", "internet in russia", "internet in uae", "internet in iran",
  "moving to china", "moving to russia", "moving to uae", "moving to iran",
  "isp throttl", "isp throttling",
  "employer monitor", "work monitor",
  "censorship", "internet censorship",
  "being tracked", "surveillance",
  "not available in my region", "region locked", "country locked",
  "access netflix", "watch nfl", "watch formula",
  "stream from", "watch live from",
  "can i watch", "how do i watch"
];

const NEGATIVES = [
  "where to stay", "accommodation", "airbnb", "hotel", "hostel",
  "cost of living", "salary", "visa application", "applying for",
  "job offer", "job interview", "bank account", "health insurance",
  "dentist", "wedding", "recipe", "restaurant", "food delivery",
  "best place to eat", "relationship advice", "dating", "breakup",
  "pet", "workout", "weight loss", "medication", "megathread",
  "mod post", "weekly thread", "monthly thread",
  "vpn not working", "vpn slow", "cancel subscription",
  "already have a vpn", "my vpn is", "vpn keeps", "vpn stopped",
  "flight deal", "things to do in", "tourist", "sightseeing",
  "itinerary", "must visit", "travel tips for",
  "where should i stay", "best area", "best neighbourhood"
];

let posts = [];
let editQueue = [];
let lastScan = null;
let isScanning = false;
let scanLog = [];

function hasVpnIntent(post) {
  const text = ((post.title || '') + ' ' + (post.selftext || '')).toLowerCase();
  for (const neg of NEGATIVES) { if (text.includes(neg)) return false; }
  for (const sig of STRONG_SIGNALS) { if (text.includes(sig)) return true; }
  return false;
}

function scorePost(post) {
  if (!hasVpnIntent(post)) return 0;
  if ((post.subreddit || '').toLowerCase().includes('vpn')) return 0;
  let s = 60;
  const ageMin = (Date.now() / 1000 - post.created_utc) / 60;
  if (ageMin < 15) s += 80;
  else if (ageMin < 30) s += 60;
  else if (ageMin < 60) s += 40;
  else if (ageMin < 240) s += 20;
  else if (ageMin > 1440) s -= 30;
  const c = post.num_comments || 0;
  if (c === 0) s += 80;
  else if (c === 1) s += 50;
  else if (c <= 3) s += 30;
  else if (c <= 10) s += 10;
  else if (c >= 20) s -= 20;
  else if (c >= 50) s -= 40;
  const title = (post.title || '').toLowerCase();
  if (title.endsWith('?') || title.startsWith('how') || title.startsWith('what') || title.startsWith('can i')) s += 15;
  const text = (title + ' ' + (post.selftext || '').toLowerCase());
  if (text.includes('china') || text.includes('russia') || text.includes('iran') || text.includes('uae')) s += 25;
  if (text.includes('netflix') || text.includes('streaming') || text.includes('watch')) s += 10;
  return Math.max(0, Math.round(s));
}

function getIntentLabel(post) {
  const text = ((post.title || '') + ' ' + (post.selftext || '')).toLowerCase();
  for (const sig of STRONG_SIGNALS) { if (text.includes(sig)) return sig; }
  return 'vpn intent';
}

async function fetchRedditSearch(query) {
  const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=new&limit=25&t=day&raw_json=1`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 Chrome/120.0.0.0', 'Accept': 'application/json' },
      timeout: 10000
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data?.data?.children || []).map(c => c.data);
  } catch (e) { return []; }
}

async function runScan() {
  if (isScanning) return;
  isScanning = true;
  lastScan = new Date().toISOString();
  scanLog = [];
  const seen = new Set(posts.map(p => p.id));
  let newCount = 0;
  for (const query of SEARCH_QUERIES) {
    scanLog.push(`Scanning: "${query}"...`);
    try {
      const results = await fetchRedditSearch(query);
      for (const post of results) {
        if (seen.has(post.id)) continue;
        const ageH = (Date.now() / 1000 - post.created_utc) / 3600;
        if (ageH > 48) continue;
        const score = scorePost(post);
        if (score < 50) continue;
        seen.add(post.id);
        newCount++;
        posts.unshift({
          id: post.id, title: post.title,
          body: (post.selftext || '').substring(0, 500),
          url: 'https://reddit.com' + post.permalink,
          sub: post.subreddit, score,
          intent: getIntentLabel(post),
          comments: post.num_comments || 0,
          created: post.created_utc,
          upvotes: post.score || 0,
          done: false, skipped: false, foundAt: Date.now()
        });
      }
    } catch (e) { scanLog.push(`Error on "${query}": ${e.message}`); }
    await new Promise(r => setTimeout(r, 500));
  }
  const cutoff = Date.now() / 1000 - 48 * 3600;
  posts = posts.filter(p => p.created > cutoff || p.done).slice(0, 200);
  scanLog.push(`Scan complete. ${newCount} new posts found.`);
  isScanning = false;
  console.log(`[SCAN] ${new Date().toISOString()} - ${newCount} new posts`);
}

runScan();
setInterval(runScan, SCAN_INTERVAL_MS);

app.get('/api/posts', (req, res) => {
  res.json({ posts: posts.filter(p => !p.skipped), lastScan, isScanning, scanLog: scanLog.slice(-5), editQueue: editQueue.filter(i => !i.doneEdit) });
});

app.post('/api/scan', (req, res) => { if (!isScanning) runScan(); res.json({ ok: true }); });

app.post('/api/done', (req, res) => {
  const { id, persona, reply } = req.body;
  const post = posts.find(p => p.id === id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
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
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (!apiKey) return res.status(400).json({ error: 'API key required' });
  const SYSTEMS = {
    sudo: `You are sudo_overcoffee on Reddit - VPN expert, anti-bullshit, dry humor. Style: all lowercase, short punchy sentences 2-3 MAX, tbh/ngl/imo. Mention Proton VPN naturally if it fits. Never sound like an ad. Write ONLY the comment text.`,
    layer8: `You are layer8problemz on Reddit - sysadmin, skeptical, technical. Style: normal caps, challenges assumptions, 2-3 sentences max. NEVER mention any VPN brand. Write ONLY the comment text.`,
    victor: `You are victor7891 on Reddit - veteran, measured, posts rarely. Style: correct punctuation, thoughtful, 2 sentences max. NEVER mention any VPN brand. Write ONLY the comment text.`
  };
  const system = SYSTEMS[persona] || SYSTEMS.sudo;
  const user = `Subreddit: r/${post.sub}\nPost: "${post.title}"\n${post.body ? 'Body: ' + post.body.substring(0, 400) : ''}\nIntent: "${post.intent}"\nWrite a short human reply 1-3 sentences MAX. Casual, sarcastic/funny when possible.`;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 200, system, messages: [{ role: 'user', content: user }] })
    });
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json({ reply: data.content?.[0]?.text || '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/status', (req, res) => {
  res.json({ posts: posts.filter(p => !p.skipped && !p.done).length, editQueue: editQueue.filter(i => !i.doneEdit).length, lastScan, isScanning });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`VPN Snipe running on port ${PORT}`));
