'use strict';

// The database layer. The middleware only reads: the agent, its queues, the
// pause reasons and the sip secret of the extension (Issabel owns the latter,
// it is written when the extension is created in the Issabel user interface).
const mysql = require('mysql2/promise');
const config = require('./config');

const pool = mysql.createPool({
    host: config.db.host,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    waitForConnections: true,
    connectionLimit: config.db.connectionLimit,
    queueLimit: 0,
    charset: 'utf8mb4',
});

// The agent behind a login. The password is the one of the agent, it is stored
// as it is in the table.
async function findAgent(username, password) {
    const [rows] = await pool.execute(
        'SELECT id, username, sip_extension, issabel_username FROM cc_agents '
        + 'WHERE username = ? AND password = ? AND is_active = 1 LIMIT 1',
        [username, password]);
    return rows.length ? rows[0] : null;
}

async function findAgentByIssabelUsername(issabelUsername) {
    if (!issabelUsername) return null;
    const [rows] = await pool.execute(
        'SELECT id, username, sip_extension, issabel_username FROM cc_agents WHERE issabel_username = ? AND is_active = 1 LIMIT 1',
        [String(issabelUsername)]
    );
    return rows.length ? rows[0] : null;
}

// The agent behind an Issabel identity posted by another Issabel module
// (the WhatsApp service posts its issabel_user_id to
// /internal/whatsapp/events). ASSUMPTION, made deliberately: the sessions
// of the middleware are keyed by sip extension and carry only the
// cc_agents login username — there is no numeric Issabel user id anywhere
// in the data of the middleware, and no Issabel users table is read here.
// The only Issabel link the middleware owns is cc_agents.issabel_username,
// so the incoming identity is matched against issabel_username first and
// against the login username second (on this deployment the Issabel
// username and the agent login username are the same strings). If the
// WhatsApp module's id space ever becomes numeric-only, this function is
// the single place to extend (e.g. an issabel_user_id column on cc_agents).
async function findAgentByIssabelIdentity(identity) {
    if (!identity) return null;
    const [rows] = await pool.execute(
        'SELECT id, username, sip_extension, issabel_username FROM cc_agents '
        + 'WHERE is_active = 1 AND (issabel_username = ? OR username = ?) LIMIT 1',
        [String(identity), String(identity)]);
    return rows.length ? rows[0] : null;
}

async function ensureIssabelUsernameColumn() {
    try {
        const [rows] = await pool.execute(
            "SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cc_agents' AND COLUMN_NAME = 'issabel_username' LIMIT 1"
        );
        if (!rows.length) {
            await pool.execute('ALTER TABLE cc_agents ADD COLUMN issabel_username VARCHAR(64) NULL');
        }
    } catch (e) {
        if (!/Duplicate column/i.test(String(e && e.message || ''))) console.warn('issabel_username column: ' + e.message);
    }
    try {
        await pool.execute('CREATE UNIQUE INDEX idx_cc_agents_issabel_username ON cc_agents (issabel_username)');
    } catch (_) {}
}

// The numeric Issabel user id next to the username (provisioning hub,
// step 2): the agents page now PICKS the Issabel user from the real
// acl list, so the link is stored by id and the username can never be
// misspelled. Nullable: agents created before the hub keep working
// with the username alone.
async function ensureIssabelUserIdColumn() {
    try {
        const [rows] = await pool.execute(
            "SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cc_agents' AND COLUMN_NAME = 'issabel_user_id' LIMIT 1"
        );
        if (!rows.length) {
            await pool.execute('ALTER TABLE cc_agents ADD COLUMN issabel_user_id INT NULL');
        }
    } catch (e) {
        if (!/Duplicate column/i.test(String(e && e.message || ''))) console.warn('issabel_user_id column: ' + e.message);
    }
    try {
        await pool.execute('CREATE INDEX idx_cc_agents_issabel_user_id ON cc_agents (issabel_user_id)');
    } catch (_) {}
}

// The sip secret of the extension, Issabel keeps it in the sip table.
async function sipSecret(extension) {
    const [rows] = await pool.execute(
        "SELECT data AS sip_password FROM sip WHERE id = ? AND keyword = 'secret' LIMIT 1",
        [extension]);
    return rows.length ? rows[0].sip_password : '';
}

// The interface of the extension in asterisk (PJSIP/1000 or SIP/1000). Issabel
// keeps it in the dial field of the sip table, the same table the secret comes
// from. Asking asterisk itself would need broader ami rights.
async function sipInterface(extension) {
    const [rows] = await pool.execute(
        "SELECT data FROM sip WHERE id = ? AND keyword = 'dial' LIMIT 1",
        [extension]);
    if (rows.length) {
        const dial = String(rows[0].data || '').trim();
        if (/^(PJSIP|SIP)\/[^/]+$/.test(dial)) {
            return dial;
        }
    }
    return null;
}

// The queues the agent works in.
async function agentQueues(agentId) {
    const [rows] = await pool.execute(
        'SELECT queue_number FROM cc_agent_queues WHERE agent_id = ? ORDER BY queue_number',
        [agentId]);
    return rows.map((row) => String(row.queue_number));
}

// The reasons an agent may take, they are the ones of the pauses module.
async function pauseReasons() {
    const [rows] = await pool.execute(
        'SELECT reason_code FROM cc_pause_reasons WHERE is_active = 1 ORDER BY id');
    return rows.map((row) => String(row.reason_code));
}

// The id of a pause reason, it goes into the log of the agent.
async function pauseReasonId(reasonCode) {
    if (!reasonCode) {
        return null;
    }
    const [rows] = await pool.execute(
        'SELECT id FROM cc_pause_reasons WHERE reason_code = ? LIMIT 1',
        [reasonCode]);
    return rows.length ? rows[0].id : null;
}

