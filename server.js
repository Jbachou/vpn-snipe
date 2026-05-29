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
  const url = req.query.url;
  if (!url || !url.includes('reddit.com')) return res.status(400).json({ error: 'invalid url' });
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; VPNSnipeBot/1.0)',
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(10000)
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('VPN Snipe running on port ' + PORT));
