const crypto = require('crypto');
const Connection = require('./Connection.js');
const http = require('http');

/*
    Events:
        auth_failed
        authorized
        close
        close_failed
        connect
        connect_failed
        connection_error
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
        get_structure_file
        update_event
*/

// reconnect delay: starts small, doubles on every failed attempt (+-25 % jitter), reset after a successful login
const RECONNECT_DELAY_MIN = 1000;
const RECONNECT_DELAY_MAX = 30000;

var API = function (host, username, password, reconnect, security, keepalive) {
    this._host = host;
    this._username = username;
    this._password = password;
    this._reconnect = reconnect;
    this._reconnect_timeout = undefined;
    this._reconnect_delay = RECONNECT_DELAY_MIN;
    this._keepalive = (keepalive === undefined ? 30000 : keepalive);
    this._abort = false;
    this.command_chain = [];
    this.file_chain = [];
    this._auth_class = require('./Auth/'+(security === undefined ? 'Hash' : security)+'.js');
    this._auth = undefined;
    this.connection = undefined;
};

API.prototype.__proto__ = require('events').EventEmitter.prototype;

API.prototype.connect = function() {
    this._abort = false;
    if (this.connection !== undefined) {
        this.emit('already_connected');
        return;
    }
    var connection = new Connection(this._host, this._keepalive);
    this.register_connection(connection);
    this.perform_version_check(connection);
};

API.prototype.close = function() {
    if (this.connection !== undefined){
        this.connection.close();
    }else{
        this.emit('close_failed');
    }
};

API.prototype.abort = function() {
    clearTimeout(this._reconnect_timeout);
    this._reconnect_timeout = undefined;
    this._abort = true;
    if (this.connection !== undefined) {
        this._connection_lost(this.connection, false, 'aborted', true);
    } else {
        this.emit('abort');
    }
};

API.prototype.is_connected = function() {
    return this.connection !== undefined;
};

API.prototype.register_connection = function(connection) {
    var that = this;
    if (this.connection !== undefined){
        that.emit('already_connected');
        return;
    }

    this.connection = connection;

    // every way a connection can end leads to exactly one _connection_lost call
    this.connection.on('close', function(info, reason) {
        that._connection_lost(connection, info, reason, true);
    });

    this.connection.on('connect_failed', function(error, reason) {
        that.emit('connect_failed', error, reason);
        that._connection_lost(connection, false, reason, false);
    });

    this.connection.on('close_failed', function() {
        that.emit('close_failed');
    });

    this.connection.on('connect', function() {
        that.emit('connect');
        that._status_update_subscription = false;
        that.register_auth_object();
        that._auth.authorize();
    });

    this.connection.on('connection_error', function(error, reason) {
        that.emit('connection_error', error, reason);
    });

    this.connection.on('send', function(message) {
        that.emit('send', message);
    });

    this.connection.on('handle_message', function(message) {
        that.emit('handle_message', message);
    });

    this.connection.on('message_header', function(message) {
        that.emit('message_header', message);
    });

    this.connection.on('message_text', function(message) {
        that._message_text(message);
        that.emit('message_text', message);
    });

    this.connection.on('message_file', function(message) {
        that._message_file(message);
        that.emit('message_file', message);
    });

    this.connection.on('message_event_table_values', function(messages) {
        messages.forEach(function(evt){
            that.emit('update_event_value', evt.uuid.string, evt.value);
            that.emit('update_event_value_' + evt.uuid.string, evt.value);
        });
        that.emit('message_event_table_values', messages);
    });

    this.connection.on('message_event_table_text', function(messages) {
        messages.forEach(function(evt){
            that.emit('update_event_text', evt.uuid.string, evt.text);
            that.emit('update_event_text_' + evt.uuid.string, evt.value);
        });
        that.emit('message_event_table_text', messages);
    });

    this.connection.on('message_event_table_daytimer', function(messages) {
        messages.forEach(function(evt){
            that.emit('update_event_daytimer', evt.uuid.string, evt);
            that.emit('update_event_daytimer_' + evt.uuid.string, evt.value);
        });
        that.emit('message_event_table_daytimer', messages);
    });

    this.connection.on('message_event_table_weather', function(messages) {
        messages.forEach(function(evt){
            that.emit('update_event_weather', evt.uuid.string, evt);
            that.emit('update_event_weather_' + evt.uuid.string, evt.value);
        });
        that.emit('message_event_table_weather', messages);
    });

    this.connection.on('message_invalid', function(message) {
        that.emit('message_invalid', message);
    });

    this.connection.on('keepalive', function(time) {
        that.emit('keepalive', time);
    });
};

API.prototype._connection_lost = function(connection, info, reason, was_connected) {
    if (connection !== this.connection) {
        // late event of a connection that was already replaced
        return;
    }
    this.connection.removeAllListeners();
    this.connection.close();
    this.connection = undefined;
    if (this._auth !== undefined && typeof this._auth.stop === 'function') {
        this._auth.stop();
    }
    this.clear_auth_chain();
    this._status_update_subscription = false;

    if (was_connected || this._abort) {
        this.emit('close', info, reason);
    }
    if (this._abort) {
        this.emit('abort');
        return;
    }
    this._schedule_reconnect();
};