// One line in the log of the agent. The event types are the ones of the enum
// of the table: login, logout, pause, unpause.
async function logEvent(agentId, eventType, reasonCode) {
    try {
        const reasonId = await pauseReasonId(reasonCode);
        await pool.execute(
            'INSERT INTO cc_agent_logs (agent_id, event_type, pause_reason_id) VALUES (?, ?, ?)',
            [agentId, eventType, reasonId]);
    } catch (e) {
        console.error('the log of the agent failed: ' + e.message);
    }
}

// The agents of the call center, the ones the supervisor knows. The ones that
// are not connected are shown as offline.
async function knownAgents() {
    const [rows] = await pool.execute(
        'SELECT id, username, sip_extension FROM cc_agents WHERE is_active = 1 ORDER BY username');
    return rows.map((row) => ({
        agentId: row.id,
        username: row.username,
        extension: row.sip_extension,
    }));
}

//-----------------------------------------------------------------------------
// the agents of the call center (the supervisor manages them)
//-----------------------------------------------------------------------------

// The extensions of Issabel (the sip table holds them, the account keyword
// is the extension number).
async function listExtensions() {
    const [rows] = await pool.execute(
        "SELECT DISTINCT id FROM sip WHERE keyword = 'account' ORDER BY id");
    return rows.map((row) => String(row.id));
}

// The queues of Issabel.
async function listQueues() {
    const [rows] = await pool.execute(
        'SELECT DISTINCT extension FROM queues_config ORDER BY extension');
    return rows.map((row) => String(row.extension));
}

// The display names of the queues of Issabel (the descr of queues_config),
// by extension. A queue without a description is absent from the map, the
// caller falls back to the extension itself.
async function queueNames() {
    const [rows] = await pool.execute(
        'SELECT extension, descr FROM queues_config ORDER BY extension');
    const names = {};
    for (const row of rows) {
        const descr = String(row.descr || '').trim();
        if (descr) names[String(row.extension)] = descr;
    }
    return names;
}

// Every agent with the queues it belongs to.
async function allAgents() {
    const [agents] = await pool.execute(
        'SELECT id, username, sip_extension, is_active, issabel_username, issabel_user_id FROM cc_agents ORDER BY username');
    const [queues] = await pool.execute(
        'SELECT agent_id, queue_number FROM cc_agent_queues ORDER BY agent_id, queue_number');
    const byAgent = new Map();
    for (const row of queues) {
        if (!byAgent.has(row.agent_id)) {
            byAgent.set(row.agent_id, []);
        }
        byAgent.get(row.agent_id).push(String(row.queue_number));
    }
    return agents.map((agent) => ({
        id: agent.id,
        username: agent.username,
        sip_extension: agent.sip_extension,
        issabel_username: agent.issabel_username || '',
        issabel_user_id: agent.issabel_user_id == null ? null : Number(agent.issabel_user_id),
        active: !!agent.is_active,
        queues: byAgent.get(agent.id) || [],
    }));
}

// Every queue that an agent has, the ones that are not in issabel are in it
// too (a queue that was deleted in issabel).
async function allAgentQueues() {
    const [rows] = await pool.execute(
        'SELECT DISTINCT queue_number FROM cc_agent_queues ORDER BY queue_number');
    return rows.map((row) => String(row.queue_number));
}

// The queues of one agent, the old ones go away.
async function setAgentQueues(agentId, queues) {
    await pool.execute('DELETE FROM cc_agent_queues WHERE agent_id = ?', [agentId]);
    for (const queue of queues || []) {
        const number = String(queue).trim();
        if (!number) {
            continue;
        }
        await pool.execute(
            'INSERT INTO cc_agent_queues (agent_id, queue_number) VALUES (?, ?)',
            [agentId, number]);
    }
}

// A new agent.
async function createAgent(agent) {
    const issabelUser = agent.issabel_username ? String(agent.issabel_username).trim() : null;
    const issabelUserId = Number.isInteger(agent.issabel_user_id) && agent.issabel_user_id > 0 ? agent.issabel_user_id : null;
    const [result] = await pool.execute(
        'INSERT INTO cc_agents (username, password, sip_extension, is_active, issabel_username, issabel_user_id) VALUES (?, ?, ?, 1, ?, ?)',
        [agent.username, agent.password, agent.sip_extension, issabelUser || null, issabelUserId]);
    await setAgentQueues(result.insertId, agent.queues);
    return result.insertId;
}

// The changes of an agent, only the fields that are given are changed.
async function updateAgent(id, agent) {
    const fields = [];
    const values = [];
    if (agent.username !== undefined) {
        fields.push('username = ?');
        values.push(String(agent.username));
    }
    if (agent.password !== undefined && agent.password !== '') {
        fields.push('password = ?');
        values.push(String(agent.password));
    }
    if (agent.sip_extension !== undefined) {
        fields.push('sip_extension = ?');
        values.push(String(agent.sip_extension));
    }
    if (agent.issabel_username !== undefined) {
        const iu = String(agent.issabel_username || '').trim();
        fields.push('issabel_username = ?');
        values.push(iu || null);
    }
    if (agent.issabel_user_id !== undefined) {
        fields.push('issabel_user_id = ?');
        values.push(Number.isInteger(agent.issabel_user_id) && agent.issabel_user_id > 0 ? agent.issabel_user_id : null);
    }
    if (agent.is_active !== undefined) {
        fields.push('is_active = ?');
        values.push(agent.is_active ? 1 : 0);
    }
    if (fields.length) {
        values.push(id);
        await pool.execute('UPDATE cc_agents SET ' + fields.join(', ') + ' WHERE id = ?', values);
    }
    if (agent.queues !== undefined) {
        await setAgentQueues(id, agent.queues);
    }
}

// An agent that is not active any more can not log in any more, the row
// stays (the log of the agent points at it).
async function disableAgent(id) {
    await pool.execute('UPDATE cc_agents SET is_active = 0 WHERE id = ?', [id]);
}

//-----------------------------------------------------------------------------
// the pause reasons (the supervisor manages them)
//-----------------------------------------------------------------------------

