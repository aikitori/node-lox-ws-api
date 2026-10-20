const WebSocket = require('ws');

const MessageHeader = require('./Message/Header.js');
const MessageText = require('./Message/Text.js');
const MessageFile = require('./Message/File.js');
const MessageEventValue = require('./Message/EventValue.js');
const MessageEventText = require('./Message/EventText.js');
const MessageEventDaytimer = require('./Message/EventDaytimer.js');
const MessageEventWeather = require('./Message/EventWeather.js');

/*
    Events:
        close            only after a successful connect, exactly once
        close_failed
        connect
        connect_failed   connection could not be opened
        connection_error error on an open connection, a close follows
        send
        message_header
        message_text
        message_file
        message_event_table_values
        message_event_table_text
        message_event_table_daytimer
        message_event_table_weather
        message_invalid
        keepalive
*/

// time to wait for the closing handshake before the socket is terminated
const CLOSE_TIMEOUT = 2000;

var Connection = function (host, keepalive) {
    this._host = host;
    this._keepalive = parseInt(keepalive === undefined ? 30000 : keepalive, 10) || 30000;
    this._keepalive_interval = undefined;
    this._keepalive_time = undefined;
    this._keepalive_response_time = undefined;
    this._timeout_interval = undefined;
    this._ws_url = 'ws://' + host + '/ws/rfc6455';
    this._ws = undefined;
    this._open = false;
    this._closed = false;
    this._connection_data = {};
};

Connection.prototype.__proto__ = require('events').EventEmitter.prototype;

Connection.prototype.connect = function () {
    var that = this;
    var ws = new WebSocket(this._ws_url, 'remotecontrol');
    this._ws = ws;

    ws.on('open', function () {
        that._open = true;
        that.register_connection();
        that.emit('connect');
    });

    ws.on('error', function (error) {
        var reason = error.message + ' (' + (error.code || 'unknown') + ')';
        if (that._open) {
            that.emit('connection_error', error, reason);
        } else if (!that._closed) {
            that._closed = true;
            that._stop_timers();
            that.emit('connect_failed', error, reason);
        }
    });

    ws.on('close', function (code, reason) {
        that._ws = undefined;
        that._stop_timers();
        if (!that._open || that._closed) {
            return;
        }
        that._closed = true;
        var text = (reason && reason.length ? reason.toString() : 'connection closed') + ' (' + code + ')';
        var out_of_service = !!(that._connection_data.last_header && that._connection_data.last_header.identifier == 5);
        that.emit('close', out_of_service, text);
    });

    ws.on('message', function (data, isBinary) {
        var message = isBinary
            ? {'type': 'binary', 'binaryData': data}
            : {'type': 'utf8', 'utf8Data': data.toString()};
        try {
            that.handle_message(message);
        } catch (error) {
            // a broken message or a failing listener must not kill the whole process
            that._connection_data.message_state = 'header';
            that.emit('connection_error', error, 'message handling failed: ' + error.message);
        }
    });
};

Connection.prototype.close = function () {
    var ws = this._ws;
    this._stop_timers();
    if (ws === undefined) {
        this.emit('close_failed');
        return;
    }
    if (ws.readyState === WebSocket.CONNECTING) {
        ws.terminate();
        return;
    }
    ws.close();
    // the miniserver does not always answer the closing handshake
    setTimeout(function () {
        if (ws.readyState !== WebSocket.CLOSED) {
            ws.terminate();
        }
    }, CLOSE_TIMEOUT).unref();
};

Connection.prototype._stop_timers = function () {
    clearInterval(this._keepalive_interval);
    clearInterval(this._timeout_interval);
    this._keepalive_interval = undefined;
    this._timeout_interval = undefined;
};

