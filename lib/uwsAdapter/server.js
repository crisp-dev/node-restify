'use strict';

/*
 * Restify uWebSockets.js adapter — POC.
 *
 * UwsServer mimics a Node `http.Server` (EventEmitter with listen/close/address)
 * so that `lib/server.js` can wire it the same way as `http.createServer()`.
 *
 * Hors-scope (POC):
 *  - HTTP/2 (uws.SSLApp gere h2 mais API differente)
 *  - upgrade / WebSocket events (uws has its own ws API)
 *  - checkContinue, clientError, trailers
 *  - HTTPS via cert/key restify natif (faisable via uws.SSLApp mais hors POC)
 */

var EventEmitter = require('events').EventEmitter;
var util = require('util');

var UwsRequest = require('./request');
var UwsResponse = require('./response');

var uws;

function loadUws() {
    if (uws) {
        return uws;
    }

    try {
        // eslint-disable-next-line global-require
        uws = require('uWebSockets.js');
    } catch (err) {
        var wrapped = new Error(
            'restify engine "uws" requires the optional dependency ' +
                '"uWebSockets.js" to be installed. Original error: ' +
                err.message
        );
        wrapped.cause = err;
        throw wrapped;
    }

    return uws;
}

/**
 * UwsServer wraps a uWebSockets.js TemplatedApp behind a Node http.Server-like
 * interface (EventEmitter + listen/close/address).
 *
 * @public
 * @class
 * @param {Object} [options] - adapter options (reserved for future use)
 */
function UwsServer(options) {
    EventEmitter.call(this);

    this._opts = options || {};
    this._uws = loadUws();
    this._app = this._uws.App();
    this._listenToken = null;
    this._listening = false;
    this._addr = null;
    this.maxHeadersCount = null;

    var self = this;

    // Catch-all route. find-my-way in restify takes care of method/path matching
    // downstream, so we forward EVERYTHING through a single uws handler.
    this._app.any('/*', function onRequest(uRes, uReq) {
        var wrapReq = new UwsRequest(uRes, uReq);
        var wrapRes = new UwsResponse(uRes, wrapReq);

        // Re-pair so the request can mark itself complete/aborted from the
        // response's lifecycle hooks.
        wrapReq._response = wrapRes;

        self.emit('request', wrapReq, wrapRes);
    });
}
util.inherits(UwsServer, EventEmitter);

/**
 * Mimics http.Server#listen. Supported signatures:
 *   listen(port)
 *   listen(port, cb)
 *   listen(port, host)
 *   listen(port, host, cb)
 *   listen({ port, host })
 *   listen({ port, host }, cb)
 *
 * @public
 * @memberof UwsServer
 * @instance
 * @returns {UwsServer} self
 */
UwsServer.prototype.listen = function listen() {
    var args = Array.prototype.slice.call(arguments);
    var port = 0;
    var host = '0.0.0.0';
    var cb = null;
    var i;

    for (i = 0; i < args.length; i++) {
        var arg = args[i];

        if (typeof arg === 'function') {
            cb = arg;
        } else if (typeof arg === 'number') {
            port = arg;
        } else if (typeof arg === 'string') {
            // Could be host or a numeric port string.
            var asNum = Number(arg);

            if (!Number.isNaN(asNum) && i === 0) {
                port = asNum;
            } else {
                host = arg;
            }
        } else if (arg && typeof arg === 'object') {
            if (typeof arg.port === 'number') {
                port = arg.port;
            }

            if (typeof arg.host === 'string') {
                host = arg.host;
            }
        }
    }

    var self = this;

    this._app.listen(host, port, function onListen(token) {
        if (!token) {
            var err = new Error(
                'uws: failed to listen on ' + host + ':' + port
            );
            self.emit('error', err);

            if (cb) {
                cb(err);
            }

            return;
        }

        self._listenToken = token;
        self._listening = true;
        self._addr = {
            address: host,
            port: port,
            family: host.indexOf(':') !== -1 ? 'IPv6' : 'IPv4'
        };
        self.emit('listening');

        if (cb) {
            cb();
        }
    });

    return this;
};

/**
 * Mimics http.Server#close. Stops accepting new connections; existing
 * connections are NOT forcefully closed (matches Node semantics roughly).
 *
 * @public
 * @memberof UwsServer
 * @instance
 * @param {Function} [cb] - called once the listen socket is closed
 * @returns {UwsServer} self
 */
UwsServer.prototype.close = function close(cb) {
    var self = this;

    if (this._listenToken) {
        this._uws.us_listen_socket_close(this._listenToken);
        this._listenToken = null;
    }

    this._listening = false;

    process.nextTick(function emitClose() {
        self.emit('close');

        if (cb) {
            cb();
        }
    });

    return this;
};

/**
 * Mimics http.Server#address.
 *
 * @public
 * @memberof UwsServer
 * @instance
 * @returns {Object|null} {address, port, family}
 */
UwsServer.prototype.address = function address() {
    return this._addr;
};

UwsServer.prototype.ref = function ref() {
    return this;
};

UwsServer.prototype.unref = function unref() {
    return this;
};

module.exports = UwsServer;
