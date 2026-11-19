/* QUINTO · postino delle notifiche (Cloudflare Worker, piano gratuito).
   Tiene l'elenco dei telefoni iscritti, consegna le notifiche (Web Push con chiavi VAPID),
   raccoglie risposte alle presenze e voti MVP, e ogni 15 minuti manda i promemoria delle partite.
   Segreti (impostati su Cloudflare, mai nel codice): VAPID_PRIVATE (JWK). Variabili: VAPID_PUBLIC, FB_KEY, FB_PROJECT, STAFF_EMAIL, SITE. */

const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); };
const cat = (...a) => { const n = a.reduce((s, x) => s + x.length, 0), o = new Uint8Array(n); let i = 0; a.forEach((x) => { o.set(x, i); i += x.length; }); return o; };
const sha = async (s) => b64u(await crypto.subtle.digest('SHA-256', enc.encode(s))).slice(0, 32);

/* ---------- Web Push: cifratura aes128gcm (RFC 8291) e firma VAPID (RFC 8292) ---------- */
async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
}
async function encryptPayload(sub, text) {
  const uaPub = unb64u(sub.p256dh), auth = unb64u(sub.auth);
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(auth, shared, cat(enc.encode('WebPush: info\0'), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, cat(enc.encode(text), new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]);
  return cat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}
const jwtCache = new Map();
async function vapidHeader(env, endpoint) {
  const aud = new URL(endpoint).origin, now = Math.floor(Date.now() / 1000);
  const hit = jwtCache.get(aud); if (hit && hit.exp - now > 3600) return hit.h;
  const exp = now + 12 * 3600;
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(enc.encode(JSON.stringify({ aud, exp, sub: env.SITE || 'https://polisportivatigers.github.io' })));
  const key = await crypto.subtle.importKey('jwk', JSON.parse(env.VAPID_PRIVATE), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(head + '.' + body));
  const h = `vapid t=${head}.${body}.${b64u(sig)}, k=${env.VAPID_PUBLIC}`;
  jwtCache.set(aud, { exp, h }); return h;
}
async function pushOne(env, sub, msg) {
  const body = await encryptPayload(sub, JSON.stringify(msg));
  const r = await fetch(sub.endpoint, { method: 'POST', body, headers: { Authorization: await vapidHeader(env, sub.endpoint), TTL: String(msg.ttl || 6 * 3600), Urgency: 'high', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream' } });
  if (r.status === 404 || r.status === 410) await env.DB.prepare('DELETE FROM subs WHERE id=?').bind(sub.id).run();
  return r.status;
}
/* consegna a un gruppo; "key" evita doppioni (due telefoni dello staff, nuovi tentativi) */
async function deliver(env, msg, to, key) {
  if (key) { const r = await env.DB.prepare('INSERT OR IGNORE INTO sent(key,at) VALUES(?,?)').bind(key, Date.now()).run(); if (!r.meta.changes) return { skipped: true }; }
  let q = 'SELECT * FROM subs', args = [];
  if (to === 'players') q += " WHERE player<>''";
  else if (Array.isArray(to)) { if (!to.length) return { sent: 0 }; q += ' WHERE player IN (' + to.map(() => '?').join(',') + ')'; args = to; }
  const { results } = await env.DB.prepare(q).bind(...args).all();
  const out = await Promise.allSettled(results.map((s) => pushOne(env, s, msg)));
  return { sent: out.filter((o) => o.status === 'fulfilled' && o.value < 300).length, total: results.length };
}

/* ---------- staff: si verifica il login Firebase dell'utente MISTER ---------- */
const staffCache = new Map();
async function isStaff(env, req) {
  const t = (req.headers.get('Authorization') || '').replace(/^Bearer /, ''); if (!t) return false;
  if (env.TEST_TOKEN && t === env.TEST_TOKEN) return true; // solo per le prove in locale, mai impostato su Cloudflare
  const c = staffCache.get(t); if (c && c > Date.now()) return true;
  const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + env.FB_KEY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: t }) });
  if (!r.ok) return false;
  const j = await r.json(); const u = j.users && j.users[0];
  const ok = !!(u && u.email === env.STAFF_EMAIL);
  if (ok) staffCache.set(t, Date.now() + 30 * 60000);
  return ok;
}

