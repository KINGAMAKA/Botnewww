// Vercel serverless function: POST /api/chat
// Holds the API key (from Vercel environment variables) and your assistant's personality.
// If a model is busy or unavailable, it retries once, then tries a backup model.

const SYSTEM = `You are AMAKA AI, a personal assistant built for Meneka, a tattoo artist, rap artist (Goose Major) and music label owner based in Zambia.
Style: direct and practical. Challenge weak ideas politely but plainly. Use British English. Use Zambian context and ZMW for money.
Keep answers short unless asked for detail. If you are unsure, say so rather than guessing.
You never spend money, send messages or publish anything on Meneka's behalf. You only advise and draft.`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST.' });
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return res.status(500).json({ error: 'GEMINI_API_KEY is not set in Vercel environment variables.' });
  }

  // Models to try, in order. Set GEMINI_MODEL and GEMINI_BACKUP_MODEL in Vercel to change them.
  const models = [
    process.env.GEMINI_MODEL || 'gemini-3.8-flash',
    process.env.GEMINI_BACKUP_MODEL || 'gemini-3.5-flash-lite',
  ].filter((m, i, a) => m && a.indexOf(m) === i);

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }

  // Keep the last 20 messages; Gemini needs the first one to be from the user.
  let contents = (Array.isArray(body && body.messages) ? body.messages : [])
    .slice(-20)
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content || '').slice(0, 4000) }],
    }));
  while (contents.length && contents[0].role === 'model') contents.shift();
  if (!contents.length) {
    return res.status(400).json({ error: 'No message received.' });
  }

  const payload = JSON.stringify({
    system_instruction: { parts: [{ text: SYSTEM }] },
    contents,
  });

  let lastStatus = 500;
  let lastError = 'The model returned an error.';

  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
            body: payload,
          }
        );
        const data = await r.json().catch(() => ({}));

        if (r.ok) {
          const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
          const reply = (parts || []).map(p => p.text || '').join('').trim();
          return res.status(200).json({ reply: reply || 'No reply came back. Try rephrasing.' });
        }

        lastStatus = r.status;
        lastError = (data && data.error && data.error.message) || lastError;

        // Key problems will not be fixed by trying another model: stop now.
        if (r.status === 401 || r.status === 403) {
          return res.status(r.status).json({ error: lastError });
        }
        // Busy or overloaded: wait briefly, retry this model once.
        if ((r.status === 429 || r.status === 500 || r.status === 503) && attempt === 0) {
          await sleep(800);
          continue;
        }
        break; // move on to the backup model
      } catch (e) {
        lastError = 'Could not reach the model: ' + e.message;
        break;
      }
    }
  }

  return res.status(lastStatus).json({ error: lastError });
};