// Every reason, the inactive ones are in it too.
async function allPauseReasons() {
    const [rows] = await pool.execute(
        'SELECT id, reason_code, description, is_active FROM cc_pause_reasons ORDER BY id');
    return rows.map((row) => ({
        id: row.id,
        reason_code: row.reason_code,
        description: row.description || '',
        active: !!row.is_active,
    }));
}

// A new reason. The code is unique, the database says so.
async function createPauseReason(reason) {
    const [result] = await pool.execute(
        'INSERT INTO cc_pause_reasons (reason_code, description, is_active) VALUES (?, ?, ?)',
        [reason.reason_code, reason.description || null, reason.is_active === false ? 0 : 1]);
    return result.insertId;
}

// The changes of a reason, only the fields that are given are changed.
async function updatePauseReason(id, reason) {
    const fields = [];
    const values = [];
    if (reason.reason_code !== undefined) {
        fields.push('reason_code = ?');
        values.push(String(reason.reason_code));
    }
    if (reason.description !== undefined) {
        fields.push('description = ?');
        values.push(String(reason.description || ''));
    }
    if (reason.is_active !== undefined) {
        fields.push('is_active = ?');
        values.push(reason.is_active ? 1 : 0);
    }
    if (fields.length) {
        values.push(id);
        await pool.execute('UPDATE cc_pause_reasons SET ' + fields.join(', ') + ' WHERE id = ?', values);
    }
}

// How often a reason is in the log of the agents. A reason that is in the log
// stays (the log points at it), it is deactivated instead of being removed.
async function pauseReasonLogCount(id) {
    const [rows] = await pool.execute(
        'SELECT COUNT(*) AS count FROM cc_agent_logs WHERE pause_reason_id = ?', [id]);
    return rows[0].count;
}

async function deletePauseReason(id) {
    const [result] = await pool.execute('DELETE FROM cc_pause_reasons WHERE id = ?', [id]);
    return result.affectedRows;
}

//-----------------------------------------------------------------------------
// the reports
//-----------------------------------------------------------------------------

// The date of a filter, it is YYYY-MM-DD or nothing. A date means midnight,
// so the "to" date is the day that follows (the filter is "before").
function reportDate(value) {
    const date = String(value || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return date;
    }
    return null;
}

// The lines of the log of the agents, newest first. Every event knows when
// it ended and how long it lasted: a pause ends at the unpause or the logout,
// a working stretch at the next pause, logout or login, a session at the
// logout or the next login (the database finds it, so a page break does not
// hide the end of anything). A state that is not closed yet has no end.
const stretchOf = {
    pause: "('unpause', 'logout')",
    unpause: "('pause', 'logout', 'login')",
    login: "('logout', 'login')",
};

function endTimeCases() {
    return Object.keys(stretchOf).map(function (type) {
        return 'WHEN \'' + type + '\' THEN '
            + '(SELECT MIN(l2.event_time) FROM cc_agent_logs l2 '
            + 'WHERE l2.agent_id = l.agent_id AND l2.event_time > l.event_time '
            + 'AND l2.event_type IN ' + stretchOf[type] + ')';
    }).join(' ');
}

// The stretch of a state up to now, for the sums of the summary: a pause or
// a working stretch that is still open counts up to this moment.
function stretchSum(type) {
    return 'COALESCE(SUM(CASE WHEN l.event_type = \'' + type + '\' THEN '
        + '(SELECT TIMESTAMPDIFF(SECOND, l.event_time, COALESCE(MIN(l2.event_time), NOW())) '
        + 'FROM cc_agent_logs l2 WHERE l2.agent_id = l.agent_id '
        + 'AND l2.event_time > l.event_time AND l2.event_type IN ' + stretchOf[type] + ') '
        + 'END), 0)';
}

async function agentLogs(query) {
    const where = [];
    const values = [];
    const from = reportDate(query.from);
    const to = reportDate(query.to);
    if (from) {
        where.push('l.event_time >= ?');
        values.push(from);
    }
    if (to) {
        where.push('l.event_time < DATE_ADD(?, INTERVAL 1 DAY)');
        values.push(to);
    }
    if (query.agentId) {
        where.push('l.agent_id = ?');
        values.push(query.agentId);
    }
    // unpause/logout rows are pairing markers only (used to compute end_time/duration);
    // never return them as Agent Log rows.
    if (query.eventType === 'login' || query.eventType === 'pause') {
        where.push('l.event_type = ?');
        values.push(query.eventType);
    } else {
        where.push("l.event_type IN ('login', 'pause')");
    }
    const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const [countRows] = await pool.execute(
        'SELECT COUNT(*) AS count FROM cc_agent_logs l' + whereSql, values);
    const [rows] = await pool.execute(
        'SELECT t.*, TIMESTAMPDIFF(SECOND, t.event_time, t.end_time) AS duration FROM '
        + '(SELECT l.id, l.agent_id, a.username, a.sip_extension, l.event_type, '
        + 'r.reason_code, l.event_time, '
        + 'CASE l.event_type ' + endTimeCases() + ' END AS end_time '
        + 'FROM cc_agent_logs l '
        + 'JOIN cc_agents a ON a.id = l.agent_id '
        + 'LEFT JOIN cc_pause_reasons r ON r.id = l.pause_reason_id '
        + whereSql + ' ORDER BY l.event_time DESC, l.id DESC LIMIT ? OFFSET ?) t '
        + 'ORDER BY t.event_time DESC, t.id DESC',
        values.concat([query.perPage, query.offset]));
    return { total: countRows[0].count, rows: rows };
}

