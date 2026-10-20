# node-lox-ws-api
Web Socket Loxone™ API for Node JS

## Connection and reconnect

- WebSocket via [`ws`](https://github.com/websockets/ws), Node.js 14 or newer.
- After a connection loss the client reconnects with a growing delay: 1 s, 2 s, 4 s … up to 30 s,
  each with ±25 % jitter. The delay starts at 1 s again after a successful login.
- `close` is emitted exactly once per connection that was open before. Failed attempts emit
  `connect_failed`, `reconnect` passes the delay in ms.
- `abort()` closes the connection, cancels pending reconnects and emits `abort`.
- If the Miniserver stops answering keepalives, the connection ends with `close` (`keepalive timeout`).

## Tests

`npm test` runs the tests against a mocked Miniserver (`test/mock-miniserver.js`).