API.prototype._schedule_reconnect = function() {
    var that = this;
    if (!this._reconnect || this._reconnect_timeout !== undefined) {
        return;
    }
    // jitter, so many clients do not all hit a rebooting miniserver at the same moment
    var delay = Math.round(this._reconnect_delay * (0.75 + Math.random() * 0.5));
    this._reconnect_delay = Math.min(this._reconnect_delay * 2, RECONNECT_DELAY_MAX);
    this.emit('reconnect', delay);
    this._reconnect_timeout = setTimeout(function(){
        that._reconnect_timeout = undefined;
        if (!that._abort && that.connection === undefined){
            that.connect();
        }
    }, delay);
};

API.prototype.reconnect = function() {
    if (this.connection !== undefined) {
        this._connection_lost(this.connection, false, 'reconnecting', true);
    } else if (!this._abort) {
        this._schedule_reconnect();
    }
};

API.prototype.send_control_command = function(control, command) {
    this.connection.send(this._auth.prepare_control_command(control, command));
};

API.prototype.send_command = function(command, secure) {
    secure = typeof secure !== 'undefined' ? secure : true;
    if (secure){
        this.connection.send(this._auth.prepare_secure_command(command));
    }else{
        this.connection.send(command);
    }
};

API.prototype.send_cmd = function(uuidAction, command) {
    this.send_control_command(uuidAction, command);
};

API.prototype._message_text = function(message) {
    for (var index = this.command_chain.length - 1; index >= 0; index--) {
        var item = this.command_chain[index];
        if (item.control.test(message.control)){
            item.callback(message);
            if (item.onetime) {
                this.command_chain.splice(index, 1);
            }
            break;
        }
    }
};

API.prototype._message_file = function(message) {
    for (var index = this.file_chain.length - 1; index >= 0; index--) {
        var item = this.file_chain[index];
        if (item.file.test(message.filename)){
            item.callback(message);
            if (item.onetime) {
                this.file_chain.splice(index, 1);
            }
            break;
        }
    }
};

API.prototype.clear_auth_chain = function() {
    this.command_chain = [];
    this.file_chain = [];
    this._auth = undefined;
};

API.prototype.register_auth_object = function() {
    var that = this;

    this._auth = new (this._auth_class)(this._host, this._username, this._password, this.connection, this);

    this._auth.on('auth_failed', function(loxone_message) {
        that.emit('auth_failed', loxone_message);
    });

    this._auth.on('authorized', function() {
        that._reconnect_delay = RECONNECT_DELAY_MIN;
        that.emit('authorized');
        that.register_LoxAPPVersion_response();
        that.send_command('jdev/sps/LoxAPPversion3');
    });

    this._auth.on('message_text', function(loxone_message) {
        that._message_text(loxone_message);
        that.emit('message_text', loxone_message);
    });
};

API.prototype.register_LoxAPPVersion_response = function() {
    var that = this;
    this.command_chain.push({
        'control': /^j?dev\/sps\/LoxAPPversion3$/,
        'callback': function(loxone_message) {
            that.register_LoxAPP3json_response();
            that.send_command('data/LoxAPP3.json', false);
        },
        'onetime': true,
    });
};

API.prototype.register_LoxAPP3json_response = function() {
    var that = this;
    this.file_chain.push({
        'file': /^data\/LoxAPP3.json/,
        'callback': function(loxone_file) {
            that.emit('get_structure_file', loxone_file.data);
            if (!that._status_update_subscription) {
                that._status_update_subscription = true;
                that.register_enablestatusupdate_response();
                that.send_command('jdev/sps/enablebinstatusupdate');
            }
        },
        'onetime': true,
    });
};

API.prototype.register_enablestatusupdate_response = function() {
};

API.prototype.perform_version_check = function(connection) {
    var that = this;
    var failed = function(reason) {
        that.emit('connect_failed', null, reason);
        that._connection_lost(connection, false, reason, false);
    };

    http.get('http://'+this._host+'/jdev/cfg/api', (res) => {
        var body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
            body += chunk;
        });
        res.on('end', () => {
            if (connection !== that.connection || that._abort) {
                return;
            }
            if (res.statusCode !== 200) {
                return failed('version check failed (HTTP ' + res.statusCode + ')');
            }
            try {
                var json = JSON.parse(body);
                var api = JSON.parse(json.LL.value.replace(/'/g,'"'));
                var version = api.version.split(".");
                if (parseInt(version[0], 10) >= 9){
                    that._auth_class = require('./Auth/Token-Enc.js');
                }
            } catch (e) {
                return failed('version check failed (' + e.message + ')');
            }
            connection.connect();
        });
    }).on('error', (e) => {
        if (connection === that.connection) {
            failed('version check failed (' + e.message + ')');
        }
    });
};

module.exports = API;
