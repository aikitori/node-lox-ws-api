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
- A connect attempt (version check and WebSocket handshake) fails after 10 s without answer, e.g. while
  the Miniserver reboots or is unplugged. Without this limit an attempt hung about 2 minutes.
  The limit can be changed with `client.connect_timeout = ms` before `connect()`.
- The HTTP version check closes its socket right after the answer, so only the WebSocket stays open.

## Performance

- The structure file (`LoxAPP3.json`) is kept in memory and only downloaded again after a reconnect when
  `LoxAPPversion3` reports a different date.
- Events per uuid (`update_event_value_<uuid>` etc.) are only emitted once a listener for such an event has
  been added. `update_event_value`, `update_event_text`, … are always emitted.

## Tests

`npm test` runs the tests against a mocked Miniserver (`test/mock-miniserver.js`).