// The numbers of the summary cards: the logins and the breaks of the range,
// the pause time and the working time. The working time is the time of the
// sessions without the pauses in them (a session ends at the logout or the
// next login, one that is open counts up to now).
async function agentSummary(query) {
    const where = [];
    const values = [];
    const from = reportDate(query.from);
    const to = reportDate(query.to);
    if (from) {
        where.push('l.event_time >= ?');
        values.push(from);
    }
    if (to) {
        where.push('l.event_time < DATE_ADD(?, INTERVAL 1 DAY)');
        values.push(to);
    }
    if (query.agentId) {
        where.push('l.agent_id = ?');
        values.push(query.agentId);
    }
    const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const [rows] = await pool.execute(
        'SELECT COALESCE(SUM(l.event_type = \'login\'), 0) AS logins, '
        + 'COALESCE(SUM(l.event_type = \'pause\'), 0) AS breaks, '
        + stretchSum('pause') + ' AS pause_seconds, '
        + stretchSum('login') + ' AS session_seconds '
        + 'FROM cc_agent_logs l' + whereSql,
        values);
    const summary = rows[0];
    summary.work_seconds = Math.max(0, summary.session_seconds - summary.pause_seconds);
    delete summary.session_seconds;
    return summary;
}

// The breaks per reason: how many pauses and how much time in all.
async function pauseSummary(query) {
    const where = ["l.event_type = 'pause'"];
    const values = [];
    const from = reportDate(query.from);
    const to = reportDate(query.to);
    if (from) {
        where.push('l.event_time >= ?');
        values.push(from);
    }
    if (to) {
        where.push('l.event_time < DATE_ADD(?, INTERVAL 1 DAY)');
        values.push(to);
    }
    const [rows] = await pool.execute(
        'SELECT COALESCE(r.reason_code, \'-\') AS reason, COUNT(*) AS breaks, '
        + 'COALESCE(SUM((SELECT TIMESTAMPDIFF(SECOND, l.event_time, MIN(l2.event_time)) '
        + 'FROM cc_agent_logs l2 WHERE l2.agent_id = l.agent_id '
        + 'AND l2.event_time > l.event_time '
        + "AND l2.event_type IN ('unpause', 'logout'))), 0) AS total_seconds "
        + 'FROM cc_agent_logs l '
        + 'LEFT JOIN cc_pause_reasons r ON r.id = l.pause_reason_id '
        + 'WHERE ' + where.join(' AND ') + ' GROUP BY reason ORDER BY total_seconds DESC',
        values);
    return rows;
}

async function ping() {
    const [rows] = await pool.execute('SELECT 1 AS ok');
    return rows.length === 1;
}

// queue requeue logs
async function ensureRequeueTable() {
    try {
        await pool.execute(
            'CREATE TABLE IF NOT EXISTS queue_requeue_logs ('
            + 'id INT AUTO_INCREMENT PRIMARY KEY, '
            + 'call_uid VARCHAR(64), '
            + 'queue_name VARCHAR(64), '
            + 'caller_id VARCHAR(64), '
            + 'agent_ext VARCHAR(32), '
            + 'agent_name VARCHAR(64), '
            + 'reason VARCHAR(16), '
            + 'ring_duration_ms INT, '
            + 'hangup_cause VARCHAR(16), '
            + 'created_at DATETIME DEFAULT CURRENT_TIMESTAMP'
            + ')'
        );
    } catch (e) { /* table may already exist without CREATE privilege */ }
}

async function insertRequeueLog(data) {
    await pool.execute(
        'INSERT INTO queue_requeue_logs (call_uid, queue_name, caller_id, agent_ext, agent_name, reason, ring_duration_ms, hangup_cause) '
        + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
            data.call_uid || null,
            data.queue_name || null,
            data.caller_id || null,
            data.agent_ext || null,
            data.agent_name || null,
            data.reason || null,
            Number.isFinite(data.ring_duration_ms) ? Math.round(data.ring_duration_ms) : null,
            data.hangup_cause != null ? String(data.hangup_cause) : null,
        ]
    );
}

async function listRequeueLogs(filters) {
    const where = [];
    const values = [];
    if (filters.queue) { where.push('queue_name = ?'); values.push(String(filters.queue)); }
    if (filters.agent) { where.push('(agent_ext = ? OR agent_name = ?)'); values.push(String(filters.agent), String(filters.agent)); }
    const limit = Math.min(500, Math.max(1, parseInt(filters.limit, 10) || 100));
    const sql = 'SELECT * FROM queue_requeue_logs'
        + (where.length ? ' WHERE ' + where.join(' AND ') : '')
        + ' ORDER BY created_at DESC, id DESC LIMIT ?';
    const [rows] = await pool.execute(sql, values.concat([limit]));
    return rows;
}

async function getTodayAgentAbuseStats() {
    const [rows] = await pool.execute(
        "SELECT agent_ext, reason, queue_name, caller_id, ring_duration_ms, created_at "
        + "FROM queue_requeue_logs WHERE DATE(created_at) = CURDATE() ORDER BY created_at DESC"
    );
    const byExt = new Map();
    for (const row of rows) {
        const ext = String(row.agent_ext || '');
        if (!ext) continue;
        if (!byExt.has(ext)) byExt.set(ext, { abuse_timeout: 0, abuse_declined: 0, abuse_total: 0, abuse_recent: [] });
        const a = byExt.get(ext);
        const reason = String(row.reason || '').toUpperCase();
        if (reason === 'DECLINED') a.abuse_declined++; else a.abuse_timeout++;
        a.abuse_total = a.abuse_timeout + a.abuse_declined;
        if (a.abuse_recent.length < 5) {
            a.abuse_recent.push({
                reason: reason,
                queue: String(row.queue_name || ''),
                callerId: String(row.caller_id || ''),
                ringMs: Number(row.ring_duration_ms || 0),
                time: row.created_at,
            });
        }
    }
    return byExt;
}

