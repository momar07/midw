'use strict';

// The middleware of the MicroSIP call center agent.
//
//   POST /api/login      the credentials of the agent, the answer carries the
//                        sip account, the queues, the pause reasons and the
//                        token of the session
//   WS   /ws             the session of the agent, the server pings every
//                        PING_SECONDS, the agent answers with a pong, the
//                        agent pushes its status changes
//   POST /simulate/state the remote admin (the acceptance tests and the
//                        supervisor), it is behind ADMIN_TOKEN
//
// The data comes from the Issabel database, the middleware only reads it.

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const config = require('./config');
const db = require('./db');
const { Ami } = require('./ami');

function now() {
    return Math.floor(Date.now() / 1000);
}

//-----------------------------------------------------------------------------
// the token of a session: a signed payload, it survives a restart of the
// service and it needs no table
//-----------------------------------------------------------------------------
function signToken(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const mac = crypto.createHmac('sha256', config.tokenSecret).update(body).digest('base64url');
    return body + '.' + mac;
}

function verifyToken(token) {
    if (!token || token.indexOf('.') < 1) {
        return null;
    }
    const parts = token.split('.');
    const body = parts[0];
    const mac = parts[1];
    const expected = crypto.createHmac('sha256', config.tokenSecret).update(body).digest('base64url');
    if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) {
        return null;
    }
    let payload;
    try {
        payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch (e) {
        return null;
    }
    if (payload.exp && payload.exp < now()) {
        return null;
    }
    return payload;
}

function verifyIssabelSso(token) {
    const payload = verifyToken(token);
    if (!payload || !payload.issabel_user) return null;
    return { issabel_user: String(payload.issabel_user), exp: payload.exp || 0 };
}

async function resolveCrmIdentity(req) {
    // explicit identity (already authenticated)
    if (req && req.crmAuth) return req.crmAuth;
    const q = (req && req.query) || {};
    const sso = String(q.issabel_sso || q.sso || '');
    if (sso) {
        const p = verifyIssabelSso(sso);
        if (p && p.issabel_user) {
            try {
                const agent = await db.findAgentByIssabelUsername(p.issabel_user);
                if (agent) {
                    return { role: 'agent', agent_id: agent.id, agent_ext: String(agent.sip_extension || ''), agent_name: agent.agent_name || agent.username, issabel_user: p.issabel_user, via: 'issabel_sso' };
                }
            } catch (_) {}
            return { role: 'admin', issabel_user: p.issabel_user, via: 'issabel_sso' };
        }
    }
    // also accept crm token via query ?token= (agent/admin) handled in getCrmAuth
    const auth = getCrmAuth(req);
    return auth;
}

//-----------------------------------------------------------------------------
// the asterisk manager interface
//-----------------------------------------------------------------------------
// The middleware puts the agent in its queues when it logs in, takes it out
// when it logs out and pauses it when it takes a break. The interface of the
// member is not guessed: asterisk is asked which endpoint belongs to the
// extension (PJSIP or SIP).
let ami = null;
const interfaces = new Map();     // extension -> PJSIP/1000 or SIP/1000

function amiEnabled() {
    return !!(ami && ami.loggedIn);
}

async function amiInterface(extension) {
    if (interfaces.has(extension)) {
        return interfaces.get(extension);
    }
    // Issabel keeps the interface of the extension in the dial field of the
    // sip table, asking asterisk would need broader ami rights than the
    // module needs.
    let found = null;
    try {
        found = await db.sipInterface(extension);
    } catch (e) {
        console.error('the interface of the extension could not be read: ' + e.message);
    }
    if (!found) {
        found = 'SIP/' + extension;
        console.warn('the extension ' + extension + ' has no dial field in the sip table, '
            + 'the interface ' + found + ' is used');
    }
    interfaces.set(extension, found);
    return found;
}

// Adds the agent to every queue it belongs to. A queue that does not exist in
// asterisk is a warning, the agent still works in the other ones.
async function amiQueueAdd(session) {
    if (!amiEnabled()) {
        return;
    }
    const iface = await amiInterface(session.extension);
    for (const queue of session.queues) {
        try {
            await ami.action('QueueAdd', { Queue: queue, Interface: iface });
            console.log('QueueAdd ' + queue + ' ' + iface);
        } catch (e) {
            console.warn('the agent ' + session.extension + ' could not be added to the queue '
                + queue + ': ' + e.message);
        }
    }
}

// Takes the agent out of its queues, otherwise it stays there as a stale
// member (asterisk rings the members whose device is not available).
async function amiQueueRemove(session) {
    if (!amiEnabled()) {
        return;
    }
    const iface = await amiInterface(session.extension);
    for (const queue of session.queues) {
        try {
            await ami.action('QueueRemove', { Queue: queue, Interface: iface });
            console.log('QueueRemove ' + queue + ' ' + iface);
        } catch (e) {
            console.warn('the agent ' + session.extension + ' could not be removed from the queue '
                + queue + ': ' + e.message);
        }
    }
}

// Pauses the agent in every queue it belongs to, the reason lands in the
// queue log.
async function amiQueuePause(session, paused, reason) {
    if (!amiEnabled()) {
        return;
    }
    const iface = await amiInterface(session.extension);
    const params = { Interface: iface, Paused: paused ? 'true' : 'false' };
    if (paused && reason) {
        params.Reason = reason;
    }
    try {
        await ami.action('QueuePause', params);
        console.log('QueuePause ' + iface + ' ' + (paused ? 'paused' : 'resumed')
            + (reason ? ' (' + reason + ')' : ''));
    } catch (e) {
        console.warn('the agent ' + session.extension + ' could not be paused: ' + e.message);
    }
}

//-----------------------------------------------------------------------------
// the supervisor
//-----------------------------------------------------------------------------
// The dashboards watch the agents. They connect with the admin token, they
// never touch asterisk and they get the state of every agent on every change.
const adminSessions = new Set();
let queueSnapshot = { queues: [], membersByExt: {}, kpis: emptyKpis() };
let queuePollTimer = null;
const waitingCallsByQueue = new Map();
const evKpi = { waiting: 0, active: 0, completed: 0, abandoned: 0, total: 0, asaSum: 0, asaN: 0, talkSum: 0, talkN: 0 };
const countedCompletedCalls = new Set();
const countedAbandonedCalls = new Set();
const callQueueByUid = new Map();
const ringAttemptsByDestChannel = new Map(); // destChannel -> attempt
db.ensureRequeueTable().catch((e) => console.error('queue_requeue_logs init failed: ' + e.message));
setInterval(() => {
    const cutoff = Date.now() - 60000;
    for (const [dc, a] of ringAttemptsByDestChannel.entries()) {
        if ((a.startedAt || 0) < cutoff) ringAttemptsByDestChannel.delete(dc);
    }
}, 30000);

const abuseStatsByExt = new Map(); // ext -> {abuse_timeout, abuse_declined, abuse_total, abuse_recent[]}

async function seedAbuseStats() {
    try {
        const map = await db.getTodayAgentAbuseStats();
        for (const [ext, v] of map.entries()) abuseStatsByExt.set(ext, v);
    } catch (e) {
        console.warn('abuse stats seed failed: ' + e.message);
    }
}
setInterval(() => { seedAbuseStats().catch(() => {}); }, 12 * 60 * 60 * 1000);

function getLocalDateStr(d = new Date()) {
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), da = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + da;
}
let currentStatDate = getLocalDateStr();
const todayAgentStatsByKey = new Map(); // ext -> {callsTaken,callsMade,pauseCount}
let _kpiSaveTimer = null;
const _agentSaveTimers = new Map();

function scheduleKpiSave() {
    clearTimeout(_kpiSaveTimer);
    _kpiSaveTimer = setTimeout(() => {
        db.saveTodayKpis(currentStatDate, evKpi).catch((e) => console.warn('save kpis failed: ' + e.message));
    }, 1500);
}
function scheduleAgentSave(ext) {
    clearTimeout(_agentSaveTimers.get(ext));
    _agentSaveTimers.set(ext, setTimeout(() => {
        const st = todayAgentStatsByKey.get(ext) || { callsTaken: 0, callsMade: 0, pauseCount: 0 };
        db.saveTodayAgentStat(currentStatDate, ext, st).catch((e) => console.warn('save agent stat failed: ' + e.message));
    }, 1500));
}
async function seedTodayStats() {
    try { await db.ensureDailyStatsTables(); } catch (e) { /* tables may already exist without CREATE privilege */ }
    try {
        const data = await db.loadTodayStats(currentStatDate);
        if (data.kpis) {
            evKpi.completed = Number(data.kpis.completed || 0);
            evKpi.abandoned = Number(data.kpis.abandoned || 0);
            evKpi.asaSum = Number(data.kpis.asa_sum || 0);
            evKpi.asaN = Number(data.kpis.asa_n || 0);
            evKpi.talkSum = Number(data.kpis.talk_sum || 0);
            evKpi.talkN = Number(data.kpis.talk_n || 0);
            evKpi.total = evKpi.completed + evKpi.abandoned;
        }
        todayAgentStatsByKey.clear();
        for (const r of (data.agents || [])) {
            todayAgentStatsByKey.set(String(r.agent_key), {
                callsTaken: Number(r.calls_taken || 0),
                callsMade: Number(r.calls_made || 0),
                pauseCount: Number(r.pause_count || 0),
            });
        }
        for (const entry of sessions.values()) {
            const st = todayAgentStatsByKey.get(entry.session.extension);
            if (st) {
                entry.session.callsTaken = st.callsTaken || 0;
                entry.session.callsMade = st.callsMade || 0;
                entry.session.pauseCount = st.pauseCount || 0;
            }
        }
        applyEventKpis();
        broadcastSupervisor();
    } catch (e) {
        console.warn('today stats seed failed: ' + e.message);
    }
}
seedTodayStats().catch(() => {});
setInterval(() => {
    const d = getLocalDateStr();
    if (d === currentStatDate) return;
    currentStatDate = d;
    evKpi.completed = 0; evKpi.abandoned = 0; evKpi.total = 0;
    evKpi.asaSum = 0; evKpi.asaN = 0; evKpi.talkSum = 0; evKpi.talkN = 0;
    countedCompletedCalls.clear(); countedAbandonedCalls.clear();
    todayAgentStatsByKey.clear(); abuseStatsByExt.clear();
    for (const entry of sessions.values()) {
        entry.session.callsTaken = 0; entry.session.callsMade = 0; entry.session.pauseCount = 0;
    }
    seedAbuseStats().catch(() => {});
    applyEventKpis();
    broadcastSupervisor();
    scheduleKpiSave();
}, 15000);

function applyEventKpis() {
    evKpi.armed = true;
    queueSnapshot.kpis.waiting_qc = evKpi.waiting;
    queueSnapshot.kpis.active_qc = evKpi.active;
    queueSnapshot.kpis.completed_qc = evKpi.completed;
    queueSnapshot.kpis.abandoned_qc = evKpi.abandoned;
    queueSnapshot.kpis.total_qc = (evKpi.completed || 0) + (evKpi.abandoned || 0);
    queueSnapshot.kpis.avg_qsa_s = evKpi.asaN ? Math.round((evKpi.asaSum / evKpi.asaN) * 10) / 10 : null;
    queueSnapshot.kpis.avg_qtt_s = evKpi.talkN ? Math.round((evKpi.talkSum / evKpi.talkN) * 10) / 10 : null;
}

function emptyKpis() {
    return {
        waiting_qc: 0, active_qc: 0, completed_qc: null, abandoned_qc: null, total_qc: null,
        agents_logged: 0, agents_paused: 0, avg_qsa_s: null, avg_qtt_s: null,
        sla: { s10: null, s20: null, s30: null, s30p: null },
    };
}

function numOrNull(v) {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function firstNum() {
    for (let i = 0; i < arguments.length; i++) {
        const n = numOrNull(arguments[i]);
        if (n !== null) return n;
    }
    return null;
}

function extFromInterface(iface) {
    const s = String(iface || '').trim();
    if (!s) return '';
    // Local/1001@from-queue-... -> 1001, PJSIP/1001-0001 -> 1001, SIP/1001 -> 1001
    const m = s.match(/(?:^|\/|:)(?:Local\/|PJSIP\/|SIP\/|IAX2\/)?(\d{2,})(?:@|-|;|$)/i) || s.match(/(\d{3,})/);
    return m ? m[1] : s.split('/').pop().split('-')[0].split('@')[0];
}

function findSessionByInterfaceOrChannel(fields, keys) {
    for (const k of keys) {
        const v = fields && fields[k];
        if (!v) continue;
        const ext = extFromInterface(v);
        if (ext && sessions.has(ext)) return sessions.get(ext);
    }
    // fallback: scan channel-like values for an embedded extension
    for (const k of Object.keys(fields || {})) {
        if (!/channel|interface|member|dest|from|to/i.test(k)) continue;
        const ext = extFromInterface(fields[k]);
        if (ext && sessions.has(ext)) return sessions.get(ext);
    }
    return null;
}

function memberCallState(m) {
    const st = String((m && m.status) || '');
    if (st === '6' || st === '7') return 'ringing';
    if (st === '2' || st === '3' || st === '8') return 'in-call';
    if (st === '1') return 'ready-device';
    return null;
}

function agentDisplayStatus(session, callState) {
    if (callState === 'ringing') return 'RINGING';
    if (callState === 'in-call') return 'TALKING';
    if (session.status === 'pause') return 'PAUSE';
    return 'READY';
}

function setSessionCallState(session, callState, caller) {
    const prev = session.callState || null;
    session.callState = callState || null;
    if (callState) {
        if (caller) session.talkingCaller = String(caller).trim();
        if (!session.callSince || prev !== callState) session.callSince = now();
    } else {
        session.talkingCaller = '';
        session.callSince = 0;
    }
    // Phase 4: the WhatsApp module hears about call start/end here.
    pushWhatsAppPresence(session).catch(() => {});
}

function computeKpis(queues) {
    const k = emptyKpis();
    let waiting = 0, active = 0, completed = 0, abandoned = 0, total = 0;
    let hasC = false, hasA = false, hasSla = false;
    let asaSum = 0, asaN = 0;
    for (const q of queues) {
        waiting += q.waiting || 0;
        active += q.in_call || 0;
        if (q.completed !== null) { completed += q.completed; hasC = true; }
        if (q.abandoned !== null) { abandoned += q.abandoned; hasA = true; }
        if (q.calls !== null) total += q.calls;
        if (q.holdtime !== null) { asaSum += q.holdtime; asaN++; }
        if (q.servicelevel_perf !== null) hasSla = true;
    }
    k.waiting_qc = waiting;
    k.active_qc = active;
    k.completed_qc = hasC ? completed : null;
    k.abandoned_qc = hasA ? abandoned : null;
    k.total_qc = (hasC || hasA) ? (hasC ? completed : 0) + (hasA ? abandoned : 0) + active + waiting : null;
    k.avg_qsa_s = asaN ? Math.round((asaSum / asaN) * 10) / 10 : null;
    for (const entry of sessions.values()) {
        k.agents_logged++;
        if (entry.session.status === 'pause') k.agents_paused++;
    }
    // single servicelevel threshold available from AMI -> map to closest gauge; others null
    if (hasSla && queues.length) {
        const slp = queues.reduce((a, q) => a + (q.servicelevel_perf || 0), 0) / queues.length;
        const thr = queues[0].servicelevel || 0;
        const pct = Math.round(slp * 10) / 10;
        if (thr <= 10) k.sla.s10 = pct;
        else if (thr <= 20) { k.sla.s10 = pct; k.sla.s20 = pct; }
        else { k.sla.s10 = pct; k.sla.s20 = pct; k.sla.s30 = pct; k.sla.s30p = pct; }
    }
    return k;
}

async function pollQueues() {
    if (!amiEnabled()) return;
    try {
        const events = await ami.actionCollect('QueueStatus', {}, ['QueueStatusComplete']);
        const byQueue = new Map();
        const membersByExt = {};
        for (const ev of events) {
            const f = ev.fields || {};
            const qname = String(f.Queue || '');
            if (!qname) continue;
            if (!byQueue.has(qname)) {
                byQueue.set(qname, { queue: qname, waiting: 0, in_call: 0, longest_wait: 0, entries: [],
                    completed: null, abandoned: null, calls: null, transferred: null, sla_text: 'N/A',
                    servicelevel: null, servicelevel_perf: null, holdtime: null });
            }
            const q = byQueue.get(qname);
            if (ev.event === 'QueueParams') {
                q.waiting = firstNum(f.Calls) || 0;
                q.holdtime = firstNum(f.Holdtime);
                q.servicelevel = firstNum(f.ServiceLevel, f.Servicelevel);
                q.servicelevel_perf = firstNum(f.ServicelevelPerf, f.ServiceLevelPerf);
                q.timeout = firstNum(f.Timeout);
                q.completed = firstNum(f.Completed);
                q.abandoned = firstNum(f.Abandoned);
                q.calls = firstNum(f.Calls);
                if (q.servicelevel_perf !== null) {
                    q.sla_text = q.servicelevel_perf + '% in ' + (q.servicelevel || 0) + 's';
                }
            } else if (ev.event === 'QueueEntry') {
                const wait = firstNum(f.Wait) || 0;
                q.entries.push({ caller: String(f.CallerIDNum || f.CallerIDName || f.CallerID || ''), wait: wait, position: f.Position || null });
                if (wait > q.longest_wait) q.longest_wait = wait;
            } else if (ev.event === 'QueueMember') {
                const ext = extFromInterface(f.Location || f.Name || f.Interface);
                const status = String(f.Status || '');
                const paused = String(f.Paused || '0') === '1';
                const callsTaken = firstNum(f.CallsTaken, f.CallsTakenCount);
                const inCall = (status === '2' || status === '3' || status === '6' || status === '7' || status === '8') ? 1 : 0;
                q.in_call += inCall;
                const caller = String(f.CallerIDNum || f.ConnectedLineNum || f.CallerID || f.CallerIDName || '').trim();
                if (!membersByExt[ext]) membersByExt[ext] = { status: status, paused: paused, callsTaken: callsTaken, call: memberCallState({status}), caller: caller, queues: 0 };
                // prefer most "active" status
                const prev = membersByExt[ext];
                prev.queues++;
                if (callsTaken !== null) prev.callsTaken = Math.max(prev.callsTaken || 0, callsTaken);
                if (caller) prev.caller = caller;
                const rank = { 'in-call': 3, 'ringing': 2, 'ready-device': 1 };
                if ((rank[memberCallState({status})] || 0) >= (rank[prev.call] || 0)) { prev.status = status; prev.call = memberCallState({status}); if (caller) prev.caller = caller; }
                prev.paused = prev.paused || paused;
            }
        }
        const queues = Array.from(byQueue.values()).sort((a, b) => String(a.queue).localeCompare(String(b.queue)));
        // longest_wait fallback from entries
        for (const q of queues) {
            if (!q.longest_wait && q.entries.length) q.longest_wait = Math.max.apply(null, q.entries.map(e => e.wait || 0));
        }
        queueSnapshot = { queues: queues, membersByExt: membersByExt, kpis: computeKpis(queues) };
        // event-driven counters are authoritative; the poll only refreshes the live numbers
        if (evKpi.armed) applyEventKpis();
        broadcastSupervisor();
    } catch (e) {
        // keep last snapshot on transient AMI errors
        console.warn('queue poll failed: ' + e.message);
    }
}

function startQueuePoll() {
    if (queuePollTimer) return;
    pollQueues().catch(() => {});
    // low-frequency fallback/reconciliation sync; real-time updates come from AMI events
    // responsive fallback poll while preserving event-driven reconciliation
    queuePollTimer = setInterval(() => { pollQueues().catch(() => {}); }, Math.max(2, config.queuePollSeconds || 5) * 1000);
}

// The agents that are logged in right now.
function liveAgents() {
    const agents = [];
    for (const entry of sessions.values()) {
        const m = queueSnapshot.membersByExt[entry.session.extension] || {};
        const memberCall = m.call || null;
        // reconcile session call state with member snapshot
        if (!entry.session.callState && memberCall) {
            setSessionCallState(entry.session, memberCall, m.caller || '');
        } else if (entry.session.callState && !memberCall && entry.session.status !== 'pause') {
            setSessionCallState(entry.session, null, '');
        } else if (entry.session.callState && memberCall && memberCall !== entry.session.callState) {
            setSessionCallState(entry.session, memberCall, m.caller || entry.session.talkingCaller || '');
        } else if (entry.session.callState && m.caller && !entry.session.talkingCaller) {
            entry.session.talkingCaller = m.caller;
        }
        const callState = entry.session.callState || memberCall || null;
        const display = agentDisplayStatus(entry.session, callState);
        const talkingCaller = (display === 'TALKING' || display === 'RINGING') ? (entry.session.talkingCaller || m.caller || '') : '';
        const since = (callState && entry.session.callSince) ? entry.session.callSince : entry.session.statusSince;
        const abuse = abuseStatsByExt.get(entry.session.extension) || { abuse_timeout: 0, abuse_declined: 0, abuse_total: 0, abuse_recent: [] };
        agents.push({
            username: entry.session.username,
            extension: entry.session.extension,
            status: entry.session.status,
            reason: entry.session.reason,
            since: since,
            queues: entry.session.queues || [],
            display_status: display,
            call_state: callState,
            caller_id: talkingCaller,
            talking_caller: talkingCaller,
            active_queue: entry.session.activeQueue || '',
            calls_taken: Math.max((m.callsTaken !== undefined && m.callsTaken !== null) ? m.callsTaken : 0, entry.session.callsTaken || 0),
            calls_made: (entry.session.callsMade || 0),
            queue_count: (entry.session.queues || []).length,
            pause_count: (entry.session.pauseCount || 0),
            abuse_total: abuse.abuse_total || 0,
            abuse_timeout: abuse.abuse_timeout || 0,
            abuse_declined: abuse.abuse_declined || 0,
            abuse_recent: abuse.abuse_recent || [],
        });
    }
    return agents;
}

// Tells every dashboard the state of the agents.
function broadcastSupervisor() {
    if (!adminSessions.size) {
        return;
    }
    const payload = JSON.stringify({
        event: 'supervisor_update',
        agents: liveAgents(),
        queues: queueSnapshot.queues,
        kpis: Object.assign({}, queueSnapshot.kpis, (function(){ const k={agents_logged:0,agents_paused:0}; for(const e of sessions.values()){k.agents_logged++; if(e.session.status==='pause')k.agents_paused++;} return k; })()),
        time: now(),
    });
    for (const entry of adminSessions) {
        if (entry.ws.readyState !== 1) {
            continue;
        }
        try {
            entry.ws.send(payload);
        } catch (e) {
            // the dashboard is gone, the close handler cleans it
        }
    }
}

//-----------------------------------------------------------------------------
// the http api
//-----------------------------------------------------------------------------
const app = express();
app.use(express.json());

app.get('/health', async (req, res) => {
    let database = 'down';
    try {
        await db.ping();
        database = 'up';
    } catch (e) {
        database = 'down: ' + e.message;
    }
    res.json({ ok: true, database: database, agents: sessions.size, time: now() });
});

app.post('/api/login', async (req, res) => {
    const body = req.body || {};
    const username = String(body.username || '');
    const password = String(body.password || '');
    if (!username || !password) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }

    let agent = null;
    try {
        agent = await db.findAgent(username, password);
    } catch (e) {
        console.error('the database is not reachable: ' + e.message);
        return res.status(500).json({ error: 'the database is not reachable' });
    }
    if (!agent) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }

    let queues = [];
    let reasons = [];
    let secret = '';
    try {
        [queues, reasons, secret] = await Promise.all([
            db.agentQueues(agent.id),
            db.pauseReasons(),
            db.sipSecret(agent.sip_extension),
        ]);
    } catch (e) {
        console.error('the database is not reachable: ' + e.message);
        return res.status(500).json({ error: 'the database is not reachable' });
    }

    if (!secret) {
        console.warn('the extension ' + agent.sip_extension + ' has no sip secret in the sip table, '
            + 'create it in Issabel: the agent can log in but it will not register');
    }

    // A ghost session: the agent was killed (end task) and its socket was
    // never closed, the middleware still holds it and asterisk still has it
    // in its queues. The old session is dropped before the new one is
    // started: it fires the QueueRemove, it writes the logout in the log of
    // the agent, it closes the old socket and it tells the dashboard that the
    // agent was offline. The QueueRemove goes out before this answer, so the
    // QueueAdd of the new session comes after it.
    const ghost = sessions.get(agent.sip_extension);
    if (ghost) {
        console.log('the session of the extension ' + agent.sip_extension
            + ' is superseded by a new login');
        dropSession(ghost, 'superseded by new login');
    }

    const token = signToken({
        agent_id: agent.id,
        username: agent.username,
        extension: agent.sip_extension,
        queues: queues,
        exp: now() + config.tokenTtlSeconds,
    });

    await db.logEvent(agent.id, 'login');
    console.log('login ok for ' + agent.username + ' (extension ' + agent.sip_extension + ')');

    res.json({
        sip_extension: agent.sip_extension,
        sip_password: secret,
        sip_server_ip: config.sip.serverIp,
        sip_server_port: config.sip.serverPort,
        assigned_queues: queues,
        queue_names: await queueNamesFor(queues),
        pause_reasons: reasons,
        token: token,
        timestamp: now(),
    });
});

