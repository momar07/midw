'use strict';

// A small client of the Asterisk Manager Interface (AMI), on the modules of
// node only: the socket, the login, the actions and the events.
//
//   const ami = new Ami({host, port, user, secret});
//   await ami.action('QueueAdd', {Queue: '800', Interface: 'PJSIP/1000'});
//   ami.on('event', (name, fields) => { ... });
//
// The connection is kept open, the events arrive on it and it is reopened
// with a backoff when it breaks.

const net = require('net');
const EventEmitter = require('events');

const LOGIN_TIMEOUT = 10000;

class Ami extends EventEmitter {
    constructor(options) {
        super();
        this.host = options.host || '127.0.0.1';
        this.port = options.port || 5038;
        this.user = options.user || '';
        this.secret = options.secret || '';
        this.timeout = (options.timeout || 5) * 1000;
        this.socket = null;
        this.buffer = '';
        this.pending = new Map();     // ActionID -> {resolve, reject, timer}
        this.actionId = 0;
        this.loggedIn = false;
        this.closed = false;
        this.retry = 1000;
        this.connect();
    }

    //-------------------------------------------------------------------------
    // the connection
    //-------------------------------------------------------------------------
    connect() {
        if (this.closed) {
            return;
        }
        const socket = net.createConnection({ host: this.host, port: this.port });
        this.socket = socket;
        socket.setEncoding('utf8');

        // the timeout is for the connection, an open ami connection is idle
        // most of the time and must not be killed
        socket.setTimeout(this.timeout);

        socket.on('connect', () => {
            this.retry = 1000;
            this.buffer = '';
            socket.setTimeout(0);
            // the greeting comes first, the login is sent after it
            this.waitingForGreeting = true;
        });

        socket.on('data', (chunk) => {
            this.buffer += chunk;
            this.read();
        });

        socket.on('timeout', () => {
            console.error('the ami connection timed out');
            socket.destroy();
        });

        // the actions have their own timeout

        socket.on('error', (e) => {
            this.loggedIn = false;
            if (!this.closed) {
                console.error('the ami connection failed: ' + e.message);
            }
            this.retryLater();
        });

        socket.on('close', () => {
            this.loggedIn = false;
            this.rejectAll(new Error('the ami connection is closed'));
            this.retryLater();
        });
    }