async function ensureDailyStatsTables() {
    await pool.execute(
        'CREATE TABLE IF NOT EXISTS cc_daily_kpis ('
        + 'stat_date DATE PRIMARY KEY, '
        + 'completed INT DEFAULT 0, '
        + 'abandoned INT DEFAULT 0, '
        + 'asa_sum DOUBLE DEFAULT 0, '
        + 'asa_n INT DEFAULT 0, '
        + 'talk_sum DOUBLE DEFAULT 0, '
        + 'talk_n INT DEFAULT 0, '
        + 'updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'
        + ')'
    );
    await pool.execute(
        'CREATE TABLE IF NOT EXISTS cc_daily_agent_stats ('
        + 'stat_date DATE NOT NULL, '
        + 'agent_key VARCHAR(64) NOT NULL, '
        + 'calls_taken INT DEFAULT 0, '
        + 'calls_made INT DEFAULT 0, '
        + 'pause_count INT DEFAULT 0, '
        + 'PRIMARY KEY (stat_date, agent_key)'
        + ')'
    );
}

async function ensureCustomReportsTable() {
    try {
        await pool.execute(
            'CREATE TABLE IF NOT EXISTS cc_custom_reports ('
            + 'id INT AUTO_INCREMENT PRIMARY KEY, '
            + 'title VARCHAR(120) NOT NULL, '
            + "category ENUM('agents','queues','calls') NOT NULL DEFAULT 'agents', "
            + 'filters_json VARCHAR(255) NOT NULL DEFAULT \'["date"]\', '
            + 'sql_query TEXT NOT NULL, '
            + 'is_active TINYINT(1) NOT NULL DEFAULT 1, '
            + 'created_at DATETIME DEFAULT CURRENT_TIMESTAMP'
            + ')'
        );
    } catch (e) { /* table may already exist without CREATE privilege */ }
}

function parseCustomFiltersJson(v) {
    try {
        const a = JSON.parse(v || '["date"]');
        return Array.isArray(a) ? a.map(String) : ['date'];
    } catch (e) { return ['date']; }
}

async function listCustomReports(activeOnly) {
    const where = activeOnly ? ' WHERE is_active = 1' : '';
    const [rows] = await pool.execute(
        'SELECT id, title, category, filters_json, sql_query, is_active, created_at '
        + 'FROM cc_custom_reports' + where + ' ORDER BY category, title, id'
    );
    return rows.map(r => ({
        id: r.id, title: r.title, category: r.category,
        filters: parseCustomFiltersJson(r.filters_json),
        filters_json: r.filters_json, sql_query: r.sql_query,
        is_active: !!r.is_active, created_at: r.created_at,
    }));
}

async function getCustomReport(id) {
    const [rows] = await pool.execute(
        'SELECT id, title, category, filters_json, sql_query, is_active, created_at '
        + 'FROM cc_custom_reports WHERE id = ? LIMIT 1', [id]
    );
    if (!rows.length) return null;
    const r = rows[0];
    return {
        id: r.id, title: r.title, category: r.category,
        filters: parseCustomFiltersJson(r.filters_json),
        filters_json: r.filters_json, sql_query: r.sql_query,
        is_active: !!r.is_active, created_at: r.created_at,
    };
}

async function createCustomReport(data) {
    const filters = Array.isArray(data.filters) ? data.filters : ['date'];
    const [result] = await pool.execute(
        'INSERT INTO cc_custom_reports (title, category, filters_json, sql_query, is_active) VALUES (?, ?, ?, ?, ?)',
        [String(data.title||'').trim(), String(data.category||'agents'),
         JSON.stringify(filters), String(data.sql_query||''), data.is_active ? 1 : 0]
    );
    return result.insertId;
}

async function updateCustomReport(id, data) {
    const fields = []; const values = [];
    if (data.title !== undefined) { fields.push('title = ?'); values.push(String(data.title).trim()); }
    if (data.category !== undefined) { fields.push('category = ?'); values.push(String(data.category)); }
    if (data.filters !== undefined) { fields.push('filters_json = ?'); values.push(JSON.stringify(Array.isArray(data.filters)?data.filters:['date'])); }
    if (data.sql_query !== undefined) { fields.push('sql_query = ?'); values.push(String(data.sql_query)); }
    if (data.is_active !== undefined) { fields.push('is_active = ?'); values.push(data.is_active ? 1 : 0); }
    if (!fields.length) return 0;
    values.push(id);
    const [result] = await pool.execute('UPDATE cc_custom_reports SET ' + fields.join(', ') + ' WHERE id = ?', values);
    return result.affectedRows;
}

async function deleteCustomReport(id) {
    const [result] = await pool.execute('DELETE FROM cc_custom_reports WHERE id = ?', [id]);
    return result.affectedRows;
}

async function loadTodayStats(todayStr) {
    const [k] = await pool.execute('SELECT * FROM cc_daily_kpis WHERE stat_date = ? LIMIT 1', [todayStr]);
    const [a] = await pool.execute('SELECT agent_key, calls_taken, calls_made, pause_count FROM cc_daily_agent_stats WHERE stat_date = ?', [todayStr]);
    return { kpis: k[0] || null, agents: a || [] };
}

async function saveTodayKpis(todayStr, evKpi) {
    await pool.execute(
        'INSERT INTO cc_daily_kpis (stat_date, completed, abandoned, asa_sum, asa_n, talk_sum, talk_n) '
        + 'VALUES (?, ?, ?, ?, ?, ?, ?) '
        + 'ON DUPLICATE KEY UPDATE completed=VALUES(completed), abandoned=VALUES(abandoned), asa_sum=VALUES(asa_sum), asa_n=VALUES(asa_n), talk_sum=VALUES(talk_sum), talk_n=VALUES(talk_n)',
        [todayStr, evKpi.completed||0, evKpi.abandoned||0, evKpi.asaSum||0, evKpi.asaN||0, evKpi.talkSum||0, evKpi.talkN||0]
    );
}

async function saveTodayAgentStat(todayStr, agentKey, stats) {
    await pool.execute(
        'INSERT INTO cc_daily_agent_stats (stat_date, agent_key, calls_taken, calls_made, pause_count) '
        + 'VALUES (?, ?, ?, ?, ?) '
        + 'ON DUPLICATE KEY UPDATE calls_taken=VALUES(calls_taken), calls_made=VALUES(calls_made), pause_count=VALUES(pause_count)',
        [todayStr, String(agentKey), stats.callsTaken||0, stats.callsMade||0, stats.pauseCount||0]
    );
}