// The dashboard of the supervisor.
app.use('/api/admin', async (req, res, next) => {
    if (!config.adminToken) {
        return res.status(404).json({ error: 'the admin api is off' });
    }
    const header = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (header && header === config.adminToken) {
        return next();
    }
    const q = req.query || {};
    const sso = String(q.issabel_sso || q.sso || header || '');
    if (sso) {
        const p = verifyIssabelSso(sso);
        if (p && p.issabel_user) {
            try {
                const agent = await db.findAgentByIssabelUsername(String(p.issabel_user));
                if (!agent) {
                    req.issabelSupervisor = { issabel_user: String(p.issabel_user) };
                    return next();
                }
            } catch (_) {
                req.issabelSupervisor = { issabel_user: String(p.issabel_user) };
                return next();
            }
        }
    }
    return res.status(401).json({ error: 'unauthorized' });
});

function getCrmAuth(req) {
    const header = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const q = req.query || {};
    const query = String(q.token || '');
    const tokenStr = header || query;
    if (tokenStr) {
        if (config.adminToken && tokenStr === config.adminToken) {
            return { role: 'admin', token: tokenStr };
        }
        const payload = verifyToken(tokenStr);
        if (payload && payload.issabel_user) {
            // resolved async elsewhere for mapping; mark for middleware
            return { role: 'issabel_sso_pending', issabel_user: String(payload.issabel_user), token: tokenStr, payload };
        }
        if (payload && (payload.agent_id || payload.agentId)) {
            return {
                role: 'agent',
                agent_id: payload.agent_id || payload.agentId,
                agent_ext: String(payload.extension || payload.agent_ext || ''),
                agent_name: String(payload.username || payload.agent_name || ''),
                token: tokenStr,
                payload,
            };
        }
    }
    const sso = String(q.issabel_sso || q.sso || '');
    if (sso) {
        const p = verifyIssabelSso(sso);
        if (p && p.issabel_user) return { role: 'issabel_sso_pending', issabel_user: p.issabel_user, token: sso, payload: p };
    }
    return null;
}

app.use('/api/crm', async (req, res, next) => {
    let auth = getCrmAuth(req);
    if (!auth) return res.status(401).json({ error: 'unauthorized' });
    if (auth.role === 'issabel_sso_pending') {
        try {
            const agent = await db.findAgentByIssabelUsername(auth.issabel_user);
            if (agent) auth = { role: 'agent', agent_id: agent.id, agent_ext: String(agent.sip_extension || ''), agent_name: agent.agent_name || agent.username, issabel_user: auth.issabel_user, via: 'issabel_sso' };
            else auth = { role: 'admin', issabel_user: auth.issabel_user, via: 'issabel_sso' };
        } catch (_) {
            auth = { role: 'admin', issabel_user: auth.issabel_user, via: 'issabel_sso' };
        }
    }
    req.crmAuth = auth;
    next();
});

app.get('/api/crm/session', async (req, res) => {
    res.json({
        ok: true,
        role: req.crmAuth.role,
        agent_id: req.crmAuth.agent_id || null,
        agent_ext: req.crmAuth.agent_ext || '',
        agent_name: req.crmAuth.agent_name || '',
        issabel_user: req.crmAuth.issabel_user || '',
    });
});

