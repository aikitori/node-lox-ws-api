const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const API = require('../lib/API.js');
const MockMiniserver = require('./mock-miniserver.js');

const UUID = '0f1e2d3c-4b5a-6978-8796a5b4c3d2e1f0';

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function once(emitter, event, timeout) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout waiting for ' + event)), timeout || 3000);
        emitter.once(event, function () {
            clearTimeout(timer);
            resolve(Array.from(arguments));
        });
    });
}

function freePort() {
    return new Promise((resolve) => {
        const srv = net.createServer().listen(0, '127.0.0.1', () => {
            const port = srv.address().port;
            srv.close(() => resolve(port));
        });
    });
}

test('connects, logs in, loads the structure and parses value events', async () => {
    const ms = await new MockMiniserver().listen();
    const client = new API(ms.host, 'admin', 'secret', true, 'Hash', 30000);
    client.connect();
    const [structure] = await once(client, 'get_structure_file');
    assert.strictEqual(structure.msInfo.serialNr, 'TEST');

    await wait(50);
    const event = once(client, 'update_event_value');
    ms.sendValues([{uuid: UUID, value: 21.5}]);
    assert.deepStrictEqual(await event, [UUID, 21.5]);

    const sent = once(client, 'send');
    client.send_control_command('abc', 'on');
    assert.ok((await sent)[0].startsWith('jdev/sps/ios/'));

    const closed = once(client, 'close');
    client.abort();
    await closed;
    await ms.close();
});

test('waits longer between attempts while the miniserver is unreachable', async () => {
    const port = await freePort();
    const client = new API('127.0.0.1:' + port, 'admin', 'secret', true, 'Hash', 30000);
    const delays = [];
    let failed = 0;
    let closes = 0;
    client.on('reconnect', (delay) => delays.push(delay));
    client.on('connect_failed', () => failed++);
    client.on('close', () => closes++);
    client.connect();
    await wait(3500);
    client.abort();
    // about 0 s, 1 s, 3 s: three attempts instead of hundreds
    assert.ok(failed >= 2 && failed <= 4, 'attempts: ' + failed);
    assert.ok(delays[0] >= 750 && delays[0] <= 1250, 'first delay ' + delays[0]);
    assert.ok(delays[1] >= 1500 && delays[1] <= 2500, 'second delay ' + delays[1]);
    assert.strictEqual(closes, 0, 'never connected, so no close');
});

test('a dropped connection emits close once and reconnects', async () => {
    const ms = await new MockMiniserver().listen();
    const client = new API(ms.host, 'admin', 'secret', true, 'Hash', 30000);
    let closes = 0;
    client.on('close', () => closes++);
    client.connect();
    await once(client, 'get_structure_file');

    ms.dropAll();
    await once(client, 'get_structure_file', 5000);
    assert.strictEqual(closes, 1);
    assert.strictEqual(ms.wsConnections, 2);

    client.abort();
    await ms.close();
});

test('abort stops a pending reconnect', async () => {
    const ms = await new MockMiniserver().listen();
    const client = new API(ms.host, 'admin', 'secret', true, 'Hash', 30000);
    client.connect();
    await once(client, 'get_structure_file');
    ms.dropAll();
    await once(client, 'reconnect');
    client.abort();
    await wait(1500);
    assert.strictEqual(ms.wsConnections, 1);
    assert.strictEqual(client.is_connected(), false);
    await ms.close();
});

test('abort during the version check does not connect afterwards', async () => {
    const ms = await new MockMiniserver().listen();
    const client = new API(ms.host, 'admin', 'secret', true, 'Hash', 30000);
    const aborted = once(client, 'abort');
    client.connect();
    client.abort();
    await aborted;
    await wait(300);
    assert.strictEqual(ms.wsConnections, 0);
    await ms.close();
});

test('an invalid version check answer does not crash', async () => {
    const ms = await new MockMiniserver({apiBody: '<html>booting</html>'}).listen();
    const client = new API(ms.host, 'admin', 'secret', true, 'Hash', 30000);
    client.connect();
    const [, reason] = await once(client, 'connect_failed');
    assert.match(reason, /version check failed/);
    client.abort();
    await ms.close();
});

test('missing keepalive answers lead to a reconnect', async () => {
    const ms = await new MockMiniserver().listen();
    ms._handle = function (ws, msg) {
        if (msg !== 'keepalive') {
            MockMiniserver.prototype._handle.call(this, ws, msg);
        }
    };
    const client = new API(ms.host, 'admin', 'secret', true, 'Hash', 1000);
    client.connect();
    await once(client, 'get_structure_file');
    const [, reason] = await once(client, 'close', 8000);
    assert.strictEqual(reason, 'keepalive timeout');
    client.abort();
    await ms.close();
});