/* ---------- promemoria partite: dati pubblici di Firestore ---------- */
const fv = (v) => v == null ? null : 'stringValue' in v ? v.stringValue : 'booleanValue' in v ? v.booleanValue : 'integerValue' in v ? +v.integerValue : 'doubleValue' in v ? v.doubleValue : 'nullValue' in v ? null : 'mapValue' in v ? Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, fv(x)])) : undefined;
async function matches(env) {
  const out = []; let page = '';
  do {
    const r = await fetch(`https://firestore.googleapis.com/v1/projects/${env.FB_PROJECT}/databases/(default)/documents/matches?pageSize=300&key=${env.FB_KEY}` + (page ? '&pageToken=' + page : ''));
    if (!r.ok) break; const j = await r.json();
    (j.documents || []).forEach((d) => { const f = d.fields || {}; out.push({ id: d.name.split('/').pop(), date: fv(f.date), time: fv(f.time), opponent: fv(f.opponent), venue: fv(f.venue), home: fv(f.home), status: fv(f.status) }); });
    page = j.nextPageToken || '';
  } while (page);
  return out;
}
// ora italiana → istante UTC (gestisce ora legale)
function romeTime(date, time) {
  const guess = new Date(`${date}T${time || '21:00'}:00Z`);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(guess).map((x) => [x.type, x.value]));
  const shown = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return guess.getTime() - (shown - guess.getTime());
}
const romeHour = (ms) => +new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hourCycle: 'h23', hour: '2-digit' }).format(ms);
const GG = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
async function reminders(env) {
  const now = Date.now(), H = 3600000;
  const cfg = await fetch(`https://firestore.googleapis.com/v1/projects/${env.FB_PROJECT}/databases/(default)/documents/club/pushcfg?key=${env.FB_KEY}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (cfg && cfg.fields && fv(cfg.fields.reminders) === false) return;
  for (const m of await matches(env)) {
    if (m.status !== 'scheduled' || !m.date) continue;
    const at = romeTime(m.date, m.time); if (at < now || at - now > 36 * H) continue;
    const title = m.home ? `Tigers – ${m.opponent}` : `${m.opponent} – Tigers`;
    const where = m.venue ? ' · ' + m.venue.split(' - ')[0] : '';
    const url = '#partita~' + m.id;
    if (at - now <= 2 * H + 10 * 60000) await deliver(env, { t: 'Tra 2 ore si gioca', b: `${title} · ore ${m.time || ''}${where}`, u: url, tag: 'prom-' + m.id }, 'all', `prom2:${m.id}:${m.date}${m.time}`);
    else if (at - now <= 30 * H && romeHour(now) >= 18) await deliver(env, { t: 'Domani si gioca', b: `${title} · ${GG[new Date(m.date + 'T12:00:00Z').getUTCDay()]} ore ${m.time || ''}${where}`, u: url, tag: 'prom-' + m.id }, 'all', `prom1:${m.id}:${m.date}${m.time}`);
  }
}
/* chiusura votazione MVP: annuncia il vincitore */
async function closePolls(env) {
  const { results } = await env.DB.prepare('SELECT * FROM polls WHERE closes<=? AND announced=0').bind(Date.now()).all();
  for (const p of results) {
    const t = await tally(env, p.match), c = JSON.parse(p.candidates);
    const best = t.sort((a, b) => b.n - a.n)[0];
    const win = best && c.find((x) => x.id === best.player);
    await env.DB.prepare('UPDATE polls SET announced=1, winner=? WHERE match=?').bind(win ? win.id : '', p.match).run();
    if (win) await deliver(env, { t: '🏆 MVP: ' + win.name, b: `Votato dai tifosi come migliore in campo${p.title ? ' · ' + p.title : ''}. Complimenti!`, u: '#mvp' }, 'all', 'mvpwin:' + p.match);
  }
}
async function tally(env, match) { const { results } = await env.DB.prepare('SELECT player, COUNT(*) n FROM votes WHERE match=? GROUP BY player').bind(match).all(); return results; }

/* ---------- richieste dall'app ---------- */
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization', 'Access-Control-Max-Age': '86400' };
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
const str = (v, n = 200) => typeof v === 'string' ? v.slice(0, n) : '';

async function handle(req, env) {
  const u = new URL(req.url), p = u.pathname;
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};

  if (p === '/sub' && req.method === 'POST') {
    const s = body.sub || {}, k = s.keys || {};
    if (!(/^https:\/\//.test(s.endpoint || '') || (env.TEST_TOKEN && /^http:\/\/localhost:/.test(s.endpoint || ''))) || !k.p256dh || !k.auth) return J({ error: 'iscrizione non valida' }, 400);
    const id = await sha(s.endpoint);
    await env.DB.prepare('INSERT INTO subs(id,endpoint,p256dh,auth,player,created) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth, player=excluded.player')
      .bind(id, s.endpoint, str(k.p256dh), str(k.auth), str(body.player, 60), Date.now()).run();
    return J({ ok: true, id });
  }
  if (p === '/unsub' && req.method === 'POST') { await env.DB.prepare('DELETE FROM subs WHERE id=?').bind(await sha(str(body.endpoint, 1000))).run(); return J({ ok: true }); }
  if (p === '/presence' && req.method === 'POST') {
    const id = await sha(str(body.endpoint, 1000));
    const s = await env.DB.prepare('SELECT player FROM subs WHERE id=?').bind(id).first();
    if (!s || !s.player || !['yes', 'no'].includes(body.answer)) return J({ error: 'giocatore non riconosciuto' }, 400);
    await env.DB.prepare('INSERT INTO presence(match,player,answer,at) VALUES(?,?,?,?) ON CONFLICT(match,player) DO UPDATE SET answer=excluded.answer, at=excluded.at').bind(str(body.match, 80), s.player, body.answer, Date.now()).run();
    return J({ ok: true });
  }
  if (p === '/vote' && req.method === 'POST') {
    const poll = await env.DB.prepare('SELECT * FROM polls WHERE match=?').bind(str(body.match, 80)).first();
    if (!poll || poll.closes < Date.now()) return J({ error: 'votazione chiusa' }, 400);
    if (!JSON.parse(poll.candidates).some((c) => c.id === body.player)) return J({ error: 'giocatore non valido' }, 400);
    const voter = str(body.voter, 80); if (voter.length < 10) return J({ error: 'voto non valido' }, 400);
    await env.DB.prepare('INSERT INTO votes(match,voter,player,at) VALUES(?,?,?,?) ON CONFLICT(match,voter) DO UPDATE SET player=excluded.player, at=excluded.at').bind(poll.match, voter, body.player, Date.now()).run();
    return J({ ok: true, tally: await tally(env, poll.match) });
  }
  if (p === '/poll' && req.method === 'GET') {
    const poll = await env.DB.prepare('SELECT * FROM polls ORDER BY opens DESC LIMIT 1').first();
    if (!poll) return J({ poll: null });
    const voter = str(u.searchParams.get('voter') || '', 80);
    const mine = voter ? await env.DB.prepare('SELECT player FROM votes WHERE match=? AND voter=?').bind(poll.match, voter).first() : null;
    return J({ poll: { match: poll.match, title: poll.title, candidates: JSON.parse(poll.candidates), opens: poll.opens, closes: poll.closes, winner: poll.winner || '', mine: mine ? mine.player : '' }, tally: await tally(env, poll.match), now: Date.now() });
  }

  /* da qui solo staff */
  if (!['/send', '/presence', '/stats', '/poll/open'].includes(p)) return J({ error: 'non trovato' }, 404);
  if (!(await isStaff(env, req))) return J({ error: 'solo staff' }, 401);
  if (p === '/presence') { const { results } = await env.DB.prepare('SELECT player,answer,at FROM presence WHERE match=?').bind(u.searchParams.get('match') || '').all(); return J({ answers: results }); }
  if (p === '/stats') { const r = await env.DB.prepare("SELECT COUNT(*) n, SUM(player<>'') pl FROM subs").first(); const { results } = await env.DB.prepare("SELECT DISTINCT player FROM subs WHERE player<>''").all(); return J({ devices: r.n || 0, players: results.map((x) => x.player) }); }
  if (p === '/poll/open') {
    const c = (Array.isArray(body.candidates) ? body.candidates : []).slice(0, 20).map((x) => ({ id: str(x.id, 60), name: str(x.name, 40), number: x.number == null ? null : +x.number })).filter((x) => x.id);
    if (!c.length) return J({ error: 'nessun candidato' }, 400);
    const old = await env.DB.prepare('SELECT closes FROM polls WHERE match=?').bind(str(body.match, 80)).first();
    if (old && !body.force) return J({ ok: true, existing: true, closes: old.closes });
    const now = Date.now(), closes = now + Math.min(72, Math.max(1, +body.hours || 24)) * 3600000;
    await env.DB.prepare('INSERT INTO polls(match,title,candidates,opens,closes,winner,announced) VALUES(?,?,?,?,?,\'\',0) ON CONFLICT(match) DO UPDATE SET title=excluded.title, candidates=excluded.candidates, opens=excluded.opens, closes=excluded.closes, winner=\'\', announced=0')
      .bind(str(body.match, 80), str(body.title, 80), JSON.stringify(c), now, closes).run();
    const r = await deliver(env, { t: "Vota l'MVP 🏆", b: `${body.title ? str(body.title, 80) + ': chi' : 'Chi'} è stato il migliore in campo? Si vota per ${Math.round((closes - now) / 3600000)} ore.`, u: '#mvp' }, 'all', 'mvp:' + body.match + ':' + now);
    return J({ ok: true, closes, ...r });
  }
  if (p === '/send') {
    const msg = { t: str(body.title, 80), b: str(body.body, 300), u: str(body.url, 200) || '#home', tag: str(body.tag, 60) || undefined, a: Array.isArray(body.actions) ? body.actions.slice(0, 2).map((a) => ({ action: str(a.action, 20), title: str(a.title, 24) })) : undefined, m: str(body.match, 80) || undefined, p: u.origin };
    if (!msg.t) return J({ error: 'titolo mancante' }, 400);
    const to = body.to === 'players' ? 'players' : Array.isArray(body.to) ? body.to.map((x) => str(x, 60)) : 'all';
    return J(await deliver(env, msg, to, body.key ? str(body.key, 120) : null));
  }
}

export default {
  async fetch(req, env) { try { return await handle(req, env); } catch (e) { return J({ error: String(e && e.message || e) }, 500); } },
  async scheduled(ev, env, ctx) { ctx.waitUntil(Promise.allSettled([reminders(env), closePolls(env)])); },
};