    retryLater() {
        if (this.closed) {
            return;
        }
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.connect(), this.retry);
        this.retry = Math.min(this.retry * 2, 30000);
    }

    read() {
        // the greeting is a single line, it ends with one crlf and not with
        // the empty line that ends a block
        if (this.waitingForGreeting) {
            const pos = this.buffer.indexOf('\r\n');
            if (pos < 0) {
                return;
            }
            this.buffer = this.buffer.substring(pos + 2);
            this.waitingForGreeting = false;
            this.login();
        }
        let index;
        while ((index = this.buffer.indexOf('\r\n\r\n')) >= 0) {
            const block = this.buffer.substring(0, index);
            this.buffer = this.buffer.substring(index + 4);
            this.handle(block);
        }
    }

    handle(block) {
        const fields = {};
        for (const line of block.split('\r\n')) {
            const pos = line.indexOf(': ');
            if (pos > 0) {
                fields[line.substring(0, pos)] = line.substring(pos + 2);
            }
        }
        // an event, it carries the ActionID of the action that caused it
        if (fields.Event) {
            this.emit('event', fields.Event, fields);
            const id = fields.ActionID;
            if (id && this.pending.has(id)) {
                const pending = this.pending.get(id);
                if (pending.collector) {
                    pending.collector.events.push({ event: fields.Event, fields: fields });
                    const done = pending.collector.doneEvents;
                    if (!done || done.indexOf(fields.Event) !== -1) {
                        this.pending.delete(id);
                        clearTimeout(pending.timer);
                        pending.resolve(pending.collector.events);
                    }
                }
            }
            return;
        }
        // the answer of the login, it has no ActionID
        if (fields.Response && !fields.ActionID) {
            if (fields.Response === 'Success') {
                this.loggedIn = true;
                clearTimeout(this.loginTimer);
                this.emit('login');
            } else {
                console.error('the ami login was refused: ' + (fields.Message || fields.Response));
                if (this.socket) {
                    this.socket.destroy();
                }
            }
            return;
        }
        if (!fields.ActionID) {
            return;
        }
        const pending = this.pending.get(fields.ActionID);
        if (!pending) {
            return;
        }
        if (pending.collector) {
            // actionCollect waits for the terminal event, but fail fast on error
            if (fields.Response === 'Error') {
                this.pending.delete(fields.ActionID);
                clearTimeout(pending.timer);
                pending.reject(new Error(fields.Message || ('the ami answered ' + fields.Response)));
            }
            return;
        }
        this.pending.delete(fields.ActionID);
        clearTimeout(pending.timer);
        if (fields.Response === 'Success' || fields.Response === 'Follows') {
            pending.resolve(fields);
        } else {
            pending.reject(new Error(fields.Message || ('the ami answered ' + fields.Response)));
        }
    }

    login() {
        this.write({ Action: 'Login', Username: this.user, Secret: this.secret });
        const timer = setTimeout(() => {
            console.error('the ami login did not answer');
            this.rejectAll(new Error('the ami login timed out'));
            if (this.socket) {
                this.socket.destroy();
            }
        }, LOGIN_TIMEOUT);
        this.loginTimer = timer;
    }

    write(fields) {
        if (!this.socket || this.socket.destroyed) {
            return false;
        }
        let text = '';
        for (const key of Object.keys(fields)) {
            if (fields[key] === undefined || fields[key] === null) {
                continue;
            }
            text += key + ': ' + fields[key] + '\r\n';
        }
        this.socket.write(text + '\r\n');
        return true;
    }

    //-------------------------------------------------------------------------
    // the actions
    //-------------------------------------------------------------------------
    action(name, params) {
        return new Promise((resolve, reject) => {
            if (!this.socket || !this.loggedIn) {
                reject(new Error('the ami connection is not ready'));
                return;
            }
            const id = String(++this.actionId);
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error('the action ' + name + ' timed out'));
            }, this.timeout);
            this.pending.set(id, { resolve: resolve, reject: reject, timer: timer });
            const fields = Object.assign({ Action: name, ActionID: id }, params || {});
            if (!this.write(fields)) {
                this.pending.delete(id);
                clearTimeout(timer);
                reject(new Error('the ami connection is not ready'));
            }
        });
    }

    // Sends an action and collects all related events until one of doneEvents.
    actionCollect(name, params, doneEvents) {
        return new Promise((resolve, reject) => {
            if (!this.socket || !this.loggedIn) {
                reject(new Error('the ami connection is not ready'));
                return;
            }
            const id = String(++this.actionId);
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error('the action ' + name + ' timed out'));
            }, this.timeout);
            this.pending.set(id, {
                resolve: resolve,
                reject: reject,
                timer: timer,
                collector: { events: [], doneEvents: doneEvents || null },
            });
            const fields = Object.assign({ Action: name, ActionID: id }, params || {});
            if (!this.write(fields)) {
                this.pending.delete(id);
                clearTimeout(timer);
                reject(new Error('the ami connection is not ready'));
            }
        });
    }

    // Subscribes to the given asterisk events (push) and resolves when all are on.
    async subscribe(events) {
        for (const ev of events) {
            try {
                await this.action('Subscribe', { Event: ev });
            } catch (e) {
                console.warn('the ami could not subscribe to ' + ev + ': ' + e.message);
            }
        }
    }

    rejectAll(error) {
        for (const id of Array.from(this.pending.keys())) {
            const pending = this.pending.get(id);
            this.pending.delete(id);
            clearTimeout(pending.timer);
            pending.reject(error);
        }
    }

    close() {
        this.closed = true;
        clearTimeout(this.retryTimer);
        if (this.socket) {
            this.socket.destroy();
        }
    }
}

module.exports = { Ami };
