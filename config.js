'use strict';

// The configuration of the middleware. The environment wins over the defaults,
// the .env file is read from the folder of the project.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

function num(name, fallback) {
    const value = parseInt(process.env[name], 10);
    return Number.isFinite(value) ? value : fallback;
}

function str(name, fallback) {
    const value = process.env[name];
    return value && value.length ? value : fallback;
}

module.exports = {
    port: num('PORT', 8080),

    db: {
        host: str('DB_HOST', 'localhost'),
        user: str('DB_USER', 'cc_middleware'),
        password: str('DB_PASS', ''),
        database: str('DB_NAME', 'asterisk'),
        connectionLimit: num('DB_POOL', 5),
    },

    // the sip server the agent registers to, it is the Issabel box itself
    sip: {
        serverIp: str('SIP_SERVER_IP', '192.168.2.22'),
        serverPort: num('SIP_SERVER_PORT', 5060),
    },

    // the token of the sessions and of the admin hook
    tokenSecret: str('TOKEN_SECRET', 'change-me-please'),
    adminToken: str('ADMIN_TOKEN', ''),

    // the WhatsApp service's internal API (phonebar Phase 2): the login
    // snapshot ping and the quick-reply forward call it with the
    // service's INTERNAL_API_TOKEN. Empty = the Phase 2 legs stay off
    // (Phase 1 notifications, which travel the other way, are unaffected)
    waInternalUrl: str('WA_INTERNAL_URL', '').replace(/\/+$/, ''),
    waInternalToken: str('WA_INTERNAL_TOKEN', ''),
    tokenTtlSeconds: num('TOKEN_TTL', 12 * 3600),

    // the keepalive
    pingSeconds: num('PING_SECONDS', 30),
    missedPongs: num('MISSED_PONGS', 2),

    // the asterisk manager interface, without a user there is no ami
    ami: {
        host: str('AMI_HOST', '127.0.0.1'),
        port: num('AMI_PORT', 5038),
        user: str('AMI_USER', ''),
        secret: str('AMI_SECRET', ''),
        timeout: num('AMI_TIMEOUT', 5),
    },

    // queue/monitor polling
    queuePollSeconds: num('QUEUE_POLL_SECONDS', 5),
};
