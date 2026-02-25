require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { v4: uuidv4 } = require('uuid');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────
// IN-MEMORY STORAGE (no database needed)
// ─────────────────────────────────────────
const submissions = [];
const sessions    = {};

// ─────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────
app.use(cors({
  origin: ['https://cerebrounited.netlify.app', 'http://localhost:3000'],
  methods: ['GET', 'POST', 'PATCH'],
  allowedHeaders: ['Content-Type', 'x-admin-token']
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────
// AI AGENT SYSTEM PROMPT
// ─────────────────────────────────────────
const SYSTEM_PROMPT = `You are Cerebro's AI Innovation Agent — an enthusiastic, professional, and encouraging assistant installed on terminals at HBCU universities. Your mission: conduct a warm, natural intake interview to build an innovator profile.

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
- Then immediately produce a formatted profile summary like this:

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

// ─────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────

// Chat — proxies to Anthropic
app.post('/api/chat', async (req, res) => {
  const { sessionId, messages } = req.body;
  if (!sessionId || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Missing sessionId or messages' });
  }

  // Track session
  sessions[sessionId] = {
    lastActive: new Date().toISOString(),
    msgCount: messages.length
  };

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
      console.error('Anthropic error:', err);
      return res.status(502).json({ error: 'AI service error' });
    }

    const data  = await response.json();
    const reply = data.content?.[0]?.text || '';
    const profileComplete = reply.includes('[PROFILE_COMPLETE]');
    const cleanReply = reply.replace('[PROFILE_COMPLETE]', '').trim();
    const profile = profileComplete ? extractProfile(cleanReply, messages) : null;

    return res.json({ reply: cleanReply, profileComplete, profile });

  } catch (err) {
    console.error('Chat error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Save submission
app.post('/api/submissions', (req, res) => {
  const { sessionId, transcript, profile } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

  const id = uuidv4();
  const p  = profile || {};

  const submission = {
    id,
    session_id:  sessionId,
    created_at:  new Date().toISOString(),
    status:      'new',
    full_name:   p.full_name   || null,
    university:  p.university  || null,
    year:        p.year        || null,
    major:       p.major       || null,
    idea_title:  p.idea_title  || null,
    idea_desc:   p.idea_desc   || null,
    uniqueness:  p.uniqueness  || null,
    stage:       p.stage       || null,
    challenge:   p.challenge   || null,
    email:       p.email       || null,
    transcript:  JSON.stringify(transcript || []),
    raw_profile: JSON.stringify(p)
  };

  submissions.push(submission);
  console.log(`✅ New submission: ${p.full_name || 'Unknown'} @ ${p.university || 'Unknown'}`);
  return res.json({ success: true, id });
});

// Admin — get submissions
app.get('/api/submissions', (req, res) => {
  if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { status } = req.query;
  const result = status
    ? submissions.filter(s => s.status === status)
    : submissions;
  return res.json({ submissions: result.slice().reverse(), total: result.length });
});

// Admin — update status
app.patch('/api/submissions/:id', (req, res) => {
  if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const sub = submissions.find(s => s.id === req.params.id);
  if (sub) sub.status = req.body.status;
  return res.json({ success: true });
});

// Admin — stats
app.get('/api/stats', (req, res) => {
  if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const uniCount = {};
  submissions.forEach(s => {
    if (s.university) {
      uniCount[s.university] = (uniCount[s.university] || 0) + 1;
    }
  });
  const universities = Object.entries(uniCount)
    .map(([university, count]) => ({ university, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return res.json({
    total:       submissions.length,
    new:         submissions.filter(s => s.status === 'new').length,
    reviewed:    submissions.filter(s => s.status === 'reviewed').length,
    funded:      submissions.filter(s => s.status === 'funded').length,
    sessions:    Object.keys(sessions).length,
    universities
  });
});

// Catch-all
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────
function extractProfile(text, messages) {
  const get = (label) => {
    const m = text.match(new RegExp(`${label}[:\\s]+(.+?)(?:\\n|$)`, 'i'));
    return m ? m[1].trim() : null;
  };
  const allText  = messages.map(m => typeof m.content === 'string' ? m.content : '').join('\n');
  const emailMatch = allText.match(/[\w.-]+@[\w.-]+\.\w+/);
  const nameMatch  = text.match(/INNOVATOR PROFILE\s*[—–-]\s*(.+?)(?:\n|\*\*)/i);

  return {
    full_name:  nameMatch ? nameMatch[1].trim().replace(/\*+/g, '') : null,
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

// ─────────────────────────────────────────
// START
// ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║      CEREBRO SERVER RUNNING          ║
║      Port: ${PORT}                       ║
╚══════════════════════════════════════╝
  `);
});
    