// ---- Reports (new) ----
function buildDateRange(from, to) {
    const f = reportDate(from) || '1970-01-01';
    const t = reportDate(to) || '2999-12-31';
    return { f, t };
}

async function reportAgentPerformance({ from, to, agentId }) {
    const { f, t } = buildDateRange(from, to);
    // taken/made from daily agent stats (by ext)
    let agentFilterSql = '';
    const vals = [f, t];
    if (agentId) { agentFilterSql = ' AND ag.id = ?'; vals.push(agentId); }
    const [rows] = await pool.execute(
        'SELECT ag.id AS agent_id, ag.username, ag.sip_extension AS extension, '
        + 'COALESCE(SUM(s.calls_taken),0) AS taken, COALESCE(SUM(s.calls_made),0) AS made, '
        + 'COALESCE(SUM(s.pause_count),0) AS pause_count_stat '
        + 'FROM cc_agents ag '
        + 'LEFT JOIN cc_daily_agent_stats s ON s.agent_key = ag.sip_extension AND s.stat_date BETWEEN ? AND ? '
        + 'WHERE 1=1 ' + agentFilterSql
        + ' GROUP BY ag.id, ag.username, ag.sip_extension ORDER BY ag.username', vals
    );
    // pause time per agent from logs
    const pauseWhere = ["l.event_type='pause'"]; const pv=[f,t];
    if (agentId) { pauseWhere.push('l.agent_id=?'); pv.push(agentId); }
    const [pauseRows] = await pool.execute(
        'SELECT l.agent_id, COALESCE(SUM(TIMESTAMPDIFF(SECOND,l.event_time,COALESCE(('
        + "SELECT MIN(l2.event_time) FROM cc_agent_logs l2 WHERE l2.agent_id=l.agent_id AND l2.event_time>l.event_time AND l2.event_type IN ('unpause','logout')"
        + '), NOW()))),0) AS pause_seconds '
        + 'FROM cc_agent_logs l WHERE DATE(l.event_time) BETWEEN ? AND ? AND ' + pauseWhere.join(' AND ')
        + ' GROUP BY l.agent_id', pv
    );
    const pauseMap = new Map(pauseRows.map(r => [r.agent_id, Number(r.pause_seconds||0)]));
    // abuse from requeue logs
    const abVals=[f,t]; let abFilter='';
    if (agentId) { abFilter=' AND ag.id=?'; abVals.push(agentId); }
    const [abRows] = await pool.execute(
        'SELECT ag.id AS agent_id, '
        + "SUM(CASE WHEN q.reason='TIMEOUT' THEN 1 ELSE 0 END) AS timeout_count, "
        + "SUM(CASE WHEN q.reason='DECLINED' THEN 1 ELSE 0 END) AS declined_count, "
        + 'COUNT(q.id) AS total_abuse '
        + 'FROM cc_agents ag LEFT JOIN queue_requeue_logs q ON q.agent_ext = ag.sip_extension AND DATE(q.created_at) BETWEEN ? AND ? '
        + 'WHERE 1=1 ' + abFilter + ' GROUP BY ag.id', abVals
    );
    const abMap = new Map(abRows.map(r => [r.agent_id, r]));
    return rows.map(r => {
        const ab = abMap.get(r.agent_id) || {};
        const taken = Number(r.taken||0);
        return {
            agent: r.username, extension: r.extension,
            taken, made: Number(r.made||0),
            total_talk_time: 0, avg_talk: 0, // enriched from queue_log in server
            pause_time: pauseMap.get(r.agent_id)||0,
            timeout_count: Number(ab.timeout_count||0),
            declined_count: Number(ab.declined_count||0),
            total_abuse: Number(ab.total_abuse||0),
        };
    });
}

async function reportRequeueAbuseLog({ from, to, agent, queue, reason, limit, offset, countOnly }) {
    const { f, t } = buildDateRange(from, to);
    const where = ['DATE(created_at) BETWEEN ? AND ?'];
    const vals = [f, t];
    if (queue) { where.push('queue_name=?'); vals.push(String(queue)); }
    if (agent) { where.push('(agent_ext=? OR agent_name=? OR agent_ext IN (SELECT sip_extension FROM cc_agents WHERE id=?))'); vals.push(String(agent), String(agent), parseInt(agent,10)||0); }
    if (reason && reason !== 'ALL') { where.push('reason=?'); vals.push(String(reason).toUpperCase()); }
    const w = ' WHERE ' + where.join(' AND ');
    if (countOnly) {
        const [r] = await pool.execute('SELECT COUNT(*) c FROM queue_requeue_logs' + w, vals);
        return { total: r[0].c };
    }
    const lim = Math.min(10000, Math.max(1, parseInt(limit,10)||100));
    const off = Math.max(0, parseInt(offset,10)||0);
    const [rows] = await pool.execute(
        'SELECT created_at, caller_id, queue_name, COALESCE(agent_name,agent_ext) agent, reason, ring_duration_ms '
        + 'FROM queue_requeue_logs' + w + ' ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?', vals.concat([lim, off])
    );
    return { rows };
}