app.get('/api/crm/dispositions', async (req, res) => {
    try {
        const [rows] = await db.pool.execute('SELECT id, code, label, is_active FROM crm_dispositions WHERE is_active = 1 ORDER BY id');
        res.json({ rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/crm/agents', async (req, res) => {
    try {
        const [rows] = await db.pool.execute('SELECT id, username, sip_extension FROM cc_agents WHERE is_active = 1 ORDER BY username');
        res.json({ rows: rows.map(r => ({ id: r.id, username: r.username, sip_extension: String(r.sip_extension || '') })) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/crm/categories', async (req, res) => {
    try {
        const [rows] = await db.pool.execute('SELECT id, code, label, color, is_active FROM crm_customer_categories WHERE is_active = 1 ORDER BY id');
        res.json({ rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/crm/lookup', async (req, res) => {
    try {
        const phone = String(req.query.phone || '').trim();
        const data = await crmLookupByPhone(phone);
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

const CRM_CATEGORY_TAG = { NORMAL:'Normal', VIP:'VIP', LEAD:'Normal', PROSPECT:'Normal', ACTIVE_CLIENT:'Normal', BLACKLIST:'Blacklist' };
function crmCategoryToTag(code, fallbackTag) {
    const c = String(code || '').toUpperCase();
    if (CRM_CATEGORY_TAG[c]) return CRM_CATEGORY_TAG[c];
    const t = String(fallbackTag || 'Normal');
    return ['Normal','VIP','Blacklist'].indexOf(t) !== -1 ? t : 'Normal';
}

app.get('/api/crm/customers', async (req, res) => {
    try {
        const q = String(req.query.q || '').trim();
        const owner = String(req.query.owner || 'all');
        const category = String(req.query.category || '').trim().toUpperCase();
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
        const offset = (page - 1) * limit;
        const where = [];
        const vals = [];
        if (q) {
            const like = '%' + q + '%';
            const qNorm = normalizePhone(q);
            where.push('(c.full_name LIKE ? OR c.primary_phone LIKE ? OR c.secondary_phone LIKE ? OR c.company LIKE ?' + (qNorm ? ' OR c.phone_normalized LIKE ?' : '') + ')');
            vals.push(like, like, like, like);
            if (qNorm) vals.push('%' + qNorm + '%');
        }
        if (owner === 'mine' && req.crmAuth && req.crmAuth.role === 'agent' && req.crmAuth.agent_id) {
            where.push('c.assigned_agent_id = ?'); vals.push(req.crmAuth.agent_id);
        } else if (owner === 'unassigned') {
            where.push('(c.assigned_agent_id IS NULL OR c.assigned_agent_id = 0)');
        } else if (/^\d+$/.test(owner) && owner !== 'all' && owner !== '0') {
            where.push('c.assigned_agent_id = ?'); vals.push(parseInt(owner, 10));
        }
        if (category && category !== 'ALL') { where.push('UPPER(c.category_code) = ?'); vals.push(category); }
        const whereSql = where.length ? (' WHERE ' + where.join(' AND ')) : '';
        const [countRows] = await db.pool.execute('SELECT COUNT(*) AS total FROM crm_customers c' + whereSql, vals);
        const [rows] = await db.pool.execute(
            'SELECT c.id, c.full_name, c.primary_phone, c.phone_normalized, c.secondary_phone, c.company, c.email, c.tag, c.category_code, c.assigned_agent_id, '
            + 'a.username AS assigned_agent_name, a.sip_extension AS assigned_agent_ext, c.address, c.custom_fields, c.created_at, c.updated_at '
            + 'FROM crm_customers c LEFT JOIN cc_agents a ON a.id = c.assigned_agent_id'
            + whereSql + ' ORDER BY c.updated_at DESC, c.id DESC LIMIT ? OFFSET ?',
            vals.concat([limit, offset])
        );
        res.json({ rows, total: countRows[0].total, page, limit });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/crm/customers/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
        const [cRows] = await db.pool.execute(
            'SELECT c.*, a.username AS assigned_agent_name, a.sip_extension AS assigned_agent_ext '
            + 'FROM crm_customers c LEFT JOIN cc_agents a ON a.id = c.assigned_agent_id WHERE c.id = ? LIMIT 1', [id]
        );
        if (!cRows.length) return res.status(404).json({ error: 'not found' });
        const [iRows] = await db.pool.execute(
            'SELECT id, customer_id, agent_ext, agent_name, cdr_uniqueid, direction, channel, disposition_code, notes, follow_up_at, created_at '
            + 'FROM crm_interactions WHERE customer_id = ? ORDER BY created_at DESC, id DESC', [id]
        );
        const [tRows] = await db.pool.execute(
            'SELECT t.*, a.username AS assigned_agent_name, a.sip_extension AS assigned_agent_ext '
            + 'FROM crm_tickets t LEFT JOIN cc_agents a ON a.id = t.assigned_agent_id WHERE t.customer_id = ? ORDER BY t.updated_at DESC, t.id DESC LIMIT 50', [id]
        );
        res.json({ customer: cRows[0], interactions: iRows, tickets: tRows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

function parseCustomFields(val) {
    if (val == null || val === '') return null;
    if (typeof val === 'object') return val;
    try { return JSON.parse(val); } catch (e) { return null; }
}

app.post('/api/crm/customers', async (req, res) => {
    try {
        const b = req.body || {};
        const fullName = String(b.full_name || '').trim();
        const primaryPhone = String(b.primary_phone || '').trim();
        if (!fullName || !primaryPhone) return res.status(400).json({ error: 'full_name and primary_phone are required' });
        const norm = normalizePhone(primaryPhone);
        const category = String(b.category_code || (String(b.tag||'').toUpperCase()==='VIP'?'VIP':String(b.tag||'').toUpperCase()==='BLACKLIST'?'BLACKLIST':'NORMAL')).toUpperCase();
        const tag = crmCategoryToTag(category, b.tag);
        const assigned = (b.assigned_agent_id === null || b.assigned_agent_id === '' || b.assigned_agent_id === undefined) ? null : (parseInt(b.assigned_agent_id,10) || null);
        const cf = parseCustomFields(b.custom_fields);
        const [r] = await db.pool.execute(
            'INSERT INTO crm_customers (full_name, primary_phone, phone_normalized, secondary_phone, company, email, tag, address, custom_fields, assigned_agent_id, category_code) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
            [fullName, primaryPhone, norm, b.secondary_phone ? String(b.secondary_phone).trim() : null,
             b.company ? String(b.company).trim() : null, b.email ? String(b.email).trim() : null,
             tag, b.address ? String(b.address).trim() : null, cf ? JSON.stringify(cf) : null,
             assigned, category || 'NORMAL']
        );
        const [rows] = await db.pool.execute(
            'SELECT c.*, a.username AS assigned_agent_name, a.sip_extension AS assigned_agent_ext FROM crm_customers c LEFT JOIN cc_agents a ON a.id=c.assigned_agent_id WHERE c.id = ?', [r.insertId]
        );
        res.status(201).json({ ok: true, id: r.insertId, customer: rows[0] || null });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/crm/customers/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
        const b = req.body || {};
        const fields = [];
        const vals = [];
        if (b.full_name !== undefined) { fields.push('full_name = ?'); vals.push(String(b.full_name).trim()); }
        if (b.primary_phone !== undefined) {
            const p = String(b.primary_phone).trim();
            fields.push('primary_phone = ?'); vals.push(p);
            fields.push('phone_normalized = ?'); vals.push(normalizePhone(p));
        }
        if (b.secondary_phone !== undefined) { fields.push('secondary_phone = ?'); vals.push(b.secondary_phone ? String(b.secondary_phone).trim() : null); }
        if (b.company !== undefined) { fields.push('company = ?'); vals.push(b.company ? String(b.company).trim() : null); }
        if (b.email !== undefined) { fields.push('email = ?'); vals.push(b.email ? String(b.email).trim() : null); }
        if (b.category_code !== undefined) {
            const cat = String(b.category_code || 'NORMAL').toUpperCase();
            fields.push('category_code = ?'); vals.push(cat);
            fields.push('tag = ?'); vals.push(crmCategoryToTag(cat, b.tag));
        } else if (b.tag !== undefined) {
            const tag = ['Normal','VIP','Blacklist'].indexOf(String(b.tag)) !== -1 ? String(b.tag) : 'Normal';
            fields.push('tag = ?'); vals.push(tag);
            fields.push('category_code = ?'); vals.push(tag === 'VIP' ? 'VIP' : tag === 'Blacklist' ? 'BLACKLIST' : 'NORMAL');
        }
        if (b.assigned_agent_id !== undefined) {
            const assigned = (b.assigned_agent_id === null || b.assigned_agent_id === '' || b.assigned_agent_id === 0 || b.assigned_agent_id === '0') ? null : (parseInt(b.assigned_agent_id,10) || null);
            fields.push('assigned_agent_id = ?'); vals.push(assigned);
        }
        if (b.address !== undefined) { fields.push('address = ?'); vals.push(b.address ? String(b.address).trim() : null); }
        if (b.custom_fields !== undefined) { const cf = parseCustomFields(b.custom_fields); fields.push('custom_fields = ?'); vals.push(cf ? JSON.stringify(cf) : null); }
        if (!fields.length) return res.status(400).json({ error: 'no fields' });
        vals.push(id);
        const [r] = await db.pool.execute('UPDATE crm_customers SET ' + fields.join(', ') + ' WHERE id = ?', vals);
        if (!r.affectedRows) return res.status(404).json({ error: 'not found' });
        const [rows] = await db.pool.execute('SELECT c.*, a.username AS assigned_agent_name, a.sip_extension AS assigned_agent_ext FROM crm_customers c LEFT JOIN cc_agents a ON a.id=c.assigned_agent_id WHERE c.id = ?', [id]);
        res.json({ ok: true, customer: rows[0] || null });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/crm/interactions', async (req, res) => {
    try {
        const b = req.body || {};
        const customerId = parseInt(b.customer_id, 10);
        if (!Number.isFinite(customerId)) return res.status(400).json({ error: 'customer_id required' });
        const dir = ['inbound','outbound','manual'].indexOf(String(b.direction||'inbound')) !== -1 ? String(b.direction||'inbound') : 'inbound';
        const followUp = b.follow_up_at ? String(b.follow_up_at).replace('T',' ').slice(0,19) : null;
        const agentExt = b.agent_ext ? String(b.agent_ext) : (req.crmAuth && req.crmAuth.agent_ext ? req.crmAuth.agent_ext : null);
        const agentName = b.agent_name ? String(b.agent_name) : (req.crmAuth && req.crmAuth.agent_name ? req.crmAuth.agent_name : null);
        const [r] = await db.pool.execute(
            'INSERT INTO crm_interactions (customer_id, agent_ext, agent_name, cdr_uniqueid, direction, channel, disposition_code, notes, follow_up_at) VALUES (?,?,?,?,?,?,?,?,?)',
            [customerId, agentExt, agentName,
             b.cdr_uniqueid ? String(b.cdr_uniqueid) : null, dir, b.channel ? String(b.channel) : 'call',
             b.disposition_code ? String(b.disposition_code) : null, b.notes ? String(b.notes) : null,
             followUp || null]
        );
        res.status(201).json({ ok: true, id: r.insertId });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

async function crmAgentById(id) {
    if (!id) return null;
    const [rows] = await db.pool.execute('SELECT id, username, sip_extension FROM cc_agents WHERE id = ? LIMIT 1', [id]);
    return rows[0] || null;
}
async function crmNotifyTicketAssigned(ticketId, toAgentId, extra) {
    try {
        const [rows] = await db.pool.execute(
            'SELECT t.id,t.ticket_number,t.subject,t.priority,t.status,t.assigned_agent_id,t.customer_id,c.full_name AS customer_name,c.primary_phone AS customer_phone,'
            + 'a.username AS assigned_agent_name,a.sip_extension AS assigned_agent_ext '
            + 'FROM crm_tickets t LEFT JOIN crm_customers c ON c.id=t.customer_id LEFT JOIN cc_agents a ON a.id=t.assigned_agent_id WHERE t.id=? LIMIT 1', [ticketId]
        );
        if (!rows.length) return;
        const t = rows[0];
        const payload = Object.assign({ type: 'crm_ticket_assigned', ticket: t, time: now() }, extra || {});
        const exts = [];
        if (t.assigned_agent_ext) exts.push(String(t.assigned_agent_ext));
        if (toAgentId) { const ag = await crmAgentById(toAgentId); if (ag && ag.sip_extension) exts.push(String(ag.sip_extension)); }
        broadcastCrmToAdminsAndAgents(payload, exts);
    } catch (_) {}
}

app.get('/api/crm/tickets', async (req, res) => {
    try {
        const owner = String(req.query.owner || 'all');
        const status = String(req.query.status || '').trim();
        const priority = String(req.query.priority || '').trim();
        const q = String(req.query.q || '').trim();
        const customerId = parseInt(req.query.customer_id, 10);
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
        const offset = (page - 1) * limit;
        const where = [];
        const vals = [];
        if (Number.isFinite(customerId) && customerId > 0) { where.push('t.customer_id = ?'); vals.push(customerId); }
        if (owner === 'mine' && req.crmAuth && req.crmAuth.role === 'agent' && req.crmAuth.agent_id) { where.push('t.assigned_agent_id = ?'); vals.push(req.crmAuth.agent_id); }
        else if (/^\d+$/.test(owner) && owner !== 'all' && owner !== '0') { where.push('t.assigned_agent_id = ?'); vals.push(parseInt(owner,10)); }
        else if (owner === 'unassigned') { where.push('(t.assigned_agent_id IS NULL OR t.assigned_agent_id = 0)'); }
        if (status && status !== 'all') { where.push('t.status = ?'); vals.push(status); }
        if (priority && priority !== 'all') { where.push('t.priority = ?'); vals.push(priority); }
        if (q) { where.push('(t.ticket_number LIKE ? OR t.subject LIKE ? OR c.full_name LIKE ? OR c.primary_phone LIKE ?)'); const like='%'+q+'%'; vals.push(like,like,like,like); }
        const whereSql = where.length ? (' WHERE ' + where.join(' AND ')) : '';
        const [countRows] = await db.pool.execute('SELECT COUNT(*) AS total FROM crm_tickets t LEFT JOIN crm_customers c ON c.id=t.customer_id' + whereSql, vals);
        const [rows] = await db.pool.execute(
            'SELECT t.*, c.full_name AS customer_name, c.primary_phone AS customer_phone, a.username AS assigned_agent_name, a.sip_extension AS assigned_agent_ext, ca.username AS created_by_agent_name '
            + 'FROM crm_tickets t LEFT JOIN crm_customers c ON c.id=t.customer_id LEFT JOIN cc_agents a ON a.id=t.assigned_agent_id LEFT JOIN cc_agents ca ON ca.id=t.created_by_agent_id'
            + whereSql + ' ORDER BY t.updated_at DESC, t.id DESC LIMIT ? OFFSET ?', vals.concat([limit, offset])
        );
        res.json({ rows, total: countRows[0].total, page, limit });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/crm/tickets/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
        const [rows] = await db.pool.execute(
            'SELECT t.*, c.full_name AS customer_name, c.primary_phone AS customer_phone, a.username AS assigned_agent_name, a.sip_extension AS assigned_agent_ext, ca.username AS created_by_agent_name '
            + 'FROM crm_tickets t LEFT JOIN crm_customers c ON c.id=t.customer_id LEFT JOIN cc_agents a ON a.id=t.assigned_agent_id LEFT JOIN cc_agents ca ON ca.id=t.created_by_agent_id WHERE t.id=? LIMIT 1', [id]
        );
        if (!rows.length) return res.status(404).json({ error: 'not found' });
        const [logs] = await db.pool.execute(
            'SELECT l.*, fa.username AS from_agent_name, ta.username AS to_agent_name '
            + 'FROM crm_ticket_logs l LEFT JOIN cc_agents fa ON fa.id=l.from_agent_id LEFT JOIN cc_agents ta ON ta.id=l.to_agent_id WHERE l.ticket_id=? ORDER BY l.created_at ASC, l.id ASC', [id]
        );
        res.json({ ticket: rows[0], logs });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/crm/tickets', async (req, res) => {
    try {
        const b = req.body || {};
        const customerId = parseInt(b.customer_id, 10);
        const subject = String(b.subject || '').trim();
        if (!Number.isFinite(customerId) || !subject) return res.status(400).json({ error: 'customer_id and subject are required' });
        const category = String(b.category || 'General');
        const priority = ['Low','Medium','High','Urgent'].indexOf(String(b.priority||'Medium'))!==-1 ? String(b.priority||'Medium') : 'Medium';
        const status = ['Open','In Progress','Waiting Customer','Escalated','Closed'].indexOf(String(b.status||'Open'))!==-1 ? String(b.status||'Open') : 'Open';
        const assigned = (b.assigned_agent_id === null || b.assigned_agent_id === '' || b.assigned_agent_id === undefined) ? null : (parseInt(b.assigned_agent_id,10)||null);
        const createdBy = (req.crmAuth && req.crmAuth.role === 'agent' && req.crmAuth.agent_id) ? req.crmAuth.agent_id : (parseInt(b.created_by_agent_id,10)||null);
        const dueAt = b.due_at ? String(b.due_at).replace('T',' ').slice(0,19) : null;
        const desc = b.description ? String(b.description) : null;
        const [r] = await db.pool.execute(
            'INSERT INTO crm_tickets (customer_id, subject, category, priority, status, created_by_agent_id, assigned_agent_id, due_at, description) VALUES (?,?,?,?,?,?,?,?,?)',
            [customerId, subject, category, priority, status, createdBy, assigned, dueAt, desc]
        );
        const ticketNumber = 'TCK-' + (1000 + r.insertId);
        await db.pool.execute('UPDATE crm_tickets SET ticket_number = ? WHERE id = ?', [ticketNumber, r.insertId]);
        await db.pool.execute('INSERT INTO crm_ticket_logs (ticket_id, action_type, from_agent_id, to_agent_id, old_status, new_status, note) VALUES (?,?,?,?,?,?,?)',
            [r.insertId, 'created', createdBy, assigned, null, status, desc || 'Ticket created']);
        if (assigned) await crmNotifyTicketAssigned(r.insertId, assigned, { action: 'created' });
        const [rows] = await db.pool.execute('SELECT t.*, c.full_name AS customer_name, c.primary_phone AS customer_phone, a.username AS assigned_agent_name, a.sip_extension AS assigned_agent_ext FROM crm_tickets t LEFT JOIN crm_customers c ON c.id=t.customer_id LEFT JOIN cc_agents a ON a.id=t.assigned_agent_id WHERE t.id=? LIMIT 1', [r.insertId]);
        res.status(201).json({ ok:true, id:r.insertId, ticket_number: ticketNumber, ticket: rows[0] || null });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/crm/tickets/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
        const [curRows] = await db.pool.execute('SELECT * FROM crm_tickets WHERE id=? LIMIT 1', [id]);
        if (!curRows.length) return res.status(404).json({ error: 'not found' });
        const cur = curRows[0];
        const b = req.body || {};
        const fields = []; const vals = [];
        let newStatus = cur.status;
        if (b.status !== undefined) { const st = ['Open','In Progress','Waiting Customer','Escalated','Closed'].indexOf(String(b.status))!==-1 ? String(b.status) : cur.status; fields.push('status=?'); vals.push(st); newStatus = st; }
        if (b.priority !== undefined) { const pr = ['Low','Medium','High','Urgent'].indexOf(String(b.priority))!==-1 ? String(b.priority) : cur.priority; fields.push('priority=?'); vals.push(pr); }
        if (b.due_at !== undefined) { fields.push('due_at=?'); vals.push(b.due_at ? String(b.due_at).replace('T',' ').slice(0,19) : null); }
        if (b.description !== undefined) { fields.push('description=?'); vals.push(b.description ? String(b.description) : null); }
        if (!fields.length) return res.status(400).json({ error: 'no fields' });
        vals.push(id);
        await db.pool.execute('UPDATE crm_tickets SET ' + fields.join(', ') + ' WHERE id=?', vals);
        if (String(newStatus) !== String(cur.status)) {
            const by = (req.crmAuth && req.crmAuth.agent_id) ? req.crmAuth.agent_id : null;
            await db.pool.execute('INSERT INTO crm_ticket_logs (ticket_id, action_type, from_agent_id, to_agent_id, old_status, new_status, note) VALUES (?,?,?,?,?,?,?)',
                [id, 'status_change', by, cur.assigned_agent_id || null, cur.status, newStatus, b.note ? String(b.note) : null]);
        }
        const [rows] = await db.pool.execute('SELECT t.*, c.full_name AS customer_name, c.primary_phone AS customer_phone, a.username AS assigned_agent_name, a.sip_extension AS assigned_agent_ext FROM crm_tickets t LEFT JOIN crm_customers c ON c.id=t.customer_id LEFT JOIN cc_agents a ON a.id=t.assigned_agent_id WHERE t.id=? LIMIT 1', [id]);
        res.json({ ok:true, ticket: rows[0] || null });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/crm/tickets/:id/transfer', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
        const b = req.body || {};
        const toAgentId = parseInt(b.to_agent_id || b.assigned_agent_id, 10);
        if (!Number.isFinite(toAgentId)) return res.status(400).json({ error: 'to_agent_id required' });
        const [curRows] = await db.pool.execute('SELECT * FROM crm_tickets WHERE id=? LIMIT 1', [id]);
        if (!curRows.length) return res.status(404).json({ error: 'not found' });
        const cur = curRows[0];
        const fromAgentId = cur.assigned_agent_id || ((req.crmAuth && req.crmAuth.agent_id) ? req.crmAuth.agent_id : null);
        const fields = ['assigned_agent_id=?']; const vals = [toAgentId];
        let newStatus = cur.status;
        if (b.status !== undefined) { const st = ['Open','In Progress','Waiting Customer','Escalated','Closed'].indexOf(String(b.status))!==-1 ? String(b.status) : cur.status; fields.push('status=?'); vals.push(st); newStatus = st; }
        if (b.priority !== undefined) { const pr = ['Low','Medium','High','Urgent'].indexOf(String(b.priority))!==-1 ? String(b.priority) : cur.priority; fields.push('priority=?'); vals.push(pr); }
        vals.push(id);
        await db.pool.execute('UPDATE crm_tickets SET ' + fields.join(', ') + ' WHERE id=?', vals);
        await db.pool.execute('INSERT INTO crm_ticket_logs (ticket_id, action_type, from_agent_id, to_agent_id, old_status, new_status, note) VALUES (?,?,?,?,?,?,?)',
            [id, 'transfer', fromAgentId, toAgentId, cur.status, newStatus, b.note ? String(b.note) : 'Transferred']);
        await crmNotifyTicketAssigned(id, toAgentId, { action: 'transfer', from_agent_id: fromAgentId, note: b.note || '' });
        const [rows] = await db.pool.execute('SELECT t.*, c.full_name AS customer_name, c.primary_phone AS customer_phone, a.username AS assigned_agent_name, a.sip_extension AS assigned_agent_ext FROM crm_tickets t LEFT JOIN crm_customers c ON c.id=t.customer_id LEFT JOIN cc_agents a ON a.id=t.assigned_agent_id WHERE t.id=? LIMIT 1', [id]);
        res.json({ ok:true, ticket: rows[0] || null });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/crm/click-to-dial', async (req, res) => {
    try {
        if (!amiEnabled()) return res.status(503).json({ error: 'AMI not available' });
        const b = req.body || {};
        let phone = String(b.phone || '').replace(/\D+/g, '');
        if (!phone) return res.status(400).json({ error: 'phone required' });
        let agentExt = String(b.agent_ext || (req.crmAuth && req.crmAuth.agent_ext) || '').trim();
        if (!agentExt) return res.status(400).json({ error: 'agent_ext required' });
        agentExt = agentExt.replace(/\D+/g, '');
        let channel = 'SIP/' + agentExt;
        try { channel = await amiInterface(agentExt); } catch (_) {}
        if (!/^(PJSIP|SIP|IAX2)\//i.test(channel)) channel = 'SIP/' + agentExt;
        const cleanPhone = phone;
        const params = {
            Channel: channel,
            Context: 'from-internal',
            Exten: cleanPhone,
            Priority: '1',
            CallerID: '"CRM Dial ' + cleanPhone + '" <' + cleanPhone + '>',
            Async: 'true',
        };
        await ami.action('Originate', params);
        res.json({ ok: true, channel, exten: cleanPhone });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/crm/simulate-screen-pop', async (req, res) => {
    try {
        const b = req.body || {};
        const caller = String(b.caller_id || b.phone || '').trim();
        const agentExt = String(b.agent_ext || '').trim();
        const uniqueid = String(b.uniqueid || ('sim-' + Date.now()));
        if (!caller) return res.status(400).json({ error: 'caller_id required' });
        await crmHandleScreenPop(agentExt, caller, uniqueid);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// The agents of the call center, the supervisor manages them.
app.get('/api/admin/agents', async (req, res) => {
    try {
        const agents = await db.allAgents();
        // the extensions and the queues of Issabel, for the lists of the
        // supervisor
        let extensions = [];
        let configured = [];
        try {
            extensions = await db.listExtensions();
            configured = await db.listQueues();
        } catch (e) {
            console.error('the extensions of issabel could not be read: ' + e.message);
        }
        // the provisioning pick-lists from the WhatsApp service (hub
        // step 2): the real Issabel users and the chat queues. Empty
        // when the WhatsApp link is down — the page then just offers
        // no link, it never blocks agent management.
        let issabelUsers = [];
        let chatQueues = [];
        try {
            const lists = await waProvisioningLists();
            issabelUsers = lists.users;
            chatQueues = lists.queues;
        } catch (e) { /* best-effort */ }
        res.json({
            agents: agents,
            extensions: extensions,
            configured_queues: configured,
            issabel_users: issabelUsers,
            chat_queues: chatQueues,
        });
    } catch (e) {
        console.error('the agents could not be read: ' + e.message);
        res.status(500).json({ error: e.message });
    }
});

// The queues of an agent have to exist in issabel, a queue that does not exist
// is refused by asterisk on every login of the agent ("No such queue").
async function checkQueuesOfIssabel(queues) {
    const known = await db.listQueues();
    const unknown = (queues || []).map((queue) => String(queue).trim())
        .filter((queue) => queue && known.indexOf(queue) === -1);
    if (unknown.length) {
        return 'the queue ' + unknown.join(', ') + ' does not exist in issabel';
    }
    return '';
}

// The WhatsApp state of one agent, for the edit form's chat section
// (hub step 2). Proxied from the WhatsApp service so the form shows
// the service's truth.
app.get('/api/admin/agents/:id/wa', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
        return res.status(400).json({ error: 'the id of the agent is not valid' });
    }
    try {
        const agents = await db.allAgents();
        const agent = agents.find((a) => a.id === id);
        if (!agent) return res.status(404).json({ error: 'the agent is not in the list' });
        if (!agent.issabel_user_id) return res.json({ ok: true, linked: false });
        const r = await waInternalGet('/internal/agents/' + agent.issabel_user_id, 8000);
        if (!r.ok || !r.json) return res.json({ ok: true, linked: true, available: false });
        return res.json({ ok: true, linked: true, available: true, profile: r.json.profile || null, memberships: r.json.memberships || [] });
    } catch (e) {
        console.error('the whatsapp state of the agent could not be read: ' + e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/agents', async (req, res) => {
    const body = req.body || {};
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const extension = String(body.sip_extension || '').trim();
    if (!username || !password || !extension) {
        return res.status(400).json({
            error: 'the user name, the password and the extension are needed',
        });
    }
    try {
        const problem = await checkQueuesOfIssabel(body.queues);
        if (problem) {
            return res.status(400).json({ error: problem });
        }
    } catch (e) {
        console.error('the queues of issabel could not be read: ' + e.message);
    }
    await normalizeIssabelPair(body);
    const issabelUsername = String(body.issabel_username || '').trim();
    const issabelUserId = parseInt(body.issabel_user_id, 10);
    try {
        const id = await db.createAgent({
            username: username,
            agent_name: body.agent_name,
            password: password,
            sip_extension: extension,
            issabel_username: issabelUsername,
            issabel_user_id: Number.isFinite(issabelUserId) && issabelUserId > 0 ? issabelUserId : null,
            queues: body.queues,
        });
        console.log('the supervisor created the agent ' + username + ' (' + extension + ')');
        const waSync = await waSyncAgentFor(
            Number.isFinite(issabelUserId) && issabelUserId > 0 ? issabelUserId : null,
            issabelUsername, body.queues, body.chat);
        res.status(201).json({ ok: true, id: id, wa_sync: waSync });
    } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'the user name is already taken' });
        }
        console.error('the agent could not be created: ' + e.message);
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/admin/agents/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
        return res.status(400).json({ error: 'the id of the agent is not valid' });
    }
    const body = req.body || {};
    try {
        if (body.queues !== undefined) {
            const problem = await checkQueuesOfIssabel(body.queues);
            if (problem) {
                return res.status(400).json({ error: problem });
            }
        }
    } catch (e) {
        console.error('the queues of issabel could not be read: ' + e.message);
    }
    try {
        await normalizeIssabelPair(body);
        const update = {
            username: body.username,
            agent_name: body.agent_name,
            password: body.password,
            sip_extension: body.sip_extension,
            issabel_username: body.issabel_username,
            is_active: body.is_active,
            queues: body.queues,
        };
        if (body.issabel_user_id !== undefined) {
            const uid = parseInt(body.issabel_user_id, 10);
            update.issabel_user_id = Number.isFinite(uid) && uid > 0 ? uid : null;
        }
        await db.updateAgent(id, update);
        console.log('the supervisor changed the agent ' + id);
        // Provisioning (hub step 2): sync the WhatsApp side when the
        // save carries provisioning fields, and when the agent is
        // being disabled — a disabled agent must stop receiving chat
        // too. Plain saves (e.g. a password change) do not re-sync.
        let waSync;
        const carriesProvisioning = body.chat !== undefined || body.issabel_user_id !== undefined;
        const beingDisabled = body.is_active !== undefined && !body.is_active;
        if (carriesProvisioning || beingDisabled) {
            const agents = await db.allAgents();
            const agent = agents.find((a) => a.id === id);
            if (agent && agent.issabel_user_id) {
                const chat = beingDisabled ? { enabled: false } : body.chat;
                waSync = await waSyncAgentFor(agent.issabel_user_id, agent.issabel_username, agent.queues, chat);
            }
        }
        res.json(waSync ? { ok: true, wa_sync: waSync } : { ok: true });
    } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'the user name is already taken' });
        }
        console.error('the agent could not be changed: ' + e.message);
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/admin/agents/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
        return res.status(400).json({ error: 'the id of the agent is not valid' });
    }
    try {
        const before = await db.allAgents();
        const agent = before.find((a) => a.id === id);
        await db.disableAgent(id);
        console.log('the supervisor disabled the agent ' + id);
        // a disabled agent stops receiving WhatsApp chat too (hub)
        let waSync;
        if (agent && agent.issabel_user_id) {
            waSync = await waSyncAgentFor(agent.issabel_user_id, agent.issabel_username, agent.queues, { enabled: false });
        }
        res.json(waSync ? { ok: true, wa_sync: waSync } : { ok: true });
    } catch (e) {
        console.error('the agent could not be disabled: ' + e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/force_logout', async (req, res) => {
    const extension = String((req.body || {}).extension || '').trim();
    if (!extension) {
        return res.status(400).json({ error: 'extension is required' });
    }
    const entry = sessions.get(extension);
    if (!entry) {
        return res.status(404).json({ error: 'agent is not logged in' });
    }
    dropSession(entry, 'forced by supervisor');
    res.json({ ok: true, extension: extension });
});

async function setAllAgents(status, reason) {
    let updated = 0;
    for (const entry of Array.from(sessions.values())) {
        if (!entry.ws || entry.ws.readyState !== 1) continue;
        if (status === 'pause' && entry.session.status !== 'pause') {
            entry.session.pauseCount = (entry.session.pauseCount || 0) + 1;
        }
        entry.session.status = status;
        entry.session.reason = reason || '';
        entry.session.statusSince = now();
        pushWhatsAppPresence(entry.session).catch(() => {});
        await db.logEvent(entry.session.agentId, status === 'pause' ? 'pause' : 'unpause', reason || '');
        await amiQueuePause(entry.session, status === 'pause', reason || '');
        try {
            entry.ws.send(JSON.stringify({
                event: 'state_update', extension: entry.session.extension, status: status, reason: reason || '',
                assigned_queues: entry.session.queues, timestamp: now(),
            }));
        } catch (e) {}
        updated++;
    }
    broadcastSupervisor();
    return updated;
}

app.post('/api/admin/pause_all', async (req, res) => {
    const reason = String((req.body || {}).reason || 'AdminBreak');
    const updated = await setAllAgents('pause', reason);
    res.json({ ok: true, updated: updated });
});

app.post('/api/admin/resume_all', async (req, res) => {
    const updated = await setAllAgents('available', '');
    res.json({ ok: true, updated: updated });
});

//-----------------------------------------------------------------------------
// the pause reasons of the breaks
//-----------------------------------------------------------------------------

// The reasons an agent may take, the inactive ones are in the list too.
app.get('/api/admin/pause_reasons', async (req, res) => {
    try {
        res.json({ reasons: await db.allPauseReasons() });
    } catch (e) {
        console.error('the pause reasons could not be read: ' + e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/pause_reasons', async (req, res) => {
    const body = req.body || {};
    const code = String(body.reason_code || '').trim();
    if (!code) {
        return res.status(400).json({ error: 'the reason code is needed' });
    }
    try {
        const id = await db.createPauseReason({
            reason_code: code,
            description: String(body.description || '').trim(),
            is_active: body.is_active,
        });
        console.log('the supervisor created the pause reason ' + code);
        res.status(201).json({ ok: true, id: id });
    } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'the reason code already exists' });
        }
        console.error('the pause reason could not be created: ' + e.message);
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/admin/pause_reasons/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
        return res.status(400).json({ error: 'the id of the reason is not valid' });
    }
    const body = req.body || {};
    try {
        await db.updatePauseReason(id, {
            reason_code: body.reason_code === undefined ? undefined : String(body.reason_code).trim(),
            description: body.description,
            is_active: body.is_active,
        });
        console.log('the supervisor changed the pause reason ' + id);
        res.json({ ok: true });
    } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'the reason code already exists' });
        }
        console.error('the pause reason could not be changed: ' + e.message);
        res.status(500).json({ error: e.message });
    }
});

// A reason that is in the log of the agents stays in the database (the log
// points at it), it is deactivated instead of being removed.
app.delete('/api/admin/pause_reasons/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
        return res.status(400).json({ error: 'the id of the reason is not valid' });
    }
    try {
        const uses = await db.pauseReasonLogCount(id);
        if (uses) {
            await db.updatePauseReason(id, { is_active: false });
            console.log('the pause reason ' + id + ' is in the log ' + uses + ' times, it is deactivated');
            return res.json({ ok: true, deactivated: true });
        }
        await db.deletePauseReason(id);
        console.log('the supervisor deleted the pause reason ' + id);
        res.json({ ok: true });
    } catch (e) {
        console.error('the pause reason could not be deleted: ' + e.message);
        res.status(500).json({ error: e.message });
    }
});

//-----------------------------------------------------------------------------
// the reports
//-----------------------------------------------------------------------------

// The lines of the log of the agents. The pagination is for the browser, the
// time of a pause is found in the database, so a page break does not hide it.
app.get('/api/admin/reports/agent_logs', async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = Math.min(200, Math.max(10, parseInt(req.query.per_page, 10) || 50));
    const event = ['login', 'pause'].indexOf(req.query.event) !== -1
        ? req.query.event : null;
    try {
        const data = await db.agentLogs({
            from: req.query.from,
            to: req.query.to,
            agentId: parseInt(req.query.agent_id, 10) || null,
            eventType: event,
            offset: (page - 1) * perPage,
            perPage: perPage,
        });
        res.json({
            total: data.total,
            page: page,
            per_page: perPage,
            rows: data.rows,
        });
    } catch (e) {
        console.error('the report could not be read: ' + e.message);
        res.status(500).json({ error: e.message });
    }
});

// The breaks per reason.
app.get('/api/admin/reports/pause_summary', async (req, res) => {
    try {
        res.json({ rows: await db.pauseSummary({ from: req.query.from, to: req.query.to }) });
    } catch (e) {
        console.error('the pause summary could not be read: ' + e.message);
        res.status(500).json({ error: e.message });
    }
});

// The numbers of the summary cards of the agent log.
app.get('/api/admin/reports/agent_summary', async (req, res) => {
    try {
        res.json(await db.agentSummary({
            from: req.query.from,
            to: req.query.to,
            agentId: parseInt(req.query.agent_id, 10) || null,
        }));
    } catch (e) {
        console.error('the agent summary could not be read: ' + e.message);
        res.status(500).json({ error: e.message });
    }
});


// ---- New categorized reports ----
app.get('/api/admin/reports/agent_performance', async (req, res) => {
    try {
        const rows = await db.reportAgentPerformance({
            from: req.query.from, to: req.query.to,
            agentId: parseInt(req.query.agent_id, 10) || null,
        });
        // enrich talk time/avg from queue_log
        try {
            const events = db.readQueueLogEvents ? db.readQueueLogEvents(req.query.from, req.query.to) : null;
        } catch (e) {}
        // compute talk from queue_log file via db helper? db has no export of readQueueLogEvents but has reportQueueSummary; easier compute here from file
        const fs = require('fs');
        try {
            const text = fs.readFileSync('/var/log/asterisk/queue_log','utf8');
            const fromStr = db.reportDate ? db.reportDate(req.query.from) : (req.query.from||'');
            const toStr = db.reportDate ? db.reportDate(req.query.to) : (req.query.to||'');
            const talkByExt = new Map();
            for (const line of text.split('\n')) {
                const p = line.trim().split('|'); if (p.length<7) continue;
                const ts=parseInt(p[0],10); if(!Number.isFinite(ts)) continue;
                const d=new Date(ts*1000); const ds=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
                if (fromStr && ds < fromStr) continue; if (toStr && ds > toStr) continue;
                const ev=p[4]; if (ev==='COMPLETEAGENT' || ev==='COMPLETECALLER') {
                    const agent=p[3]||''; const talk=parseInt(p[6],10)||0;
                    // agent like PJSIP/1003
                    const m = /\/(\d+)$/.exec(agent) || /^(\d+)$/.exec(agent);
                    const ext = m?m[1]:agent.replace(/[^0-9]/g,'');
                    if(!ext) continue;
                    if(!talkByExt.has(ext)) talkByExt.set(ext,{sum:0,n:0});
                    const t=talkByExt.get(ext); t.sum+=talk; t.n++;
                }
            }
            for (const r of rows) {
                const t = talkByExt.get(String(r.extension));
                if (t) { r.total_talk_time = t.sum; r.avg_talk = t.n? (t.sum/t.n):0; }
            }
        } catch (e) {}
        res.json({ rows });
    } catch (e) {
        console.error('agent performance report failed: ' + e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/reports/requeue_abuse', async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page,10)||1);
        const perPage = Math.min(10000, Math.max(1, parseInt(req.query.per_page,10)||50));
        const all = req.query.all === '1';
        const params = { from:req.query.from, to:req.query.to, agent:req.query.agent||'', queue:req.query.queue||'', reason:req.query.reason||'' };
        const c = await db.reportRequeueAbuseLog(Object.assign({}, params, {countOnly:true}));
        const data = await db.reportRequeueAbuseLog(Object.assign({}, params, {limit: all?100000:perPage, offset: all?0:(page-1)*perPage}));
        res.json({ total: c.total||0, rows: data.rows||[] });
    } catch (e) { console.error('requeue abuse report failed: '+e.message); res.status(500).json({error:e.message}); }
});

app.get('/api/admin/reports/queue_summary_sla', async (req, res) => {
    try {
        const rows = db.reportQueueSummarySla({ from:req.query.from, to:req.query.to, queue:req.query.queue||'' }).rows || [];
        res.json({ rows });
    } catch (e) { console.error('queue summary report failed: '+e.message); res.status(500).json({error:e.message}); }
});

app.get('/api/admin/reports/hourly_traffic', async (req, res) => {
    try {
        const rows = db.reportHourlyTraffic({ from:req.query.from, to:req.query.to, queue:req.query.queue||'' }).rows || [];
        res.json({ rows });
    } catch (e) { console.error('hourly traffic report failed: '+e.message); res.status(500).json({error:e.message}); }
});

app.get('/api/admin/reports/queue_calls_detail', async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page,10)||1);
        const perPage = Math.min(10000, Math.max(1, parseInt(req.query.per_page,10)||50));
        const all = req.query.all === '1';
        const params = { from:req.query.from, to:req.query.to, queue:req.query.queue||'', agent:req.query.agent||'' };
        if (all) {
            const data = db.reportQueueCallsDetail(Object.assign({}, params, {limit:100000, offset:0}));
            return res.json({ total: data.total||data.rows.length, rows: data.rows||[] });
        }
        const data = db.reportQueueCallsDetail(Object.assign({}, params, {limit:perPage, offset:(page-1)*perPage, countOnly:false}));
        // get total
        const c = db.reportQueueCallsDetail(Object.assign({}, params, {countOnly:true}));
        res.json({ total: c.total||0, rows: data.rows||[] });
    } catch (e) { console.error('queue calls detail report failed: '+e.message); res.status(500).json({error:e.message}); }
});

app.get('/api/admin/reports/outbound_calls', async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page,10)||1);
        const perPage = Math.min(10000, Math.max(1, parseInt(req.query.per_page,10)||50));
        const all = req.query.all === '1';
        const params = { from:req.query.from, to:req.query.to, agentId: parseInt(req.query.agent_id,10)||null };
        if (all) {
            const data = await db.reportOutboundCalls(Object.assign({}, params, {limit:100000, offset:0}));
            // need total count - approximate by returning rows length; better count
            const c = await db.reportOutboundCalls(Object.assign({}, params, {countOnly:true}));
            return res.json({ total: c.total||data.rows.length, rows: data.rows||[] });
        }
        const c = await db.reportOutboundCalls(Object.assign({}, params, {countOnly:true}));
        const data = await db.reportOutboundCalls(Object.assign({}, params, {limit:perPage, offset:(page-1)*perPage}));
        res.json({ total: c.total||0, rows: data.rows||[] });
    } catch (e) { console.error('outbound calls report failed: '+e.message); res.status(500).json({error:e.message}); }
});

app.get('/api/admin/reports/filters', async (req, res) => {
    try {
        const agents = await db.allAgents();
        let queues = [];
        try { queues = await db.allAgentQueues(); } catch(e) {}
        // also from config
        try { const q2 = await db.listQueues(); for(const q of q2) if(!queues.includes(String(q))) queues.push(String(q)); } catch(e){}
        queues.sort();
        res.json({ agents: agents.map(a=>({id:a.id, username:a.username, extension:a.sip_extension})), queues });
    } catch (e) { res.status(500).json({error:e.message}); }
});

//-----------------------------------------------------------------------------
// custom report builder
//-----------------------------------------------------------------------------
const CUSTOM_REPORT_PARAMS = {
    ':from_date': 'from',
    ':to_date': 'to',
    ':agent_ext': 'agent',
    ':queue_name': 'queue',
    ':reason': 'reason',
};

function todayDateStr() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + da;
}

function normalizeCustomReportParam(value, kind) {
    let v = value == null ? '' : String(value).trim();
    if (kind === 'date') {
        return v || '';
    }
    if (v.toLowerCase() === 'all') v = '';
    return v;
}

function normalizeCustomReportParams(params, opts) {
    opts = opts || {};
    const today = todayDateStr();
    const from = normalizeCustomReportParam(params && (params.from || params.from_date), 'date') || (opts.defaultDates ? today : '');
    const to = normalizeCustomReportParam(params && (params.to || params.to_date), 'date') || (opts.defaultDates ? today : '');
    return {
        from,
        to,
        agent: normalizeCustomReportParam(params && (params.agent || params.agent_ext)),
        queue: normalizeCustomReportParam(params && (params.queue || params.queue_name)),
        reason: normalizeCustomReportParam(params && params.reason),
    };
}

function prepareCustomReportSql(rawSql, params, limitCap) {
    let sql = String(rawSql || '').trim();
    // strip leading line/block comments and whitespace, then trailing semicolons
    sql = sql.replace(/^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/\s*)+/g, '').trim();
    sql = sql.replace(/;\s*$/g, '').trim();
    if (!/^(select|with)\b/i.test(sql)) {
        throw new Error('query must start with SELECT or WITH');
    }
    if (/^with\b/i.test(sql) && !/\bselect\b/i.test(sql)) {
        throw new Error('WITH query must contain SELECT');
    }
    const forbidden = /\b(insert|update|delete|drop|alter|truncate|create|replace|grant|revoke|into\s+outfile|load_file)\b/i;
    if (forbidden.test(sql)) {
        throw new Error('query contains forbidden keyword');
    }
    if (sql.indexOf(';') !== -1) {
        throw new Error('multiple statements are not allowed');
    }
    const values = [];
    let bound = sql.replace(/:from_date|:to_date|:agent_ext|:queue_name|:reason/g, (m) => {
        const key = CUSTOM_REPORT_PARAMS[m];
        const v = params && params[key] != null ? String(params[key]) : '';
        values.push(v);
        return '?';
    });
    if (/:[a-zA-Z_]\w*/.test(bound)) {
        throw new Error('query contains unknown parameters');
    }
    const cap = Math.max(1, Math.min(5000, parseInt(limitCap, 10) || 5000));
    // CTE/WITH queries: older MariaDB (e.g. 10.3) may reject wrapped subqueries in some contexts;
    // execute directly and cap rows in Node. SELECT queries are safely wrapped with LIMIT.
    if (/^with\b/i.test(bound)) {
        return { sql: bound, values, cap, capInJs: true };
    }
    bound = 'SELECT * FROM (' + bound + ') AS _cr LIMIT ' + cap;
    return { sql: bound, values, cap, capInJs: false };
}

async function runCustomReportQuery(rawSql, params, limitCap) {
    const prepared = prepareCustomReportSql(rawSql, params, limitCap);
    let [rows] = await db.pool.execute(prepared.sql, prepared.values);
    if (prepared.capInJs && rows.length > prepared.cap) {
        rows = rows.slice(0, prepared.cap);
    }
    const columns = rows.length ? Object.keys(rows[0]) : [];
    return { columns, rows };
}

app.get('/api/admin/custom-reports', async (req, res) => {
    try {
        const activeOnly = String(req.query.active || '') === '1';
        const rows = await db.listCustomReports(activeOnly);
        res.json({ rows });
    } catch (e) {
        console.error('custom reports could not be listed: ' + e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/custom-reports', async (req, res) => {
    try {
        const body = req.body || {};
        const title = String(body.title || '').trim();
        const category = String(body.category || 'agents');
        const sql = String(body.sql_query || '');
        let filters = Array.isArray(body.filters) ? body.filters.filter(f => ['date','agent','queue','reason'].indexOf(f) !== -1) : ['date'];
        if (!filters.includes('date')) filters.unshift('date');
        if (!title) return res.status(400).json({ error: 'title is required' });
        if (['agents','queues','calls'].indexOf(category) === -1) return res.status(400).json({ error: 'invalid category' });
        if (!sql.trim()) return res.status(400).json({ error: 'sql_query is required' });
        prepareCustomReportSql(sql, {}, 1);
        const id = await db.createCustomReport({ title, category, filters, sql_query: sql, is_active: body.is_active !== false });
        res.status(201).json({ ok: true, id });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.put('/api/admin/custom-reports/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    try {
        const body = req.body || {};
        const data = {};
        if (body.title !== undefined) data.title = String(body.title).trim();
        if (body.category !== undefined) {
            if (['agents','queues','calls'].indexOf(String(body.category)) === -1) return res.status(400).json({ error: 'invalid category' });
            data.category = String(body.category);
        }
        if (body.filters !== undefined) {
            let filters = Array.isArray(body.filters) ? body.filters.filter(f => ['date','agent','queue','reason'].indexOf(f) !== -1) : ['date'];
            if (!filters.includes('date')) filters.unshift('date');
            data.filters = filters;
        }
        if (body.sql_query !== undefined) {
            prepareCustomReportSql(String(body.sql_query), {}, 1);
            data.sql_query = String(body.sql_query);
        }
        if (body.is_active !== undefined) data.is_active = !!body.is_active;
        const n = await db.updateCustomReport(id, data);
        if (!n) return res.status(404).json({ error: 'not found' });
        res.json({ ok: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.delete('/api/admin/custom-reports/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    try {
        const n = await db.deleteCustomReport(id);
        if (!n) return res.status(404).json({ error: 'not found' });
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/custom-reports/preview', async (req, res) => {
    try {
        const body = req.body || {};
        const sql = String(body.sql_query || '');
        if (!sql.trim()) return res.status(400).json({ error: 'sql_query is required' });
        const params = normalizeCustomReportParams(body, { defaultDates: true });
        const result = await runCustomReportQuery(sql, params, 15);
        res.json(result);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.get('/api/admin/custom-reports/:id/run', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    try {
        const report = await db.getCustomReport(id);
        if (!report) return res.status(404).json({ error: 'not found' });
        const params = normalizeCustomReportParams(req.query, { defaultDates: false });
        const result = await runCustomReportQuery(report.sql_query, params, 5000);
        res.json({ id: report.id, title: report.title, category: report.category, filters: report.filters, columns: result.columns, rows: result.rows, total: result.rows.length });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.get('/api/requeue-logs', async (req, res) => {
    if (!config.adminToken) return res.status(404).json({ error: 'the admin api is off' });
    const header = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (header !== config.adminToken) return res.status(401).json({ error: 'unauthorized' });
    try {
        const rows = await db.listRequeueLogs({
            queue: req.query.queue || '',
            agent: req.query.agent || '',
            limit: req.query.limit || 100,
        });
        res.json({ rows: rows });
    } catch (e) {
        console.error('requeue logs could not be read: ' + e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/live_state', async (req, res) => {
    let known = [];
    try {
        known = await db.knownAgents();
    } catch (e) {
        console.error('the database is not reachable: ' + e.message);
    }
    const agents = liveAgents();
    const kpis = Object.assign({}, queueSnapshot.kpis);
    kpis.agents_logged = agents.length;
    kpis.agents_paused = agents.filter(a => a.status === 'pause').length;
    res.json({ agents: agents, known: known, queues: queueSnapshot.queues, kpis: kpis, time: now() });
});

// The remote admin: the acceptance tests and the supervisor of the call
// center. It is behind the admin token, without it the endpoint is off.
app.post('/simulate/state', async (req, res) => {
    if (!config.adminToken) {
        return res.status(404).json({ error: 'the admin hook is off' });
    }
    const header = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (header !== config.adminToken) {
        return res.status(401).json({ error: 'unauthorized' });
    }

    const body = req.body || {};
    const status = body.status === 'pause' ? 'pause' : 'available';
    const reason = String(body.reason || '');
    const targets = body.extension ? [String(body.extension)] : Array.from(sessions.keys());

    let updated = 0;
    for (const extension of targets) {
        const entry = sessions.get(extension);
        if (!entry || !entry.ws || entry.ws.readyState !== 1) {
            continue;
        }
        if (status === 'pause' && entry.session.status !== 'pause') {
            entry.session.pauseCount = (entry.session.pauseCount || 0) + 1;
            const ast = todayAgentStatsByKey.get(entry.session.extension) || { callsTaken: 0, callsMade: 0, pauseCount: 0 };
            ast.pauseCount = entry.session.pauseCount;
            todayAgentStatsByKey.set(entry.session.extension, ast);
            scheduleAgentSave(entry.session.extension);
        }
        entry.session.status = status;
        entry.session.reason = reason;
        entry.session.statusSince = now();
        pushWhatsAppPresence(entry.session).catch(() => {});
        await db.logEvent(entry.session.agentId, status === 'pause' ? 'pause' : 'unpause', reason);
        await amiQueuePause(entry.session, status === 'pause', reason);
        broadcastSupervisor();
        entry.ws.send(JSON.stringify({
            event: 'state_update',
            extension: extension,
            status: status,
            reason: reason,
            assigned_queues: entry.session.queues,
            timestamp: now(),
        }));
        updated++;
    }
    console.log('the admin set ' + targets.join(',') + ' to ' + status + (reason ? ' (' + reason + ')' : ''));
    res.json({ ok: true, updated: updated });
});

//-----------------------------------------------------------------------------
// the whatsapp bridge (Phase 1: notifications only)
//-----------------------------------------------------------------------------
// The WhatsApp omnichannel service posts an agent's unread snapshot here
// whenever it changes (a new customer message, an assignment, a close, a
// read). The middleware forwards it to the agent's phonebar on its queue
// session socket — the same socket, and the same framing (one JSON object
// with an "event" field), as the crm_screen_pop copy above. Behind the
// same internal-token auth as the admin hook: the ADMIN_TOKEN as a Bearer
// header; with no ADMIN_TOKEN configured the route is off (404).
// ---- WhatsApp service calls (phonebar Phase 2) -----------------------
// The reverse direction of the Phase 1 bridge: this middleware calls
// the WhatsApp service's internal API (X-Internal-Token = the service's
// INTERNAL_API_TOKEN, configured here as WA_INTERNAL_TOKEN). Used for
// the login snapshot ping and the quick-reply forward. Best-effort by
// design: a down WhatsApp service must never disturb call handling.
function waInternalPost(pathName, payload, timeoutMs) {
    return new Promise((resolve) => {
        if (!config.waInternalUrl || !config.waInternalToken) {
            return resolve({ ok: false, status: 0, json: null, error: 'the WhatsApp link is not configured' });
        }
        let url;
        try {
            url = new URL(config.waInternalUrl + pathName);
        } catch (e) {
            return resolve({ ok: false, status: 0, json: null, error: 'bad WA_INTERNAL_URL' });
        }
        const body = JSON.stringify(payload || {});
        const lib = url.protocol === 'https:' ? https : http;
        const req = lib.request({
            method: 'POST',
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + url.search,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                'X-Internal-Token': config.waInternalToken,
            },
            timeout: timeoutMs || 10000,
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { /* non-JSON */ }
                const ok = res.statusCode >= 200 && res.statusCode < 300;
                resolve({ ok, status: res.statusCode, json, error: ok ? null : ((json && (json.message || json.error)) || 'HTTP ' + res.statusCode) });
            });
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', (e) => resolve({ ok: false, status: 0, json: null, error: e.message }));
        req.write(body);
        req.end();
    });
}

// GET twin of waInternalPost, for the provisioning pick-lists and the
// per-agent WhatsApp state (hub step 2). Same resolve contract.
function waInternalGet(pathName, timeoutMs) {
    return new Promise((resolve) => {
        if (!config.waInternalUrl || !config.waInternalToken) {
            return resolve({ ok: false, status: 0, json: null, error: 'the WhatsApp link is not configured' });
        }
        let url;
        try {
            url = new URL(config.waInternalUrl + pathName);
        } catch (e) {
            return resolve({ ok: false, status: 0, json: null, error: 'bad WA_INTERNAL_URL' });
        }
        const lib = url.protocol === 'https:' ? https : http;
        const req = lib.request({
            method: 'GET',
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + url.search,
            headers: { 'X-Internal-Token': config.waInternalToken },
            timeout: timeoutMs || 10000,
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { /* non-JSON */ }
                const ok = res.statusCode >= 200 && res.statusCode < 300;
                resolve({ ok, status: res.statusCode, json, error: ok ? null : ((json && (json.message || json.error)) || 'HTTP ' + res.statusCode) });
            });
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', (e) => resolve({ ok: false, status: 0, json: null, error: e.message }));
        req.end();
    });
}

// Agent provisioning (hub step 2): the Manage Agents page defines an
// agent once for every channel. It reads the Issabel users and the
// chat queues from the WhatsApp service, and after each save it posts
// the desired WhatsApp state there. Best-effort like the rest of the
// bridge: the call-center save never fails because WhatsApp is down —
// the outcome is reported back as wa_sync instead.
async function waProvisioningLists() {
    const [u, q] = await Promise.all([
        waInternalGet('/internal/issabel-users', 8000),
        waInternalGet('/internal/queues', 8000),
    ]);
    return {
        users: u.ok && u.json && Array.isArray(u.json.users) ? u.json.users : [],
        queues: q.ok && q.json && Array.isArray(q.json.queues) ? q.json.queues : [],
    };
}

async function waSyncAgentFor(issabelUserId, username, voiceQueues, chat) {
    if (!issabelUserId) return { skipped: true, reason: 'no Issabel user is linked' };
    if (!config.waInternalUrl || !config.waInternalToken) return { skipped: true, reason: 'the WhatsApp link is not configured' };
    let byId = new Map();
    if (chat && chat.enabled && Array.isArray(chat.queues) && chat.queues.length) {
        const lists = await waProvisioningLists();
        byId = new Map(lists.queues.map((q) => [Number(q.id), q]));
    }
    const voice = (voiceQueues || []).map((n) => String(n));
    const queues = (chat && Array.isArray(chat.queues) ? chat.queues : []).map((qid) => {
        const meta = byId.get(Number(qid));
        return {
            queue_id: Number(qid),
            can_chat: true,
            // voice on this queue only when the queue's linked
            // Asterisk queue is one of the agent's voice queues
            can_voice: !!(meta && meta.asterisk_queue && voice.indexOf(String(meta.asterisk_queue)) !== -1),
        };
    });
    const r = await waInternalPost('/internal/agents/sync', {
        issabel_user_id: issabelUserId,
        username: username || undefined,
        chat_enabled: !!(chat && chat.enabled),
        is_supervisor: !!(chat && chat.supervisor),
        // v5.35: the declared type — any voice queues at all makes
        // the phonebar govern his chat presence; none makes the web
        // module govern it (chat-only agent).
        has_voice: voice.length > 0,
        queues: queues,
    }, 15000);
    if (!r.ok) return { ok: false, error: r.error || ('the WhatsApp service answered ' + r.status) };
    return { ok: true };
}

// When a save carries an Issabel user id, the username belonging to
// it is taken from the WhatsApp service's list — the pair is never
// trusted from the request body alone (one identity, hub refinement).
async function normalizeIssabelPair(body) {
    const uid = parseInt(body.issabel_user_id, 10);
    if (!Number.isFinite(uid) || uid <= 0) return;
    try {
        const lists = await waProvisioningLists();
        const user = lists.users.find((u) => Number(u.issabel_user_id) === uid);
        if (user) body.issabel_username = user.username;
    } catch (e) { /* best-effort: keep what the page sent */ }
}

// The identity the WhatsApp service knows this agent by:
// cc_agents.issabel_username when set, else the session's login
// username (the same assumption Phase 1 notifications rely on).
async function waIdentityFor(session) {
    let issabelUsername = '';
    try {
        const [rows] = await db.pool.execute('SELECT issabel_username FROM cc_agents WHERE id = ? LIMIT 1', [session.agentId]);
        if (rows.length && rows[0].issabel_username) issabelUsername = String(rows[0].issabel_username);
    } catch (e) { /* identity falls back to the login username */ }
    return { username: session.username, issabel_username: issabelUsername || session.username };
}

// Unified presence (Phase 4): report each GLM agent's voice state to
// the WhatsApp service, which folds fresh reports into chat
// assignment — an agent on a call, paused or logged out is skipped
// for NEW chats, and the feed fails open after 120 s of silence, so
// a 30 s heartbeat re-posts every live session. Pushes are
// deduplicated by a per-agent signature: call-state reconciliation
// may call us often, only changes go on the wire.
const waPresenceSent = new Map();
async function pushWhatsAppPresence(session, force) {
    if (!session || !session.agentId) return;
    const voiceStatus = session.status === 'pause' ? 'pause' : 'available';
    // session.callState is NOT a boolean: queue reconciliation stores
    // 'ready-device' for a free device (Asterisk status 1), which is
    // truthy but means NO call. Only real call states count — the
    // same reading agentDisplayStatus uses.
    const inCall = !!session.callState && session.callState !== 'ready-device';
    // Split pause (v5.35): chat pause is independent of voice pause.
    const chatPaused = !!session.chatPaused;
    const sig = voiceStatus + '|' + (inCall ? 1 : 0) + '|' + (chatPaused ? 1 : 0);
    if (!force && waPresenceSent.get(session.agentId) === sig) return;
    waPresenceSent.set(session.agentId, sig);
    try {
        const identity = await waIdentityFor(session);
        await waInternalPost('/internal/presence', {
            username: identity.issabel_username, voice_status: voiceStatus, in_call: inCall, chat_paused: chatPaused,
        }, 10000);
    } catch (e) { /* the next change or heartbeat retries */ }
}
async function pushWhatsAppOffline(session) {
    if (!session || !session.agentId) return;
    waPresenceSent.delete(session.agentId);
    try {
        const identity = await waIdentityFor(session);
        await waInternalPost('/internal/presence', {
            username: identity.issabel_username, voice_status: 'offline', in_call: false,
        }, 10000);
    } catch (e) { /* the 120 s fail-open covers a lost goodbye */ }
}
let waPresenceTimer = null;
function startWhatsAppPresenceHeartbeat() {
    if (waPresenceTimer) return;
    waPresenceTimer = setInterval(() => {
        for (const entry of sessions.values()) {
            pushWhatsAppPresence(entry.session, true).catch(() => {});
        }
    }, 30 * 1000);
    if (waPresenceTimer.unref) waPresenceTimer.unref();
}

// An agent just came online: ask the WhatsApp service to push their
// current unread snapshot, so the phonebar badge is correct from the
// first second instead of waiting for the next WhatsApp event. A 404
// (the agent never opened the WhatsApp web UI, so the service has no
// identity for them yet) is expected and stays quiet.
function pingWhatsAppSnapshot(session) {
    if (!config.waInternalUrl || !config.waInternalToken) return;
    waIdentityFor(session)
        .then((identity) => waInternalPost('/internal/phonebar/snapshot', identity, 5000))
        .then((r) => {
            if (r && !r.ok && r.status !== 404) console.error('whatsapp bridge: the snapshot ping failed: ' + (r.error || r.status));
        })
        .catch((e) => console.error('whatsapp bridge: the snapshot ping failed: ' + e.message));
}

// A quick reply typed in the phonebar (Phase 2): forward it to the
// WhatsApp service — which runs it through the module's own send path
// (ownership checks, the outbound queue, every guardrail) — and relay
// the outcome back to the bar on the same socket.
async function handleWhatsAppReply(entry, msg) {
    const session = entry.session;
    const ws = entry.ws;
    const ticketId = parseInt(msg.ticket_id, 10);
    const text = String(msg.text || '').trim();
    const answer = (ok, error) => {
        try { ws.send(JSON.stringify({ event: 'whatsapp_reply_result', ticket_id: Number.isFinite(ticketId) ? ticketId : 0, ok: !!ok, error: error || null })); } catch (e) { /* socket gone */ }
    };
    if (!Number.isFinite(ticketId) || !text) return answer(false, 'invalid reply');
    const identity = await waIdentityFor(session);
    const r = await waInternalPost('/internal/phonebar/reply', Object.assign({}, identity, { ticket_id: ticketId, text }), 15000);
    if (r.ok && r.json && r.json.ok) return answer(true, null);
    return answer(false, (r.json && (r.json.message || r.json.error)) || r.error || 'send failed');
}

// The phonebar chat window (v5.24): the agent opened a conversation in
// the separate WhatsApp window. The thread (recent history, media
// inlined by the service, the line/team identity) comes back over the
// same socket; opening it marks the ticket read on the service side,
// under the module's own ownership rules — same trust shape as the
// quick reply: identity from this session, never from the payload.
async function handleWhatsAppThread(entry, msg) {
    const session = entry.session;
    const ws = entry.ws;
    const ticketId = parseInt(msg.ticket_id, 10);
    const answer = (ok, thread, error) => {
        try { ws.send(JSON.stringify({ event: 'whatsapp_thread_result', ticket_id: Number.isFinite(ticketId) ? ticketId : 0, ok: !!ok, thread: thread || null, error: error || null })); } catch (e) { /* socket gone */ }
    };
    if (!Number.isFinite(ticketId)) return answer(false, null, 'invalid ticket');
    const identity = await waIdentityFor(session);
    const r = await waInternalPost('/internal/phonebar/thread', Object.assign({}, identity, { ticket_id: ticketId }), 30000);
    if (r.ok && r.json && r.json.ok) return answer(true, r.json.thread || null, null);
    return answer(false, null, (r.json && (r.json.message || r.json.error)) || r.error || 'thread failed');
}

// The chat window's status actions (Open / Waiting / Closed): the
// service applies the web UI's exact status rules and audits the
// change; here we only forward and relay the outcome.
async function handleWhatsAppStatus(entry, msg) {
    const session = entry.session;
    const ws = entry.ws;
    const ticketId = parseInt(msg.ticket_id, 10);
    const status = String(msg.status || '');
    const answer = (ok, error) => {
        try { ws.send(JSON.stringify({ event: 'whatsapp_status_result', ticket_id: Number.isFinite(ticketId) ? ticketId : 0, ok: !!ok, status, error: error || null })); } catch (e) { /* socket gone */ }
    };
    if (!Number.isFinite(ticketId) || !status) return answer(false, 'invalid status change');
    const identity = await waIdentityFor(session);
    const r = await waInternalPost('/internal/phonebar/status', Object.assign({}, identity, { ticket_id: ticketId, status }), 15000);
    if (r.ok && r.json && r.json.ok) return answer(true, null);
    return answer(false, (r.json && (r.json.message || r.json.error)) || r.error || 'status failed');
}

// Chat-window media sending (Phase 3): the file rides the socket as
// base64 (a 10 MB file is ~13.3 MB of JSON — inside the ws default
// 100 MB payload limit and the service's 45 MB body limit). The
// service enforces the D6 Settings cap and the unofficial-only rule;
// here we only forward and relay.
async function handleWhatsAppMedia(entry, msg) {
    const session = entry.session;
    const ws = entry.ws;
    const ticketId = parseInt(msg.ticket_id, 10);
    const answer = (ok, error) => {
        try { ws.send(JSON.stringify({ event: 'whatsapp_media_result', ticket_id: Number.isFinite(ticketId) ? ticketId : 0, ok: !!ok, error: error || null })); } catch (e) { /* socket gone */ }
    };
    if (!Number.isFinite(ticketId) || !msg.data_base64) return answer(false, 'invalid media');
    const identity = await waIdentityFor(session);
    const r = await waInternalPost('/internal/phonebar/media', Object.assign({}, identity, {
        ticket_id: ticketId,
        filename: String(msg.filename || 'file').slice(0, 200),
        mime: String(msg.mime || 'application/octet-stream').slice(0, 120),
        caption: String(msg.caption || '').slice(0, 1000),
        data_base64: String(msg.data_base64),
    }), 60000);
    if (r.ok && r.json && r.json.ok) return answer(true, null);
    return answer(false, (r.json && (r.json.message || r.json.error)) || r.error || 'media send failed');
}

// Chat-window transfer (Phase 3): the options list (agents + queues
// with their badge codes) and the transfer itself. The service runs
// the web transfer rules — one target, closed tickets refused, queue
// transfers re-offered under the queue's own routing strategy.
async function handleWhatsAppTransferOptions(entry, msg) {
    const session = entry.session;
    const ws = entry.ws;
    const ticketId = parseInt(msg.ticket_id, 10);
    const answer = (ok, options, error) => {
        try { ws.send(JSON.stringify({ event: 'whatsapp_transfer_options_result', ticket_id: Number.isFinite(ticketId) ? ticketId : 0, ok: !!ok, options: options || null, error: error || null })); } catch (e) { /* socket gone */ }
    };
    if (!Number.isFinite(ticketId)) return answer(false, null, 'invalid ticket');
    const identity = await waIdentityFor(session);
    const r = await waInternalPost('/internal/phonebar/transfer-options', Object.assign({}, identity, { ticket_id: ticketId }), 15000);
    if (r.ok && r.json && r.json.ok) return answer(true, r.json, null);
    return answer(false, null, (r.json && (r.json.message || r.json.error)) || r.error || 'options failed');
}

async function handleWhatsAppTransfer(entry, msg) {
    const session = entry.session;
    const ws = entry.ws;
    const ticketId = parseInt(msg.ticket_id, 10);
    const answer = (ok, error) => {
        try { ws.send(JSON.stringify({ event: 'whatsapp_transfer_result', ticket_id: Number.isFinite(ticketId) ? ticketId : 0, ok: !!ok, error: error || null })); } catch (e) { /* socket gone */ }
    };
    if (!Number.isFinite(ticketId)) return answer(false, 'invalid ticket');
    const payload = { ticket_id: ticketId };
    if (msg.agent_id != null) payload.agent_id = parseInt(msg.agent_id, 10);
    if (msg.team_id != null) payload.team_id = parseInt(msg.team_id, 10);
    if (payload.agent_id == null && payload.team_id == null) return answer(false, 'invalid transfer target');
    const identity = await waIdentityFor(session);
    const r = await waInternalPost('/internal/phonebar/transfer', Object.assign({}, identity, payload), 15000);
    if (r.ok && r.json && r.json.ok) return answer(true, null);
    return answer(false, (r.json && (r.json.message || r.json.error)) || r.error || 'transfer failed');
}

// Chat window unassign (v5.32): the WhatsApp service enforces
// supervisor-only from the stamped session identity; this leg only
// forwards. The answer carries the new assignee (null = back in the
// queue pool) so the window can say what happened.
async function handleWhatsAppUnassign(entry, msg) {
    const session = entry.session;
    const ws = entry.ws;
    const ticketId = parseInt(msg.ticket_id, 10);
    const answer = (ok, assignedUserId, error) => {
        try { ws.send(JSON.stringify({ event: 'whatsapp_unassign_result', ticket_id: Number.isFinite(ticketId) ? ticketId : 0, ok: !!ok, assigned_user_id: assignedUserId != null ? assignedUserId : null, error: error || null })); } catch (e) { /* socket gone */ }
    };
    if (!Number.isFinite(ticketId)) return answer(false, null, 'invalid ticket');
    const identity = await waIdentityFor(session);
    const r = await waInternalPost('/internal/phonebar/unassign', Object.assign({}, identity, { ticket_id: ticketId }), 15000);
    if (r.ok && r.json && r.json.ok) return answer(true, r.json.assigned_user_id != null ? r.json.assigned_user_id : null, null);
    return answer(false, null, (r.json && (r.json.message || r.json.error)) || r.error || 'unassign failed');
}

// Internal: create a CRM ticket from the WhatsApp module (escalation
// from inside a chat). Same trust as /internal/whatsapp/events — the
// middleware ADMIN_TOKEN, server-to-server only. The customer is found
// by normalized phone, or created on the spot when this is their first
// CRM record.
app.post('/internal/crm/tickets', async (req, res) => {
    if (!config.adminToken) {
        return res.status(404).json({ error: 'the admin hook is off' });
    }
    const header = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (header !== config.adminToken) {
        return res.status(401).json({ error: 'unauthorized' });
    }
    try {
        const b = req.body || {};
        const phone = String(b.phone || '').trim();
        const normalized = normalizePhone(phone);
        if (!phone || !normalized) return res.status(400).json({ error: 'phone is required' });
        const name = String(b.name || '').trim() || phone;
        const subject = String(b.subject || '').trim() || ('WhatsApp escalation — ' + name);
        const priority = ['Low', 'Medium', 'High', 'Urgent'].indexOf(String(b.priority || 'High')) !== -1 ? String(b.priority || 'High') : 'High';
        const status = ['Open', 'In Progress', 'Waiting Customer', 'Escalated', 'Closed'].indexOf(String(b.status || 'Escalated')) !== -1 ? String(b.status || 'Escalated') : 'Escalated';
        const desc = b.description ? String(b.description) : null;
        const [cust] = await db.pool.execute('SELECT id FROM crm_customers WHERE phone_normalized = ? LIMIT 1', [normalized]);
        let customerId;
        let customerCreated = false;
        if (cust.length) {
            customerId = cust[0].id;
        } else {
            const [r] = await db.pool.execute(
                'INSERT INTO crm_customers (full_name, primary_phone, phone_normalized, secondary_phone, company, email, tag, address, custom_fields, assigned_agent_id, category_code) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                [name, phone, normalized, null, null, b.email ? String(b.email).trim() : null, 'NORMAL', null, null, null, 'NORMAL']);
            customerId = r.insertId;
            customerCreated = true;
        }
        const [r] = await db.pool.execute(
            'INSERT INTO crm_tickets (customer_id, subject, category, priority, status, created_by_agent_id, assigned_agent_id, due_at, description) VALUES (?,?,?,?,?,?,?,?,?)',
            [customerId, subject, 'WhatsApp', priority, status, null, null, null, desc]);
        const ticketNumber = 'TCK-' + (1000 + r.insertId);
        await db.pool.execute('UPDATE crm_tickets SET ticket_number = ? WHERE id = ?', [ticketNumber, r.insertId]);
        await db.pool.execute('INSERT INTO crm_ticket_logs (ticket_id, action_type, from_agent_id, to_agent_id, old_status, new_status, note) VALUES (?,?,?,?,?,?,?)',
            [r.insertId, 'created', null, null, null, status, 'Created from the WhatsApp module (escalation)']);
        res.status(201).json({ ok: true, id: r.insertId, ticket_number: ticketNumber, customer_id: customerId, customer_created: customerCreated });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/internal/whatsapp/events', async (req, res) => {
    if (!config.adminToken) {
        return res.status(404).json({ error: 'the admin hook is off' });
    }
    const header = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (header !== config.adminToken) {
        return res.status(401).json({ error: 'unauthorized' });
    }

    const body = req.body || {};
    const identity = body.issabel_user_id != null ? String(body.issabel_user_id) : '';
    if (!identity) {
        return res.status(400).json({ error: 'issabel_user_id is required' });
    }

    // Resolve the identity to the live queue session of the agent. The
    // sessions carry the login username (see findAgentByIssabelIdentity in
    // db.js for the documented identity assumption): a live session whose
    // username matches wins; the cc_agents mapping is the fallback.
    let entry = null;
    for (const e of sessions.values()) {
        if (e.session && e.session.username === identity) {
            entry = e;
            break;
        }
    }
    if (!entry) {
        try {
            const agent = await db.findAgentByIssabelIdentity(identity);
            if (agent) {
                entry = sessions.get(String(agent.sip_extension)) || null;
            }
        } catch (e) {
            console.error('whatsapp bridge: the agent lookup failed: ' + e.message);
        }
    }
    if (!entry || !entry.ws || entry.ws.readyState !== 1) {
        // The agent is offline: the snapshot is dropped on purpose. The bar
        // rebuilds its state from the next event after the agent logs in.
        return res.json({ ok: true, delivered: false });
    }

    const data = {
        issabel_user_id: body.issabel_user_id,
        kind: body.kind === 'assigned' ? 'assigned' : 'snapshot',
        unread_total: Number(body.unread_total) || 0,
        tickets: Array.isArray(body.tickets) ? body.tickets.slice(0, 10) : [],
    };
    if (body.assigned_ticket && typeof body.assigned_ticket === 'object') {
        data.assigned_ticket = body.assigned_ticket;
    }
    try {
        entry.ws.send(JSON.stringify(Object.assign({}, data, { event: 'whatsapp_update' })));
    } catch (e) {
        return res.json({ ok: true, delivered: false });
    }
    return res.json({ ok: true, delivered: true });
});

// The dashboard of the supervisor is a static page.
app.use(express.static(path.join(__dirname, 'public')));

//-----------------------------------------------------------------------------
// the websocket of the agents
//-----------------------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// extension -> { ws, session }
const sessions = new Map();

server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== '/ws') {
        socket.destroy();
        return;
    }
    const header = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    // A browser cannot send headers on a websocket, the dashboard/agent workspace sends the
    // token in the query. Only admin token or agent-workspace tokens are accepted there; the
    // softphone agent token stays in the header and remains a queue session.
    const query = url.searchParams.get('token') || '';
    const ssoTok = url.searchParams.get('issabel_sso') || url.searchParams.get('sso') || '';
    const isWorkspace = String(url.searchParams.get('client') || '') === 'workspace' || String(url.searchParams.get('workspace') || '') === '1';
    if (config.adminToken && (header === config.adminToken || query === config.adminToken)) {
        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req, { isAdmin: true, role: 'admin' });
        });
        return;
    }
    if (query || ssoTok) {
        const tok = query || ssoTok;
        const qp = verifyToken(tok);
        if (qp && qp.issabel_user) {
            // resolve async in connection handler context via promise attached? simpler: do sync-ish by scheduling resolution
            wss.handleUpgrade(req, socket, head, async (ws) => {
                let agent = null;
                try { agent = await db.findAgentByIssabelUsername(String(qp.issabel_user)); } catch (_) {}
                if (agent) {
                    wss.emit('connection', ws, req, { isAdmin: false, isAgentWorkspace: true, role: 'agent', agent_id: agent.id, agent_ext: String(agent.sip_extension || ''), agent_name: agent.username, issabel_user: String(qp.issabel_user) });
                } else {
                    wss.emit('connection', ws, req, { isAdmin: true, role: 'admin', issabel_user: String(qp.issabel_user) });
                }
            });
            return;
        }
        if (qp && (qp.agent_id || qp.agentId) && isWorkspace) {
            wss.handleUpgrade(req, socket, head, (ws) => {
                wss.emit('connection', ws, req, {
                    isAdmin: false,
                    isAgentWorkspace: true,
                    role: 'agent',
                    agent_id: qp.agent_id || qp.agentId,
                    agent_ext: String(qp.extension || qp.agent_ext || ''),
                    agent_name: String(qp.username || qp.agent_name || ''),
                });
            });
            return;
        }
    }
    const payload = verifyToken(header);
    if (!payload) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req, payload);
    });
});

function dropSession(entry, why) {
    if (!entry || entry.dropped) {
        return;
    }
    entry.dropped = true;
    sessions.delete(entry.session.extension);
    // Phase 4: the WhatsApp module hears the agent is gone.
    pushWhatsAppOffline(entry.session).catch(() => {});
    console.log('the agent ' + entry.session.extension + ' leaves the queues (' + why + ')');
    broadcastSupervisor();
    amiQueueRemove(entry.session).catch(() => {});
    db.logEvent(entry.session.agentId, 'logout', entry.session.reason).catch(() => {});
    try {
        entry.ws.close();
    } catch (e) {
        // the socket is already gone
    }
}

wss.on('connection', (ws, req, payload) => {
    // A dashboard/admin or agent workspace only watches CRM/supervisor data; it never touches asterisk.
    if (payload && (payload.isAdmin || payload.isAgentWorkspace)) {
        const isAdmin = !!payload.isAdmin || payload.role === 'admin';
        const entry = {
            ws,
            session: { isAdmin },
            isAdmin,
            role: isAdmin ? 'admin' : 'agent',
            agent_id: payload.agent_id || null,
            agent_ext: payload.agent_ext || '',
            agent_name: payload.agent_name || '',
        };
        adminSessions.add(entry);
        console.log((isAdmin ? 'a supervisor' : ('agent workspace ' + entry.agent_ext)) + ' is watching (' + adminSessions.size + ')');
        if (isAdmin) {
            const agents = liveAgents();
            const kpis = Object.assign({}, queueSnapshot.kpis);
            kpis.agents_logged = agents.length;
            kpis.agents_paused = agents.filter(a => a.status === 'pause').length;
            ws.send(JSON.stringify({ event: 'supervisor_update', agents: agents, queues: queueSnapshot.queues, kpis: kpis, time: now() }));
        } else {
            ws.send(JSON.stringify({ event: 'crm_workspace_ready', role: 'agent', agent_id: entry.agent_id, agent_ext: entry.agent_ext, agent_name: entry.agent_name, time: now() }));
        }
        ws.on('close', () => {
            adminSessions.delete(entry);
            console.log((isAdmin ? 'a supervisor' : ('agent workspace ' + entry.agent_ext)) + ' is gone (' + adminSessions.size + ')');
        });
        ws.on('error', () => {
            adminSessions.delete(entry);
        });
        return;
    }

    const session = {
        agentId: payload.agent_id,
        username: payload.username,
        extension: payload.extension,
        queues: payload.queues || [],
        status: 'available',
        reason: '',
        statusSince: now(),
        missed: 0,
        dropped: false,
        pauseCount: 0,
        callsMade: 0,
        callsTaken: 0,
          talkingCaller: '',
          callState: null,
          callSince: 0,
          activeQueue: '',
          activeCallUid: '',
          chatPaused: false,
      };
    const st = todayAgentStatsByKey.get(session.extension);
    if (st) { session.callsTaken = st.callsTaken || 0; session.callsMade = st.callsMade || 0; session.pauseCount = st.pauseCount || 0; }
    else { todayAgentStatsByKey.set(session.extension, { callsTaken: 0, callsMade: 0, pauseCount: 0 }); }
    const entry = { ws: ws, session: session };
    sessions.set(session.extension, entry);
    // phonebar Phase 2: the agent's WhatsApp badge should be correct
    // from the first second of the session, not from the next event
    pingWhatsAppSnapshot(session);
    // Phase 4: announce the agent's voice presence to WhatsApp.
    pushWhatsAppPresence(session, true).catch(() => {});
    if (!abuseStatsByExt.has(session.extension)) {
        abuseStatsByExt.set(session.extension, { abuse_timeout: 0, abuse_declined: 0, abuse_total: 0, abuse_recent: [] });
    }
    // the agent belongs to its queues from now on
    amiQueueAdd(session).catch((e) => console.error('the queues failed: ' + e.message));
    broadcastSupervisor();

    ws.on('message', async (raw) => {
        let msg = {};
        try {
            msg = JSON.parse(raw.toString());
        } catch (e) {
            return;
        }
        if (msg.event === 'pong') {
            session.missed = 0;
            return;
        }
        if (msg.event === 'whatsapp_reply') {
            // phonebar Phase 2 quick reply; the agent identity comes
            // from this session, never from the payload
            handleWhatsAppReply(entry, msg).catch((e) => console.error('whatsapp bridge: reply failed: ' + e.message));
            return;
        }
        if (msg.event === 'whatsapp_thread') {
            // chat window thread fetch (v5.24); identity from this
            // session, never from the payload
            handleWhatsAppThread(entry, msg).catch((e) => console.error('whatsapp bridge: thread failed: ' + e.message));
            return;
        }
        if (msg.event === 'whatsapp_status') {
            // chat window status action (v5.24); identity from this
            // session, never from the payload
            handleWhatsAppStatus(entry, msg).catch((e) => console.error('whatsapp bridge: status failed: ' + e.message));
            return;
        }
        if (msg.event === 'whatsapp_media') {
            // chat window media send (Phase 3); identity from this
            // session, never from the payload
            handleWhatsAppMedia(entry, msg).catch((e) => console.error('whatsapp bridge: media failed: ' + e.message));
            return;
        }
        if (msg.event === 'whatsapp_transfer_options') {
            // chat window transfer menu data (Phase 3)
            handleWhatsAppTransferOptions(entry, msg).catch((e) => console.error('whatsapp bridge: transfer options failed: ' + e.message));
            return;
        }
        if (msg.event === 'whatsapp_transfer') {
            // chat window transfer (Phase 3)
            handleWhatsAppTransfer(entry, msg).catch((e) => console.error('whatsapp bridge: transfer failed: ' + e.message));
            return;
        }
        if (msg.event === 'whatsapp_unassign') {
            // chat window unassign, supervisors only (v5.32)
            handleWhatsAppUnassign(entry, msg).catch((e) => console.error('whatsapp bridge: unassign failed: ' + e.message));
            return;
        }
        if (msg.event === 'chat_pause') {
            // Split pause (v5.35): the agent pauses CHATS only —
            // voice status and Asterisk are untouched; the new flag
            // rides the next presence push to the WhatsApp module.
            session.chatPaused = !!msg.paused;
            pushWhatsAppPresence(session).catch(() => {});
            return;
        }
        if (msg.event !== 'status_change') {
            console.log('<- ' + raw.toString());
            return;
        }
        if (msg.status === 'offline') {
            // the agent logs out
            dropSession(entry, 'offline event');
            return;
        }
        // the vocabulary of the client is available / pause
        const status = msg.status === 'pause' ? 'pause' : 'available';
        const reason = String(msg.reason || '');
        if (status === 'pause' && session.status !== 'pause') {
            session.pauseCount = (session.pauseCount || 0) + 1;
            const ast = todayAgentStatsByKey.get(session.extension) || { callsTaken: 0, callsMade: 0, pauseCount: 0 };
            ast.pauseCount = session.pauseCount;
            todayAgentStatsByKey.set(session.extension, ast);
            scheduleAgentSave(session.extension);
        }
        session.status = status;
        session.reason = reason;
        session.statusSince = now();
        // allow client to report active call info if provided
        if (msg.call_state || msg.caller_id || msg.talking_caller) {
            setSessionCallState(session, msg.call_state || session.callState, msg.caller_id || msg.talking_caller || msg.caller || '');
        } else if (status === 'pause') {
            // paused from agent side may interrupt call state tracking
            // keep call state as-is; member snapshot will reconcile
        }
        await db.logEvent(session.agentId, status === 'pause' ? 'pause' : 'unpause', reason);
        await amiQueuePause(session, status === 'pause', reason);
        broadcastSupervisor();
        // the echo carries exactly what the agent sent, so the agent does not
        // take its own change for a new one
        ws.send(JSON.stringify({
            event: 'state_update',
            extension: session.extension,
            status: status,
            reason: reason,
            assigned_queues: session.queues,
            timestamp: now(),
        }));
        // Phase 4: WhatsApp hears about the pause / resume too.
        pushWhatsAppPresence(session).catch(() => {});
    });

    ws.on('close', () => {
        dropSession(entry, 'the socket was closed');
    });
    ws.on('error', () => {
        dropSession(entry, 'the socket failed');
    });
});

// The events of asterisk: queue/member changes and call progress events.
function clearAgentCallState(session, toReady) {
    session.talkingCaller = '';
    session.callState = null;
    session.callSince = 0;
    session.activeChannel = null;
    session.activeQueue = '';
    session.activeCallUid = '';
    if (toReady) session.statusSince = now();
    pushWhatsAppPresence(session).catch(() => {});
}

function callIdKey(fields, q, caller) {
    return String(fields.Uniqueid || fields.Linkedid || (q ? (q + ':' + (caller || '')) : '') || '');
}

function onAmiEvent(name, fields) {
    // real-time queue and call events
    if (name === 'QueueCallerJoin') {
        const q = String(fields.Queue || '');
        const caller = String(fields.CallerIDNum || fields.CallerID || fields.CallerIDName || '').trim();
        if (q && caller) {
            const uid = String(fields.Uniqueid || fields.Linkedid || '');
            if (uid) callQueueByUid.set(uid, q);
            if (!waitingCallsByQueue.has(q)) waitingCallsByQueue.set(q, []);
            const joinedAt = now() * 1000;
            waitingCallsByQueue.get(q).push({ caller, joinedAt });
            let qObj = queueSnapshot.queues.find((x) => String(x.queue) === q);
            if (!qObj) {
                qObj = { queue: q, waiting: 0, in_call: 0, longest_wait: 0, entries: [], completed: null, abandoned: null, calls: null, transferred: null, sla_text: 'N/A', servicelevel: null, servicelevel_perf: null, holdtime: null };
                queueSnapshot.queues.push(qObj);
            }
            qObj.entries = qObj.entries || [];
            qObj.entries.push({ caller, wait: 0, joinedAt, position: null });
            qObj.waiting = (qObj.waiting || 0) + 1;
            evKpi.waiting = (evKpi.waiting || 0) + 1;
            applyEventKpis();
            broadcastSupervisor();
        }
        return;
    }
    if (name === 'QueueCallerLeave') {
        const q = String(fields.Queue || '');
        const caller = String(fields.CallerIDNum || fields.CallerID || fields.CallerIDName || '').trim();
        const list = waitingCallsByQueue.get(q) || [];
        const idx = list.findIndex((c) => c.caller === caller);
        if (idx >= 0) list.splice(idx, 1);
        if (list.length === 0) waitingCallsByQueue.delete(q);
        const qObj = queueSnapshot.queues.find((x) => String(x.queue) === q);
        if (qObj && qObj.entries) { const i2 = qObj.entries.findIndex((e) => e.caller === caller); if (i2 >= 0) qObj.entries.splice(i2, 1); }
        if (qObj) { qObj.waiting = Math.max(0, (qObj.waiting || 0) - 1); }
        evKpi.waiting = Math.max(0, (evKpi.waiting || 0) - 1);
        applyEventKpis();
        broadcastSupervisor();
        return;
    }
    if (name === 'QueueCallerAbandon') {
        const q = String(fields.Queue || '');
        const caller = String(fields.CallerIDNum || fields.CallerID || fields.CallerIDName || '').trim();
        const id = callIdKey(fields, q, caller);
        const list = waitingCallsByQueue.get(q) || [];
        const idx = list.findIndex((c) => c.caller === caller);
        if (idx >= 0) list.splice(idx, 1);
        if (list.length === 0) waitingCallsByQueue.delete(q);
        const qObj = queueSnapshot.queues.find((x) => String(x.queue) === q);
        if (qObj && qObj.entries) { const i2 = qObj.entries.findIndex((e) => e.caller === caller); if (i2 >= 0) qObj.entries.splice(i2, 1); }
        if (qObj) { qObj.waiting = Math.max(0, (qObj.waiting || 0) - 1); }
        evKpi.waiting = Math.max(0, (evKpi.waiting || 0) - 1);
        if (!countedAbandonedCalls.has(id)) {
            countedAbandonedCalls.add(id);
            evKpi.abandoned = (evKpi.abandoned || 0) + 1;
            scheduleKpiSave();
        }
        applyEventKpis();
        broadcastSupervisor();
        return;
    }
    if (name === 'AgentCalled') {
        const entry = findSessionByInterfaceOrChannel(fields, ['Interface', 'MemberName', 'Member', 'DestChannel', 'Channel', 'DestCallerIDNum']);
        if (entry) {
            const caller = String(fields.CallerIDNum || fields.ConnectedLineNum || fields.CallerID || fields.CallerIDName || '').trim();
            const uid = String(fields.Uniqueid || fields.Linkedid || '');
            setSessionCallState(entry.session, 'ringing', caller);
            entry.session.activeQueue = String(fields.Queue || callQueueByUid.get(uid) || '');
            entry.session.activeCallUid = uid;
            entry.session.statusSince = now();
            const destChannel = String(fields.DestChannel || fields.DestUniqueid && '' || '');
            const dc = String(fields.DestChannel || '');
            if (dc) {
                const qName = String(fields.Queue || entry.session.activeQueue || '');
                const qObj = queueSnapshot.queues.find((x) => String(x.queue) === qName);
                ringAttemptsByDestChannel.set(dc, {
                    callUid: String(fields.Linkedid || fields.Uniqueid || ''),
                    queue: qName,
                    callerId: caller,
                    agentExt: entry.session.extension,
                    agentName: entry.session.username || '',
                    destChannel: dc,
                    startedAt: Date.now(),
                    hangupCause: null,
                    queueTimeoutSec: (qObj && qObj.timeout) ? qObj.timeout : 15,
                });
            }
            crmHandleScreenPop(entry.session.extension, caller, uid).catch(() => {});
            applyEventKpis();
            broadcastSupervisor();
        }
        return;
    }
    if (name === 'DialBegin' || name === 'Dial') {
        const dest = String(fields.DestChannel || fields.Destination || fields.Channel || '');
        const m = dest.match(/\b(?:SIP|PJSIP|IAX2)\/(\d{2,6})\b/i);
        if (m) {
            const ext = m[1];
            const entry = sessions.get(ext);
            if (entry) {
                const caller = String(fields.CallerIDNum || fields.ConnectedLineNum || fields.CallerID || fields.CallerIDName || '').trim();
                const uid = String(fields.Uniqueid || fields.Linkedid || fields.DestUniqueid || '');
                crmHandleScreenPop(ext, caller, uid).catch(() => {});
            }
        }
    }

    if (name === 'AgentConnect') {
        const entry = findSessionByInterfaceOrChannel(fields, ['Interface', 'MemberName', 'Member', 'DestChannel', 'Channel']);
        if (entry) {
            const caller = String(fields.CallerIDNum || fields.ConnectedLineNum || fields.CallerID || fields.CallerIDName || '').trim();
            const prevState = entry.session.callState;
            const uid = String(fields.Uniqueid || fields.Linkedid || '');
            const q = String(fields.Queue || callQueueByUid.get(uid) || '');
            setSessionCallState(entry.session, 'in-call', caller || entry.session.talkingCaller);
            entry.session.activeQueue = q || entry.session.activeQueue || '';
            entry.session.activeCallUid = uid || entry.session.activeCallUid || '';
            entry.session.statusSince = now();
            const holdSec = Number(fields.HoldTime || 0);
            if (Number.isFinite(holdSec)) { evKpi.asaSum += holdSec; evKpi.asaN++; scheduleKpiSave(); }
            if (prevState !== 'in-call') {
                evKpi.waiting = Math.max(0, (evKpi.waiting || 0) - 1);
                evKpi.active = (evKpi.active || 0) + 1;
                const qObj = queueSnapshot.queues.find((x) => String(x.queue) === q);
                if (qObj) { qObj.waiting = Math.max(0, (qObj.waiting || 0) - 1); qObj.in_call = (qObj.in_call || 0) + 1; }
            }
            applyEventKpis();
            broadcastSupervisor();
        }
        return;
    }
    if (name === 'AgentComplete' || name === 'AgentRingNoAnswer') {
        const entry = findSessionByInterfaceOrChannel(fields, ['Interface', 'MemberName', 'Member', 'DestChannel', 'Channel']);
        if (entry) {
            const wasInCall = !!entry.session.callState;
            const id = callIdKey(fields, String(fields.Queue || ''), String(fields.CallerIDNum || fields.CallerID || ''));
            if (wasInCall) {
                const talk = Math.max(0, now() - (entry.session.callSince || now()));
                evKpi.talkSum += talk;
                evKpi.talkN++;
                scheduleKpiSave();
            }
            if (name === 'AgentComplete') {
                entry.session.callsTaken = (entry.session.callsTaken || 0) + 1;
                const ast = todayAgentStatsByKey.get(entry.session.extension) || { callsTaken: 0, callsMade: 0, pauseCount: 0 };
                ast.callsTaken = entry.session.callsTaken;
                todayAgentStatsByKey.set(entry.session.extension, ast);
                scheduleAgentSave(entry.session.extension);
                if (!countedCompletedCalls.has(id)) {
                    countedCompletedCalls.add(id);
                    evKpi.completed = (evKpi.completed || 0) + 1;
                    scheduleKpiSave();
                }
            }
            if (name === 'AgentRingNoAnswer') {
                const dc = String(fields.DestChannel || '');
                const ext = entry.session.extension;
                let attempt = dc ? ringAttemptsByDestChannel.get(dc) : null;
                if (!attempt) {
                    const uid = String(fields.Uniqueid || fields.Linkedid || '');
                    for (const a of ringAttemptsByDestChannel.values()) {
                        if (a.agentExt === ext && (!uid || a.callUid === uid)) { attempt = a; break; }
                    }
                }
                if (attempt) {
                    const cause = String(attempt.hangupCause || '');
                    const rawRing = Number(fields.RingTime || 0);
                    // Asterisk 20 reports RingTime in microseconds (e.g., 15000000 for 15s)
                    const ringDurationMs = rawRing >= 100000 ? Math.round(rawRing / 1000) : (rawRing || (Date.now() - attempt.startedAt));
                    const ringSec = ringDurationMs / 1000;
                    const queueTimeoutSec = (attempt.queueTimeoutSec && attempt.queueTimeoutSec > 0) ? attempt.queueTimeoutSec : 15;
                    const reason = (cause === '21' || cause === '17' || (queueTimeoutSec > 2 && ringSec < queueTimeoutSec - 1.5)) ? 'DECLINED' : 'TIMEOUT';
                    const qn = attempt.queue || String(fields.Queue || '');
                    const cid = attempt.callerId || String(fields.CallerIDNum || '');
                    db.insertRequeueLog({
                        call_uid: attempt.callUid,
                        queue_name: qn,
                        caller_id: cid,
                        agent_ext: attempt.agentExt,
                        agent_name: attempt.agentName,
                        reason,
                        ring_duration_ms: Math.round(ringDurationMs),
                        hangup_cause: cause || null,
                    }).catch(() => {});
                    const aext = attempt.agentExt || entry.session.extension;
                    const stats = abuseStatsByExt.get(aext) || { abuse_timeout: 0, abuse_declined: 0, abuse_total: 0, abuse_recent: [] };
                    if (reason === 'DECLINED') stats.abuse_declined++; else stats.abuse_timeout++;
                    stats.abuse_total = (stats.abuse_timeout || 0) + (stats.abuse_declined || 0);
                    stats.abuse_recent = [{
                        reason,
                        queue: qn,
                        callerId: cid,
                        ringMs: Math.round(ringDurationMs),
                        time: new Date().toISOString(),
                    }].concat(stats.abuse_recent || []).slice(0, 5);
                    abuseStatsByExt.set(aext, stats);
                    entry.session.requeueCount = (entry.session.requeueCount || 0) + 1;
                    if (attempt.destChannel) ringAttemptsByDestChannel.delete(attempt.destChannel);
                }
            }
            const uid = String(fields.Uniqueid || fields.Linkedid || '');
            if (uid) callQueueByUid.delete(uid);
            if (entry.session.activeCallUid) callQueueByUid.delete(entry.session.activeCallUid);
            clearAgentCallState(entry.session, true);
            evKpi.active = Math.max(0, (evKpi.active || 0) - 1);
            const qObj2 = queueSnapshot.queues.find((x) => String(x.queue) === String(fields.Queue || ''));
            if (qObj2) { qObj2.in_call = Math.max(0, (qObj2.in_call || 0) - 1); }
            applyEventKpis();
            broadcastSupervisor();
        }
        return;
    }
    if (name === 'Hangup') {
        const ch = String(fields.Channel || '');
        let attempt = ringAttemptsByDestChannel.get(ch);
        if (!attempt) {
            const uid = String(fields.Linkedid || fields.Uniqueid || '');
            const m = ch.match(/^(?:PJSIP|SIP)\/(\d+)-/i);
            const ext = m ? m[1] : extFromInterface(ch);
            if (uid && ext) {
                for (const a of ringAttemptsByDestChannel.values()) {
                    if (String(a.agentExt) === String(ext) && a.callUid === uid) { attempt = a; break; }
                }
            }
        }
        if (attempt) {
            attempt.hangupCause = String(fields.Cause || '');
            const key = attempt.destChannel || ch;
            // keep briefly so AgentRingNoAnswer can read it, then cleanup
            setTimeout(() => { ringAttemptsByDestChannel.delete(key); }, 3000);
        }
        // no outbound tracking in reverted mode; ensure any stuck call is cleared when channel matches
        for (const entry of sessions.values()) {
            if (entry.session.activeChannel && entry.session.activeChannel === ch) {
                clearAgentCallState(entry.session, true);
                broadcastSupervisor();
                break;
            }
        }
        return;
    }
    if (name === 'QueueMemberStatus') {
        const ext = extFromInterface(fields.Interface || fields.MemberName || fields.Member);
        const entry = sessions.get(ext);
        if (!entry) return;
        const st = String(fields.Status || '');
        const cs = memberCallState({ status: st });
        const caller = String(fields.CallerIDNum || fields.ConnectedLineNum || fields.CallerID || '').trim();
        if (cs) {
            if (entry.session.callState !== cs) entry.session.statusSince = now();
            setSessionCallState(entry.session, cs, caller || entry.session.talkingCaller);
            if (!entry.session.activeQueue) entry.session.activeQueue = String(fields.Queue || '');
        } else {
            const uid = entry.session.activeCallUid;
            if (uid) callQueueByUid.delete(uid);
            setSessionCallState(entry.session, null, '');
            entry.session.activeQueue = '';
            entry.session.activeCallUid = '';
            entry.session.statusSince = now();
        }
        // also reflect pause state if provided
        let status = 'available';
        let reason = '';
        if (String(fields.Paused || '0') === '1') {
            status = 'pause';
            reason = String(fields.PausedReason || entry.session.reason || '');
        }
        let changed = false;
        if (entry.session.status !== status || entry.session.reason !== reason) {
            entry.session.status = status;
            entry.session.reason = reason;
            entry.session.statusSince = now();
            changed = true;
        }
        broadcastSupervisor();
        if (changed && entry.ws && entry.ws.readyState === 1) {
            entry.ws.send(JSON.stringify({
                event: 'state_update',
                extension: ext,
                status: status,
                reason: reason,
                assigned_queues: entry.session.queues,
                timestamp: now(),
            }));
        }
        return;
    }

    if (name !== 'QueueMemberAdded' && name !== 'QueueMemberRemoved') {
        return;
    }
    const extension = extFromInterface(fields.Interface || fields.MemberName || fields.Member);
    const entry = sessions.get(extension);
    if (!entry || !entry.ws || entry.ws.readyState !== 1) {
        return;
    }
    let status = 'available';
    let reason = '';
    if (String(fields.Paused || '0') === '1') {
        status = 'pause';
        reason = String(fields.PausedReason || '');
    }
    if (entry.session.status === status && entry.session.reason === reason) {
        return;
    }
    entry.session.status = status;
    entry.session.reason = reason;
    entry.session.statusSince = now();
    broadcastSupervisor();
    entry.ws.send(JSON.stringify({
        event: 'state_update',
        extension: extension,
        status: status,
        reason: reason,
        assigned_queues: entry.session.queues,
        timestamp: now(),
    }));
}

// The keepalive: the server pings, the agent answers with a pong. Two pongs
// in a row that do not come back mean that the agent is gone.
setInterval(() => {
    for (const entry of Array.from(sessions.values())) {
        if (!entry.ws || entry.ws.readyState !== 1) {
            continue;
        }
        entry.session.missed++;
        if (entry.session.missed > config.missedPongs) {
            dropSession(entry, entry.session.missed + ' missed pongs');
            continue;
        }
        try {
            entry.ws.send(JSON.stringify({ event: 'ping' }));
        } catch (e) {
            dropSession(entry, 'the ping failed');
        }
    }
}, config.pingSeconds * 1000);

//-----------------------------------------------------------------------------
// CRM (Phase 1)
//-----------------------------------------------------------------------------
function normalizePhone(raw) {
    const d = String(raw == null ? '' : raw).replace(/\D+/g, '');
    if (!d) return '';
    return d.length >= 10 ? d.slice(-10) : d;
}

async function ensureCrmTables() {
    async function hasColumn(table, column) {
        const [rows] = await db.pool.execute(
            'SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1',
            [table, column]
        );
        return rows.length > 0;
    }
    try {
        await db.pool.execute(
            'CREATE TABLE IF NOT EXISTS crm_customers ('
            + 'id INT AUTO_INCREMENT PRIMARY KEY, '
            + 'full_name VARCHAR(150) NOT NULL, '
            + 'primary_phone VARCHAR(32) NOT NULL, '
            + 'phone_normalized VARCHAR(20) NOT NULL, '
            + 'secondary_phone VARCHAR(32) NULL, '
            + 'company VARCHAR(150) NULL, '
            + 'email VARCHAR(150) NULL, '
            + "tag VARCHAR(32) DEFAULT 'Normal', "
            + 'address TEXT NULL, '
            + 'custom_fields JSON NULL, '
            + 'assigned_agent_id INT NULL, '
            + "category_code VARCHAR(50) DEFAULT 'NORMAL', "
            + 'created_at DATETIME DEFAULT CURRENT_TIMESTAMP, '
            + 'updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, '
            + 'INDEX idx_phone_normalized (phone_normalized), '
            + 'INDEX idx_assigned_agent_id (assigned_agent_id)'
            + ')'
        );
    } catch (e) {
        try { await db.pool.execute('CREATE INDEX idx_phone_normalized ON crm_customers (phone_normalized)'); } catch (_) {}
        if (!/already exists/i.test(String(e.message || ''))) console.warn('crm_customers init: ' + e.message);
    }
    try { if (!(await hasColumn('crm_customers', 'assigned_agent_id'))) await db.pool.execute('ALTER TABLE crm_customers ADD COLUMN assigned_agent_id INT NULL'); } catch (e) { if (!/Duplicate column/i.test(String(e.message||''))) console.warn('crm_customers assigned_agent_id: ' + e.message); }
    try { await db.pool.execute('CREATE INDEX idx_assigned_agent_id ON crm_customers (assigned_agent_id)'); } catch (_) {}
    try { if (!(await hasColumn('crm_customers', 'category_code'))) await db.pool.execute("ALTER TABLE crm_customers ADD COLUMN category_code VARCHAR(50) DEFAULT 'NORMAL'"); } catch (e) { if (!/Duplicate column/i.test(String(e.message||''))) console.warn('crm_customers category_code: ' + e.message); }

    try {
        await db.pool.execute(
            'CREATE TABLE IF NOT EXISTS crm_dispositions ('
            + 'id INT AUTO_INCREMENT PRIMARY KEY, '
            + 'code VARCHAR(50) UNIQUE NOT NULL, '
            + 'label VARCHAR(100) NOT NULL, '
            + 'is_active TINYINT(1) DEFAULT 1'
            + ')'
        );
    } catch (e) {
        if (!/already exists/i.test(String(e.message || ''))) console.warn('crm_dispositions init: ' + e.message);
    }
    try {
        await db.pool.execute(
            'CREATE TABLE IF NOT EXISTS crm_interactions ('
            + 'id INT AUTO_INCREMENT PRIMARY KEY, '
            + 'customer_id INT NOT NULL, '
            + 'agent_ext VARCHAR(32) NULL, '
            + 'agent_name VARCHAR(100) NULL, '
            + 'cdr_uniqueid VARCHAR(64) NULL, '
            + "direction ENUM('inbound','outbound','manual') DEFAULT 'inbound', "
            + "channel VARCHAR(32) DEFAULT 'call', "
            + 'disposition_code VARCHAR(50) NULL, '
            + 'notes TEXT NULL, '
            + 'follow_up_at DATETIME NULL, '
            + 'created_at DATETIME DEFAULT CURRENT_TIMESTAMP, '
            + 'INDEX idx_customer_created (customer_id, created_at), '
            + 'INDEX idx_cdr_uniqueid (cdr_uniqueid)'
            + ')'
        );
    } catch (e) {
        if (!/already exists/i.test(String(e.message || ''))) console.warn('crm_interactions init: ' + e.message);
    }
    try {
        const [rows] = await db.pool.execute('SELECT COUNT(*) AS c FROM crm_dispositions');
        if (!rows[0].c) {
            const seeds = [
                ['RESOLVED', 'Resolved'],
                ['FOLLOW_UP', 'Follow-up Required'],
                ['INQUIRY', 'General Inquiry'],
                ['COMPLAINT', 'Complaint'],
                ['INTERESTED', 'Sales / Interested'],
                ['WRONG_NUMBER', 'Wrong Number'],
            ];
            for (const s of seeds) {
                await db.pool.execute('INSERT IGNORE INTO crm_dispositions (code, label, is_active) VALUES (?, ?, 1)', s);
            }
        }
    } catch (e) {
        console.warn('crm_dispositions seed: ' + e.message);
    }

    try {
        await db.pool.execute(
            'CREATE TABLE IF NOT EXISTS crm_customer_categories ('
            + 'id INT AUTO_INCREMENT PRIMARY KEY, '
            + 'code VARCHAR(50) UNIQUE NOT NULL, '
            + 'label VARCHAR(100) NOT NULL, '
            + "color VARCHAR(20) DEFAULT '#475569', "
            + 'is_active TINYINT(1) DEFAULT 1'
            + ')'
        );
    } catch (e) { if (!/already exists/i.test(String(e.message || ''))) console.warn('crm_customer_categories init: ' + e.message); }
    try {
        const [rows] = await db.pool.execute('SELECT COUNT(*) AS c FROM crm_customer_categories');
        if (!rows[0].c) {
            const seeds = [
                ['NORMAL','Normal','#475569'],
                ['VIP','VIP','#92400e'],
                ['LEAD','Lead','#1d4ed8'],
                ['PROSPECT','Prospect','#0f766e'],
                ['ACTIVE_CLIENT','Active Client','#15803d'],
                ['BLACKLIST','Blacklist','#991b1b'],
            ];
            for (const s of seeds) await db.pool.execute('INSERT IGNORE INTO crm_customer_categories (code,label,color,is_active) VALUES (?,?,?,1)', s);
        }
    } catch (e) { console.warn('crm_customer_categories seed: ' + e.message); }

    try {
        await db.pool.execute(
            'CREATE TABLE IF NOT EXISTS crm_tickets ('
            + 'id INT AUTO_INCREMENT PRIMARY KEY, '
            + 'ticket_number VARCHAR(32) UNIQUE NULL, '
            + 'customer_id INT NOT NULL, '
            + 'subject VARCHAR(200) NOT NULL, '
            + "category VARCHAR(64) DEFAULT 'General', "
            + "priority ENUM('Low','Medium','High','Urgent') DEFAULT 'Medium', "
            + "status ENUM('Open','In Progress','Waiting Customer','Escalated','Closed') DEFAULT 'Open', "
            + 'created_by_agent_id INT NULL, '
            + 'assigned_agent_id INT NULL, '
            + 'due_at DATETIME NULL, '
            + 'description TEXT NULL, '
            + 'created_at DATETIME DEFAULT CURRENT_TIMESTAMP, '
            + 'updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, '
            + 'INDEX idx_ticket_customer (customer_id), '
            + 'INDEX idx_ticket_assigned (assigned_agent_id)'
            + ')'
        );
    } catch (e) { if (!/already exists/i.test(String(e.message || ''))) console.warn('crm_tickets init: ' + e.message); }

    try {
        await db.pool.execute(
            'CREATE TABLE IF NOT EXISTS crm_ticket_logs ('
            + 'id INT AUTO_INCREMENT PRIMARY KEY, '
            + 'ticket_id INT NOT NULL, '
            + 'action_type VARCHAR(32) NOT NULL, '
            + 'from_agent_id INT NULL, '
            + 'to_agent_id INT NULL, '
            + 'old_status VARCHAR(32) NULL, '
            + 'new_status VARCHAR(32) NULL, '
            + 'note TEXT NULL, '
            + 'created_at DATETIME DEFAULT CURRENT_TIMESTAMP, '
            + 'INDEX idx_ticket_log_ticket (ticket_id)'
            + ')'
        );
    } catch (e) { if (!/already exists/i.test(String(e.message || ''))) console.warn('crm_ticket_logs init: ' + e.message); }

    try {
        for (const t of ['crm_customers','crm_dispositions','crm_interactions','crm_customer_categories','crm_tickets','crm_ticket_logs']) {
            try { await db.pool.execute("GRANT SELECT,INSERT,UPDATE,DELETE,CREATE,INDEX,ALTER ON asterisk." + t + " TO 'cc_middleware'@'localhost'"); } catch (_) {}
        }
        try { await db.pool.execute('FLUSH PRIVILEGES'); } catch (_) {}
    } catch (_) {}
}

function broadcastCrmScreenPop(payload) {
    if (!adminSessions || !adminSessions.size) return;
    const msg = JSON.stringify(payload);
    const targetExt = String(payload.agent_ext || '');
    for (const entry of adminSessions) {
        if (!entry.ws || entry.ws.readyState !== 1) continue;
        if (entry.isAdmin || entry.role === 'admin') {
            try { entry.ws.send(msg); } catch (e) {}
        } else if (entry.role === 'agent' && targetExt && String(entry.agent_ext || '') === targetExt) {
            try { entry.ws.send(msg); } catch (e) {}
        }
    }
}

function broadcastCrmToAdminsAndAgents(payload, agentExts) {
    if (!adminSessions || !adminSessions.size) return;
    const msg = JSON.stringify(payload);
    const extSet = new Set((agentExts || []).filter(Boolean).map(x => String(x)));
    for (const entry of adminSessions) {
        if (!entry.ws || entry.ws.readyState !== 1) continue;
        if (entry.isAdmin || entry.role === 'admin') {
            try { entry.ws.send(msg); } catch (e) {}
        } else if (entry.role === 'agent' && extSet.has(String(entry.agent_ext || ''))) {
            try { entry.ws.send(msg); } catch (e) {}
        }
    }
}

const recentScreenPops = new Map(); // key -> ts
function shouldEmitScreenPop(agentExt, callerId, uniqueid) {
    const key = String(agentExt || '') + '|' + String(uniqueid || '') + '|' + normalizePhone(callerId);
    const nowTs = Date.now();
    const prev = recentScreenPops.get(key) || 0;
    if (nowTs - prev < 8000) return false;
    recentScreenPops.set(key, nowTs);
    if (recentScreenPops.size > 500) {
        for (const [k, v] of recentScreenPops.entries()) {
            if (nowTs - v > 30000) recentScreenPops.delete(k);
        }
    }
    return true;
}

async function crmLookupByPhone(phoneRaw) {
    const norm = normalizePhone(phoneRaw);
    if (!norm) return { customer: null, phone: String(phoneRaw || ''), interactions: [], recent_calls: [] };
    const [cRows] = await db.pool.execute(
        'SELECT * FROM crm_customers WHERE phone_normalized = ? OR RIGHT(REPLACE(REPLACE(REPLACE(primary_phone," ",""),"-",""),"+",""),10)=? OR RIGHT(REPLACE(REPLACE(REPLACE(IFNULL(secondary_phone,"")," ",""),"-",""),"+",""),10)=? ORDER BY updated_at DESC LIMIT 1',
        [norm, norm, norm]
    );
    if (!cRows.length) return { customer: null, phone: String(phoneRaw || ''), interactions: [], recent_calls: [] };
    const customer = cRows[0];
    const [iRows] = await db.pool.execute(
        'SELECT id, customer_id, agent_ext, agent_name, cdr_uniqueid, direction, channel, disposition_code, notes, follow_up_at, created_at '
        + 'FROM crm_interactions WHERE customer_id = ? ORDER BY created_at DESC, id DESC LIMIT 5',
        [customer.id]
    );
    return { customer, interactions: iRows, recent_calls: iRows, phone: String(phoneRaw || '') };
}

// The display name of a queue, from the descr of queues_config. The names
// change rarely, they are cached for a minute. A queue without a
// description answers with its extension, so the client always gets a
// label for a call that came through a queue.
let queueNamesCache = { at: 0, names: {} };
async function queueNameFor(queueNumber) {
    const num = String(queueNumber || '').trim();
    if (!num) return '';
    if (Date.now() - queueNamesCache.at > 60000) {
        try {
            queueNamesCache = { at: Date.now(), names: await db.queueNames() };
        } catch (e) {
            queueNamesCache.at = Date.now();
        }
    }
    return queueNamesCache.names[num] || num;
}

// The display names of a list of queues, for the login answer: a map of
// extension -> descr with only the queues that really have a description
// (the client falls back to the number for the rest).
async function queueNamesFor(numbers) {
    const map = {};
    for (const n of numbers || []) {
        const name = await queueNameFor(n);
        if (name && name !== String(n)) map[String(n)] = name;
    }
    return map;
}

async function crmHandleScreenPop(agentExt, callerId, uniqueid) {
    try {
        if (!shouldEmitScreenPop(agentExt, callerId, uniqueid)) return;
        const lookup = await crmLookupByPhone(callerId);
        const customer = lookup.customer;
        const last = (lookup.interactions && lookup.interactions[0]) || null;
        // the queue of this call: the session carries it from the ami events
        // (AgentCalled, AgentConnect), the map by uniqueid is the fallback
        const entry = sessions.get(String(agentExt || ''));
        const queueNumber = (entry && entry.session && entry.session.activeQueue)
            || callQueueByUid.get(String(uniqueid || '')) || '';
        const queueName = await queueNameFor(queueNumber);
        const popPayload = {
            type: 'crm_screen_pop',
            agent_ext: String(agentExt || ''),
            caller_id: String(callerId || ''),
            uniqueid: String(uniqueid || ''),
            queue_name: queueName,
            is_new: !customer,
            customer: customer ? {
                id: customer.id,
                full_name: customer.full_name,
                tag: customer.tag || 'Normal',
                company: customer.company || '',
                primary_phone: customer.primary_phone || '',
            } : null,
            last_interaction: last ? {
                disposition_code: last.disposition_code || '',
                notes: last.notes || '',
                created_at: last.created_at || null,
            } : null,
        };
        broadcastCrmScreenPop(popPayload);
        // The softphone of the agent rides its queue session socket, it is
        // not one of the dashboard watchers above, so it never saw the pop.
        // It gets its own copy on that socket, framed with event (the
        // framing its parser speaks) instead of type.
        if (entry && entry.ws && entry.ws.readyState === 1) {
            try {
                entry.ws.send(JSON.stringify(Object.assign({}, popPayload, { event: 'crm_screen_pop' })));
            } catch (e) {}
        }
    } catch (e) {
        // non-blocking
    }
}

// The connection to asterisk. Without a user there is no ami, the middleware
// then only serves the client.
db.ensureCustomReportsTable().catch((e) => console.error('cc_custom_reports init failed: ' + e.message));
if (db.ensureIssabelUsernameColumn) db.ensureIssabelUsernameColumn().catch((e) => console.error('issabel_username init failed: ' + e.message));
if (db.ensureIssabelUserIdColumn) db.ensureIssabelUserIdColumn().catch((e) => console.error('issabel_user_id init failed: ' + e.message));
if (db.ensureAgentNameColumn) db.ensureAgentNameColumn().catch((e) => console.error('agent_name init failed: ' + e.message));
ensureCrmTables().catch((e) => console.error('crm tables init failed: ' + e.message));

if (config.ami.user) {
    ami = new Ami({
        host: config.ami.host,
        port: config.ami.port,
        user: config.ami.user,
        secret: config.ami.secret,
        timeout: config.ami.timeout,
    });
    ami.on('login', () => {
        console.log('the ami connection is up (' + config.ami.user + '@' + config.ami.host + ':' + config.ami.port + ')');
        seedAbuseStats().catch(() => {});
        // the agents that are logged in go back into their queues
        for (const entry of sessions.values()) {
            amiQueueAdd(entry.session).catch(() => {});
        }
        startQueuePoll();
    });
    ami.on('error', (e) => console.error('the ami failed: ' + e.message));
    ami.on('event', onAmiEvent);
}

server.listen(config.port, () => {
    console.log('the call center middleware listens on http://0.0.0.0:' + config.port);
    console.log('  the database  : ' + config.db.user + '@' + config.db.host + '/' + config.db.database);
    console.log('  the sip server: ' + config.sip.serverIp + ':' + config.sip.serverPort);
    console.log('  the keepalive : every ' + config.pingSeconds + 's, '
        + config.missedPongs + ' pongs in a row that do not come back');
    console.log('  the admin hook: ' + (config.adminToken ? 'on' : 'off'));
    console.log('  the asterisk   : ' + (config.ami.user
        ? config.ami.user + '@' + config.ami.host + ':' + config.ami.port
        : 'no ami user, the queues are not touched'));
    startWhatsAppPresenceHeartbeat();
});

function shutdown() {
    console.log('the middleware stops');
    if (ami) {
        ami.close();
    }
    for (const entry of Array.from(sessions.values())) {
        dropSession(entry, 'the middleware stops');
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
