// Minimal Loxone Miniserver for tests: version check, hash login, structure file and value events.
const http = require('http');
const WebSocket = require('ws');

function header(identifier, len) {
    const buf = Buffer.alloc(8);
    buf.writeUInt8(0x03, 0);
    buf.writeUInt8(identifier, 1);
    buf.writeUInt32LE(len, 4);
    return buf;
}

function uuidToBuffer(uuid) {
    const parts = uuid.split('-');
    const buf = Buffer.alloc(16);
    Buffer.from(parts[0], 'hex').reverse().copy(buf, 0);
    Buffer.from(parts[1], 'hex').reverse().copy(buf, 4);
    Buffer.from(parts[2], 'hex').reverse().copy(buf, 6);
    Buffer.from(parts[3], 'hex').copy(buf, 8);
    return buf;
}

function valueTable(events) {
    const buf = Buffer.alloc(events.length * 24);
    events.forEach(function (evt, i) {
        uuidToBuffer(evt.uuid).copy(buf, i * 24);
        buf.writeDoubleLE(evt.value, i * 24 + 16);
    });
    return buf;
}

class MockMiniserver {
    constructor(options) {
        this.options = Object.assign({
            structure: {lastModified: '2026-01-01 00:00:00', msInfo: {serialNr: 'TEST'}, rooms: {}, cats: {}, controls: {}},
            apiBody: null,
            password: 'secret',
        }, options || {});
        this.httpRequests = 0;
        this.wsConnections = 0;
        this.received = [];
        this.sockets = new Set();
        this.server = http.createServer((req, res) => {
            this.httpRequests++;
            if (req.url === '/jdev/cfg/api') {
                const body = this.options.apiBody !== null ? this.options.apiBody
                    : JSON.stringify({LL: {control: 'dev/cfg/api', value: "{'snr': 'TEST', 'version':'8.3.3.21'}", Code: '200'}});
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(body);
                return;
            }
            res.writeHead(404);
            res.end();
        });
        this.wss = new WebSocket.Server({
            server: this.server,
            handleProtocols: (protocols) => protocols.has('remotecontrol') ? 'remotecontrol' : false,
        });
        this.wss.on('connection', (ws) => {
            this.wsConnections++;
            this.sockets.add(ws);
            ws.on('close', () => this.sockets.delete(ws));
            ws.on('message', (data) => this._handle(ws, data.toString()));
        });
    }

    listen() {
        return new Promise((resolve) => {
            this.server.listen(0, '127.0.0.1', () => {
                this.port = this.server.address().port;
                resolve(this);
            });
        });
    }

    get host() {
        return '127.0.0.1:' + this.port;
    }

    sendText(ws, text, identifier) {
        const data = Buffer.from(text);
        ws.send(header(identifier || 0, data.length));
        ws.send(text);
    }

    reply(ws, control, value, code) {
        this.sendText(ws, JSON.stringify({LL: {control: control, value: value, Code: code || '200'}}));
    }

    sendValues(events) {
        const table = valueTable(events);
        this.sockets.forEach((ws) => {
            ws.send(header(2, table.length));
            ws.send(table);
        });
    }

    dropAll() {
        this.sockets.forEach((ws) => ws.terminate());
    }

    _handle(ws, msg) {
        this.received.push(msg);
        if (msg === 'keepalive') {
            ws.send(header(6, 0));
        } else if (msg === 'jdev/sys/getkey') {
            this.reply(ws, 'jdev/sys/getkey', Buffer.from('testkey').toString('hex'));
        } else if (msg.startsWith('authenticate/')) {
            this.reply(ws, msg, '', this.options.password === 'secret' ? '200' : '401');
        } else if (msg === 'jdev/sps/LoxAPPversion3') {
            this.reply(ws, 'dev/sps/LoxAPPversion3', this.options.structure.lastModified);
        } else if (msg === 'data/LoxAPP3.json') {
            this.sendText(ws, JSON.stringify(this.options.structure), 1);
        } else if (msg === 'jdev/sps/enablebinstatusupdate') {
            this.reply(ws, 'dev/sps/enablebinstatusupdate', '1');
        } else if (msg.startsWith('jdev/sps/io')) {
            this.reply(ws, msg.replace(/^j/, ''), '1');
        }
    }

    close() {
        this.dropAll();
        return new Promise((resolve) => {
            this.wss.close(() => this.server.close(() => resolve()));
        });
    }
}

module.exports = MockMiniserver;