test('the structure file is only loaded again when it changed', async () => {
    const ms = await new MockMiniserver().listen();
    const client = new API(ms.host, 'admin', 'secret', true, 'Hash', 30000);
    const loads = () => ms.received.filter((m) => m === 'data/LoxAPP3.json').length;
    client.connect();
    await once(client, 'get_structure_file');
    await wait(100);

    ms.dropAll();
    const [cached] = await once(client, 'get_structure_file', 5000);
    assert.strictEqual(loads(), 1);
    assert.strictEqual(cached.msInfo.serialNr, 'TEST');
    await wait(100);
    assert.strictEqual(ms.received.filter((m) => m === 'jdev/sps/enablebinstatusupdate').length, 2);

    ms.options.structure = Object.assign({}, ms.options.structure, {lastModified: '2026-02-02 00:00:00'});
    ms.dropAll();
    const [fresh] = await once(client, 'get_structure_file', 5000);
    assert.strictEqual(loads(), 2);
    assert.strictEqual(fresh.lastModified, '2026-02-02 00:00:00');

    client.abort();
    await ms.close();
});

test('per uuid events are only emitted when someone listens', async () => {
    const ms = await new MockMiniserver().listen();
    const client = new API(ms.host, 'admin', 'secret', true, 'Hash', 30000);
    const emitted = [];
    const emit = client.emit;
    client.emit = function (name) {
        emitted.push(name);
        return emit.apply(this, arguments);
    };
    client.connect();
    await once(client, 'get_structure_file');
    await wait(50);

    ms.sendValues([{uuid: UUID, value: 1}]);
    await once(client, 'update_event_value');
    assert.ok(!emitted.includes('update_event_value_' + UUID));

    const specific = once(client, 'update_event_value_' + UUID);
    ms.sendValues([{uuid: UUID, value: 2}]);
    assert.deepStrictEqual(await specific, [2]);

    client.abort();
    await ms.close();
});

// a miniserver behind a pulled cable: TCP is accepted (or not) but nothing ever answers
function silentServer(answerApi) {
    const sockets = new Set();
    const http = require('http');
    const server = answerApi
        ? http.createServer((req, res) => {
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({LL: {control: 'dev/cfg/api', value: "{'snr': 'TEST', 'version':'8.3.3.21'}", Code: '200'}}));
        })
        : net.createServer();
    // the websocket upgrade is accepted on TCP level but never answered
    server.on('upgrade', () => {});
    server.on('connection', (s) => {
        sockets.add(s);
        s.on('close', () => sockets.delete(s));
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
        host: '127.0.0.1:' + server.address().port,
        close: () => {
            for (const s of sockets) s.destroy();
            return new Promise((r) => server.close(r));
        },
    })));
}

test('a version check without answer fails after the connect timeout and retries', async () => {
    const srv = await silentServer(false);
    const client = new API(srv.host, 'admin', 'secret', true, 'Hash', 30000);
    client.connect_timeout = 300;
    const delays = [];
    client.on('reconnect', (delay) => delays.push(delay));
    const failed = once(client, 'connect_failed', 2000);
    client.connect();
    try {
        const [, reason] = await failed;
        assert.match(reason, /version check failed \(no answer within 300 ms\)/);
        await once(client, 'connect_failed', 3000);
        assert.ok(delays.length >= 2 && delays[1] > delays[0] * 1.2, 'delays grow: ' + delays);
    } finally {
        client.abort();
        await srv.close();
    }
});

test('a websocket handshake without answer fails after the connect timeout', async () => {
    const srv = await silentServer(true);
    const client = new API(srv.host, 'admin', 'secret', true, 'Hash', 30000);
    client.connect_timeout = 300;
    const failed = once(client, 'connect_failed', 2000);
    const reconnect = once(client, 'reconnect', 2000);
    const start = Date.now();
    client.connect();
    try {
        const [, reason] = await failed;
        assert.match(reason, /handshake has timed out/);
        assert.ok(Date.now() - start < 1500);
        await reconnect;
    } finally {
        client.abort();
        await srv.close();
    }
});

test('the version check does not keep an idle http connection open', async () => {
    const ms = await new MockMiniserver().listen();
    const client = new API(ms.host, 'admin', 'secret', true, 'Hash', 30000);
    client.connect();
    try {
        await once(client, 'get_structure_file');
        await wait(200);
        // only the websocket remains, no idle keep-alive socket of the http request
        const count = await new Promise((resolve, reject) => ms.server.getConnections((err, n) => err ? reject(err) : resolve(n)));
        assert.strictEqual(count, 1);
    } finally {
        client.abort();
        await ms.close();
    }
});
