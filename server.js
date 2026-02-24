require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── DB SETUP ─────────────────────────────────────────────
const db = new Database(path.join(__dirname, '../db/cerebro.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS submissions (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    status      TEXT DEFAULT 'new',

    -- Extracted profile fields
    full_name   TEXT,
    university  TEXT,
    year        TEXT,
    major       TEXT,
    idea_title  TEXT,
    idea_desc   TEXT,
    uniqueness  TEXT,
    stage       TEXT,
    challenge   TEXT,
    email       TEXT,

    -- Raw data
    transcript  TEXT,
    raw_profile TEXT
  );

  CREATE TABLE IF NOT EXISTS chat_sessions (
    session_id  TEXT PRIMARY KEY,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_active DATETIME DEFAULT CURRENT_TIMESTAMP,
    msg_count   INTEGER DEFAULT 0
  );
`);

// ── MIDDLEWARE ────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '../public')));

// ── SYSTEM PROMPT ─────────────────────────────────────────
const SYSTEM_PROMPT = `You are Cerebro's AI Innovation Agent — an enthusiastic, professional, and encouraging assistant installed on tablets at HBCU universities. Your mission: conduct a warm, natural intake interview to build an innovator profile.

Collect ALL of the following:
1. Full name
2. HBCU they attend
3. Year in school (Freshman / Sophomore / Junior / Senior / Graduate / Alumni)
4. Major / field of study
5. Business idea — what it is, what problem it solves, who it's for
6. What makes their idea unique or different from existing solutions
7. Current stage: just an idea / have a prototype / already launched
8. Their biggest challenge or what they need most right now
9. Contact email address

RULES:
- Ask ONE or TWO questions at a time, naturally and conversationally
- Be genuinely warm, encouraging, and excited — every idea matters
- Never be robotic or list-like
- When you have collected ALL 9 pieces of info, output this EXACT marker on its own line: [PROFILE_COMPLETE]
- Then immediately produce a formatted profile like this:

**INNOVATOR PROFILE — [FULL NAME]**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🏫 University: [value]
📚 Year / Major: [value]
📧 Email: [value]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 Idea: [value]
🎯 Problem Solved: [value]
✨ What Makes It Unique: [value]
📍 Current Stage: [value]
🚧 Biggest Challenge: [value]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Then end with a short, personal, inspiring closing message addressed to them by name.`;

// ── CHAT ENDPOINT ─────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { sessionId, messages } = req.body;

  if (!sessionId || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Missing sessionId or messages' });
  }

  // Upsert session
  db.prepare(`
    INSERT INTO chat_sessions (session_id, msg_count) VALUES (?, ?)
    ON CONFLICT(session_id) DO UPDATE SET last_active = CURRENT_TIMESTAMP, msg_count = ?
  `).run(sessionId, messages.length, messages.length);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic API error:', err);
      return res.status(502).json({ error: 'AI service error' });
    }

    const data = await response.json();
    const reply = data.content?.[0]?.text || '';

    const profileComplete = reply.includes('[PROFILE_COMPLETE]');
    const cleanReply = reply.replace('[PROFILE_COMPLETE]', '').trim();

    // Extract profile fields if complete
    let profile = null;
    if (profileComplete) {
      profile = extractProfile(cleanReply, messages);
    }

    return res.json({ reply: cleanReply, profileComplete, profile });

  } catch (err) {
    console.error('Chat error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── SAVE SUBMISSION ───────────────────────────────────────
app.post('/api/submissions', (req, res) => {
  const { sessionId, transcript, profile } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

  const id = uuidv4();
  const p  = profile || {};

  db.prepare(`
    INSERT OR REPLACE INTO submissions
      (id, session_id, full_name, university, year, major, idea_title,
       idea_desc, uniqueness, stage, challenge, email, transcript, raw_profile)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, sessionId,
    p.full_name || null,
    p.university || null,
    p.year || null,
    p.major || null,
    p.idea_title || null,
    p.idea_desc || null,
    p.uniqueness || null,
    p.stage || null,
    p.challenge || null,
    p.email || null,
    JSON.stringify(transcript || []),
    JSON.stringify(p)
  );

  console.log(`✅ Submission saved: ${id} — ${p.full_name || 'Unknown'} @ ${p.university || 'Unknown'}`);
  return res.json({ success: true, id });
});

// ── DASHBOARD API ─────────────────────────────────────────
app.get('/api/submissions', (req, res) => {
  // Simple auth — check for admin token in header
  const token = req.headers['x-admin-token'];
  if (token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const status = req.query.status;
  let rows;
  if (status) {
    rows = db.prepare('SELECT * FROM submissions WHERE status = ? ORDER BY created_at DESC').all(status);
  } else {
    rows = db.prepare('SELECT * FROM submissions ORDER BY created_at DESC').all();
  }
  return res.json({ submissions: rows, total: rows.length });
});

app.patch('/api/submissions/:id', (req, res) => {
  const token = req.headers['x-admin-token'];
  if (token !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: 'Unauthorized' });

  const { status } = req.body;
  db.prepare('UPDATE submissions SET status = ? WHERE id = ?').run(status, req.params.id);
  return res.json({ success: true });
});

app.get('/api/stats', (req, res) => {
  const token = req.headers['x-admin-token'];
  if (token !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: 'Unauthorized' });

  const total      = db.prepare('SELECT COUNT(*) as c FROM submissions').get().c;
  const newCount   = db.prepare("SELECT COUNT(*) as c FROM submissions WHERE status='new'").get().c;
  const reviewed   = db.prepare("SELECT COUNT(*) as c FROM submissions WHERE status='reviewed'").get().c;
  const funded     = db.prepare("SELECT COUNT(*) as c FROM submissions WHERE status='funded'").get().c;
  const sessions   = db.prepare('SELECT COUNT(*) as c FROM chat_sessions').get().c;
  const universities = db.prepare("SELECT university, COUNT(*) as count FROM submissions WHERE university IS NOT NULL GROUP BY university ORDER BY count DESC LIMIT 10").all();

  return res.json({ total, new: newCount, reviewed, funded, sessions, universities });
});

// ── CATCH ALL → index.html ────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ── HELPERS ───────────────────────────────────────────────
function extractProfile(text, messages) {
  // Pull fields from the formatted profile block using regex
  const get = (label) => {
    const match = text.match(new RegExp(`${label}[:\\s]+(.+?)(?:\\n|$)`, 'i'));
    return match ? match[1].trim() : null;
  };

  // Also scan conversation for email
  const allText = messages.map(m => typeof m.content === 'string' ? m.content : '').join('\n');
  const emailMatch = allText.match(/[\w.-]+@[\w.-]+\.\w+/);

  return {
    full_name:  get('University')?.includes('University') ? null : extractName(text),
    university: get('University'),
    year:       get('Year'),
    major:      get('Major'),
    idea_title: get('Idea'),
    idea_desc:  get('Problem Solved'),
    uniqueness: get('What Makes It Unique'),
    stage:      get('Current Stage'),
    challenge:  get('Biggest Challenge'),
    email:      get('Email') || emailMatch?.[0] || null,
  };
}

function extractName(text) {
  const match = text.match(/INNOVATOR PROFILE\s*[—–-]\s*(.+?)(?:\n|\*\*)/i);
  return match ? match[1].trim().replace(/\*+/g, '') : null;
}

// ── START ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════╗
  ║   CEREBRO SERVER — PORT ${PORT}      ║
  ║   Dashboard: http://localhost:${PORT}/dashboard.html
  ╚═══════════════════════════════════╝
  `);
});