async function reportOutboundCalls({ from, to, agentId, limit, offset, countOnly }) {
    const { f, t } = buildDateRange(from, to);
    let extList = [];
    if (agentId) {
        const [a] = await pool.execute('SELECT username, sip_extension FROM cc_agents WHERE id=?', [agentId]);
        if (a.length) extList = [{ ext: a[0].sip_extension, name: a[0].username }];
    } else {
        const [a] = await pool.execute('SELECT username, sip_extension FROM cc_agents');
        extList = a.map(x=>({ext:x.sip_extension,name:x.username}));
    }
    const exts = extList.map(x=>String(x.ext));
    if (!exts.length) return countOnly ? {total:0} : {rows:[]};
    const placeholders = exts.map(()=>'?').join(',');
    const baseWhere = `DATE(calldate) BETWEEN ? AND ? AND (src IN (${placeholders}) OR cnum IN (${placeholders})) AND dcontext NOT LIKE 'ext-queues%' AND dst NOT REGEXP '^(800|802)$' AND LENGTH(dst) > 2`;
    const vals = [f,t].concat(exts).concat(exts);
    if (countOnly) {
        const [r] = await pool.execute('SELECT COUNT(*) c FROM asteriskcdrdb.cdr WHERE ' + baseWhere, vals);
        return { total: r[0].c };
    }
    const lim = Math.min(10000, Math.max(1, parseInt(limit,10)||100));
    const off = Math.max(0, parseInt(offset,10)||0);
    const [rows] = await pool.execute(
        'SELECT calldate, src, cnum, dst, billsec, duration, disposition FROM asteriskcdrdb.cdr WHERE ' + baseWhere
        + ' ORDER BY calldate DESC LIMIT ? OFFSET ?', vals.concat([lim, off])
    );
    const nameByExt = new Map(extList.map(x=>[String(x.ext), x.name]));
    return { rows: rows.map(r => ({
        datetime: r.calldate, agent: nameByExt.get(String(r.src)) || nameByExt.get(String(r.cnum)) || String(r.src),
        extension: String(r.src||r.cnum), destination: String(r.dst), duration: Number(r.billsec||0), disposition: String(r.disposition||'')
    })) };
}



function parseQueueLogLine(line) {
    // epoch|uniqueid|queuename|agent|event|data1|data2|data3|data4|data5
    const p = String(line||'').trim().split('|');
    if (p.length < 5) return null;
    const ts = parseInt(p[0],10);
    if (!Number.isFinite(ts)) return null;
    return { ts, time: new Date(ts*1000), uniqueid: p[1]||'', queue: p[2]||'', agent: p[3]||'', event: p[4]||'', d1:p[5]||'', d2:p[6]||'', d3:p[7]||'', d4:p[8]||'', d5:p[9]||'', raw:p };
}

function inDateRange(tsSec, fromStr, toStr) {
    const d = new Date(tsSec*1000);
    const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), da=String(d.getDate()).padStart(2,'0');
    const ds = y+'-'+m+'-'+da;
    if (fromStr && ds < fromStr) return false;
    if (toStr && ds > toStr) return false;
    return true;
}

function readQueueLogEvents(from, to) {
    const fs = require('fs');
    const file = '/var/log/asterisk/queue_log';
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return []; }
    const fromStr = reportDate(from);
    const toStr = reportDate(to);
    const out = [];
    for (const line of text.split('\n')) {
        const ev = parseQueueLogLine(line);
        if (!ev) continue;
        if (!inDateRange(ev.ts, fromStr, toStr)) continue;
        out.push(ev);
    }
    return out;
}

function reportQueueSummarySla({ from, to, queue }) {
    const events = readQueueLogEvents(from, to);
    const byQ = new Map();
    function qobj(q){ if(!byQ.has(q)) byQ.set(q,{queue:q,total:0,completed:0,abandoned:0,asaSum:0,asaN:0,talkSum:0,talkN:0,slaNum:0,slaDen:0,slSec:null}); return byQ.get(q); }
    const waitByUidQ = new Map(); // uniqueid|queue -> {enterTs, pos}
    for (const ev of events) {
        const q = ev.queue; if(!q || q==='NONE') continue;
        if (queue && q !== String(queue)) continue;
        const o = qobj(q);
        if (ev.event === 'ENTERQUEUE') { waitByUidQ.set(ev.uniqueid+'|'+q, {enter: ev.ts}); o.total++; }
        else if (ev.event === 'CONNECT') { const k=ev.uniqueid+'|'+q; const w=waitByUidQ.get(k); const wait = w? Math.max(0, ev.ts-w.enter): (parseInt(ev.d1,10)||0); o.asaSum += wait; o.asaN++; /* SLA: CONNECT has holdtime in d1 */ const hold=parseInt(ev.d1,10); if(Number.isFinite(hold)){ o.slaDen++; if(hold<=20) o.slaNum++; } }
        else if (ev.event === 'COMPLETEAGENT' || ev.event === 'COMPLETECALLER') { o.completed++; const hold=parseInt(ev.d1,10)||0; const talk=parseInt(ev.d2,10)||0; o.talkSum += talk; o.talkN++; }
        else if (ev.event === 'ABANDON') { o.abandoned++; waitByUidQ.delete(ev.uniqueid+'|'+q); }
        else if (ev.event === 'EXITWITHTIMEOUT') { /* treated as abandoned-ish in some setups but usually separate; count as abandoned for traffic */ o.abandoned++; }
    }
    // total should include abandoned not seen as ENTER in range? better compute from completed+abandoned seen with totals: ensure total >= completed+abandoned
    const rows = [];
    for (const o of byQ.values()) {
        if (o.total < o.completed + o.abandoned) o.total = o.completed + o.abandoned;
        const abandonPct = o.total ? ((o.abandoned/o.total)*100) : 0;
        const avgQsa = o.asaN ? (o.asaSum/o.asaN) : 0;
        const avgTalk = o.talkN ? (o.talkSum/o.talkN) : 0;
        const slaPct = o.slaDen ? ((o.slaNum/o.slaDen)*100) : null;
        rows.push({ queue:o.queue, total_calls:o.total, completed:o.completed, abandoned:o.abandoned, abandon_pct:abandonPct, avg_qsa:avgQsa, avg_talk:avgTalk, sla_pct:slaPct });
    }
    rows.sort((a,b)=>String(a.queue).localeCompare(String(b.queue)));
    return { rows };
}