Connection.prototype.register_connection = function () {
    var that = this;
    this._connection_data = {
        'message_state': 'header',
        'status_update_subscription': false,
    };
    // count from the connect, otherwise a miniserver that never answers is never detected
    this._keepalive_time = Date.now();

    this._keepalive_interval = setInterval(function () {
        that._keepalive_response_time = Date.now();
        that.send('keepalive');
    }, this._keepalive);

    this._timeout_interval = setInterval(function () {
        if (Date.now() - that._keepalive_time > that._keepalive + 2000) {
            that._stop_timers();
            if (!that._closed) {
                that._closed = true;
                that.emit('close', true, 'keepalive timeout');
            }
        }
    }, 5000);
};

Connection.prototype.send = function (message) {
    if (this._ws !== undefined && this._ws.readyState === WebSocket.OPEN) {
        this._connection_data.last_request = message;
        this._ws.send(message);
        this.emit('send', message);
    }
};

Connection.prototype.handle_message = function (message) {
    var that = this;
    this.emit('handle_message', message);
    switch (this._connection_data.message_state) {
        case 'header':
            if (message.type !== 'binary') {
                this.emit('message_invalid', message);
                break;
            }
            this._connection_data.last_header = new MessageHeader(message.binaryData);
            this._connection_data.message_state = this._connection_data.last_header.next_state();
            if (this._connection_data.last_header.identifier == 6){
                that._keepalive_time = Date.now();
                if (this._keepalive_response_time !== undefined) {
                    this.emit('keepalive', that._keepalive_time - this._keepalive_response_time);
                }
            }
            this.emit('message_header', this._connection_data.last_header);
            break;
        case 'text':
            if (message.type === 'binary') {
                this.emit('message_invalid', message);
                break;
            }
            this.emit('message_text', new MessageText(message.utf8Data));
            this._connection_data.message_state = 'header';
            break;
        case 'binary_file':
            this.emit('message_file', new MessageFile(message, that._connection_data.last_request));
            this._connection_data.message_state = 'header';
            break;
        case 'etable_values':
            if (message.type !== 'binary') {
                this.emit('message_invalid', message);
                break;
            }
            var event_table = [];
            var buffer_index = 0;
            while (buffer_index < message.binaryData.length) {
                var event_item = new MessageEventValue(message.binaryData, buffer_index);
                event_table.push(event_item);
                buffer_index += event_item.data_length;
            }
            this.emit('message_event_table_values', event_table);
            this._connection_data.message_state = 'header';
            break;
        case 'etable_text':
            if (message.type !== 'binary') {
                this.emit('message_invalid', message);
                break;
            }
            var event_table = [];
            var buffer_index = 0;
            while (buffer_index < message.binaryData.length) {
                var event_item = new MessageEventText(message.binaryData, buffer_index);
                event_table.push(event_item);
                buffer_index += event_item.data_length;
            }
            this.emit('message_event_table_text', event_table);
            this._connection_data.message_state = 'header';
            break;
        case 'etable_daytimer':
            if (message.type !== 'binary') {
                this.emit('message_invalid', message);
                break;
            }
            var event_table = [];
            var buffer_index = 0;
            while (buffer_index < message.binaryData.length) {
                var event_item = new MessageEventDaytimer(message.binaryData, buffer_index);
                event_table.push(event_item);
                buffer_index += event_item.data_length;
            }
            this.emit('message_event_table_daytimer', event_table);
            this._connection_data.message_state = 'header';
            break;
        case 'etable_weather':
            if (message.type !== 'binary') {
                this.emit('message_invalid', message);
                break;
            }
            var event_table = [];
            var buffer_index = 0;
            while (buffer_index < message.binaryData.length) {
                var event_item = new MessageEventWeather(message.binaryData, buffer_index);
                event_table.push(event_item);
                buffer_index += event_item.data_length;
            }
            this.emit('message_event_table_weather', event_table);
            this._connection_data.message_state = 'header';
            break;
        default:
            this.emit('unknown_message_state', message);
            this._connection_data.message_state = 'header';
    }
};

module.exports = Connection;