function reportHourlyTraffic({ from, to, queue }) {
    const events = readQueueLogEvents(from, to);
    const hours = Array.from({length:24},(_,h)=>({hour:String(h).padStart(2,'0')+':00', total:0, completed:0, abandoned:0, asaSum:0, asaN:0}));
    const waitByUidQ = new Map();
    for (const ev of events) {
        const q = ev.queue; if(!q || q==='NONE') continue;
        if (queue && q !== String(queue)) continue;
        const h = ev.time.getHours();
        if (ev.event === 'ENTERQUEUE') { waitByUidQ.set(ev.uniqueid+'|'+q, {enter: ev.ts}); hours[h].total++; }
        else if (ev.event === 'CONNECT') { const k=ev.uniqueid+'|'+q; const w=waitByUidQ.get(k); const wait = w? Math.max(0, ev.ts-w.enter): (parseInt(ev.d1,10)||0); hours[h].asaSum += wait; hours[h].asaN++; }
        else if (ev.event === 'COMPLETEAGENT' || ev.event === 'COMPLETECALLER') { hours[h].completed++; }
        else if (ev.event === 'ABANDON' || ev.event === 'EXITWITHTIMEOUT') { hours[h].abandoned++; }
    }
    return { rows: hours.map(o=>({hour:o.hour,total:o.total,completed:o.completed,abandoned:o.abandoned,avg_qsa:o.asaN?(o.asaSum/o.asaN):0})) };
}

function reportQueueCallsDetail({ from, to, queue, agent, limit, offset, countOnly }) {
    const events = readQueueLogEvents(from, to);
    const calls = new Map(); // uniqueid|q
    for (const ev of events) {
        const q = ev.queue; if(!q || q==='NONE') continue;
        if (queue && q !== String(queue)) continue;
        const key = ev.uniqueid+'|'+q;
        if (ev.event === 'ENTERQUEUE') { calls.set(key,{datetime:ev.time, caller:ev.d2||'', queue:q, agent:'', wait:null, talk:null, status:'Waiting', enter:ev.ts, connect:null}); }
        else if (ev.event === 'CONNECT') { const c=calls.get(key); if(c){ c.agent = ev.agent && ev.agent!=='NONE'? ev.agent : c.agent; c.connect=ev.ts; c.wait = c.enter!=null? Math.max(0, ev.ts-c.enter): parseInt(ev.d1,10)||0; c.status='In Call'; } }
        else if (ev.event === 'COMPLETEAGENT' || ev.event === 'COMPLETECALLER') { const c=calls.get(key); if(c){ c.agent = ev.agent && ev.agent!=='NONE'? ev.agent : c.agent; c.wait = c.wait!=null?c.wait:(parseInt(ev.d1,10)||0); c.talk = parseInt(ev.d2,10)||0; c.status='Completed'; } else { calls.set(key,{datetime:ev.time, caller:'', queue:q, agent:ev.agent||'', wait:parseInt(ev.d1,10)||0, talk:parseInt(ev.d2,10)||0, status:'Completed', enter:null, connect:null}); } }
        else if (ev.event === 'ABANDON') { const c=calls.get(key); if(c){ c.wait = c.enter!=null? Math.max(0, ev.ts-c.enter): parseInt(ev.d3,10)||parseInt(ev.d2,10)||0; c.status='Abandoned'; c.talk=null; } else { calls.set(key,{datetime:ev.time, caller:'', queue:q, agent:'', wait:parseInt(ev.d3,10)||0, talk:null, status:'Abandoned', enter:null, connect:null}); } }
        else if (ev.event === 'EXITWITHTIMEOUT') { const c=calls.get(key); if(c){ c.wait = c.enter!=null? Math.max(0, ev.ts-c.enter): null; c.status='Timeout'; } }
    }
    let rows = Array.from(calls.values()).map(c=>{
        let ag = c.agent||'';
        const m = /\/(\d+)$/.exec(ag) || /^(\d+)$/.exec(ag);
        if (m) ag = m[1]; else ag = ag.replace(/^PJSIP\/|^SIP\//,'');
        return { datetime: c.datetime, caller_id: c.caller||'', queue: c.queue, agent: ag, wait_time: c.wait, talk_time: c.talk, status: c.status };
    });
    if (agent) { const a=String(agent).toLowerCase(); rows = rows.filter(r=>String(r.agent).toLowerCase().includes(a)); }
    rows.sort((a,b)=> (b.datetime?.getTime()||0) - (a.datetime?.getTime()||0));
    if (countOnly) return { total: rows.length };
    const lim = Math.min(10000, Math.max(1, parseInt(limit,10)||100));
    const off = Math.max(0, parseInt(offset,10)||0);
    return { total: rows.length, rows: rows.slice(off, off+lim) };
}

module.exports = {
    pool,
    findAgent,
    findAgentByIssabelUsername,
    findAgentByIssabelIdentity,
    ensureIssabelUsernameColumn,
    ensureIssabelUserIdColumn,
    sipSecret,
    sipInterface,
    agentQueues,
    pauseReasons,
    pauseReasonId,
    logEvent,
    knownAgents,
    listExtensions,
    listQueues,
    queueNames,
    allAgentQueues,
    allAgents,
    createAgent,
    updateAgent,
    disableAgent,
    setAgentQueues,
    allPauseReasons,
    createPauseReason,
    updatePauseReason,
    pauseReasonLogCount,
    deletePauseReason,
    agentLogs,
    pauseSummary,
    agentSummary,
    ping,
    ensureRequeueTable,
    insertRequeueLog,
    listRequeueLogs,
    getTodayAgentAbuseStats,
    ensureDailyStatsTables,
    ensureCustomReportsTable,
    listCustomReports,
    getCustomReport,
    createCustomReport,
    updateCustomReport,
    deleteCustomReport,
    loadTodayStats,
    saveTodayKpis,
    saveTodayAgentStat,
    reportAgentPerformance,
    reportRequeueAbuseLog,
    reportOutboundCalls,
    reportQueueSummarySla,
    reportHourlyTraffic,
    reportQueueCallsDetail,
};
