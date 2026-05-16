'use strict';

/*
 * UwsRequest — wraps uWebSockets.js HttpRequest/HttpResponse pair to look like
 * a Node http.IncomingMessage.
 *
 * Critical constraint: `uReq` (uws.HttpRequest) is stack-allocated and is only
 * valid during the synchronous portion of the route handler. We MUST copy
 * method, URL, query and ALL headers in the constructor — touching `uReq`
 * later will segfault or read garbage.
 *
 * The request body arrives via `uRes.onData(chunk, isLast)`. We forward those
 * chunks to the Readable stream via push().
 */

var Readable = require('stream').Readable;
var util = require('util');

// Decoder for ArrayBuffer -> string (for remote address text).
var TextDecoder = global.TextDecoder || require('util').TextDecoder;
var asciiDecoder = new TextDecoder('utf-8');

/**
 * Build a fake `socket` / `connection` object compatible with the surface
 * of net.Socket that most Node HTTP middlewares care about (remoteAddress,
 * remotePort, encrypted, destroyed).
 *
 * @private
 * @param {Object} uRes - uws HttpResponse
 * @returns {Object} fake socket
 */
function makeFakeSocket(uRes) {
    var remoteAddress = '';
    var remotePort = 0;

    try {
        var rawAddr = uRes.getRemoteAddressAsText();

        if (rawAddr && rawAddr.byteLength > 0) {
            remoteAddress = asciiDecoder.decode(rawAddr);
        }
    } catch (e) {
        // best-effort: leave empty
    }

    try {
        remotePort = uRes.getRemotePort ? uRes.getRemotePort() : 0;
    } catch (e) {
        remotePort = 0;
    }

    return {
        remoteAddress: remoteAddress,
        remotePort: remotePort,
        localAddress: '',
        localPort: 0,
        encrypted: false,
        destroyed: false,
        readable: true,
        writable: true,
        setTimeout: function setTimeout() {},
        setNoDelay: function setNoDelay() {},
        setKeepAlive: function setKeepAlive() {},
        unref: function unref() {},
        ref: function ref() {}
    };
}

/**
 * @public
 * @class
 * @param {Object} uRes - uws.HttpResponse for this request
 * @param {Object} uReq - uws.HttpRequest (only valid synchronously)
 */
function UwsRequest(uRes, uReq) {
    Readable.call(this, { highWaterMark: 64 * 1024 });

    // --- Synchronous capture (uReq becomes invalid after this constructor) ---

    // uws returns the lowercased method via getMethod(); for parity with Node
    // we want uppercase.
    var method;

    if (typeof uReq.getCaseSensitiveMethod === 'function') {
        method = uReq.getCaseSensitiveMethod();
    } else {
        method = uReq.getMethod();
    }

    this.method = (method || 'GET').toUpperCase();

    var url = uReq.getUrl();
    var query = uReq.getQuery();
    this.url = query ? url + '?' + query : url;
    this.originalUrl = this.url;

    var headers = {};
    var rawHeaders = [];
    uReq.forEach(function eachHeader(key, value) {
        headers[key] = value;
        rawHeaders.push(key, value);
    });
    this.headers = headers;
    this.rawHeaders = rawHeaders;
    this.trailers = {};
    this.rawTrailers = [];

    this.httpVersion = '1.1';
    this.httpVersionMajor = 1;
    this.httpVersionMinor = 1;
    this.complete = false;
    this.aborted = false;

    var socket = makeFakeSocket(uRes);
    this.socket = socket;
    this.connection = socket;

    // --- uws lifecycle wiring ---

    this._uwsRes = uRes;
    this._response = null; // set by UwsServer once UwsResponse is built
    this._bodyEnded = false;
    this._readStarted = false;

    var self = this;

    // Pull request body chunks. uws neuters the ArrayBuffer after the callback
    // returns unless isLast is true, so we always copy defensively.
    uRes.onData(function onBodyChunk(chunk, isLast) {
        if (self.aborted) {
            return;
        }

        if (chunk && chunk.byteLength > 0) {
            // Copy (slice() on ArrayBuffer returns a new ArrayBuffer).
            var copy = Buffer.from(chunk.slice(0));
            self.push(copy);
        }

        if (isLast) {
            self._bodyEnded = true;
            self.complete = true;
            self.push(null);
        }
    });
}
util.inherits(UwsRequest, Readable);

/**
 * Readable internal — uws pushes synchronously via onData, so _read is a no-op.
 *
 * @private
 * @returns {undefined} no return value
 */
UwsRequest.prototype._read = function _read() {
    // no-op
};

/**
 * Called by UwsResponse.onAborted to mark this request as aborted and tear
 * down the readable stream.
 *
 * @private
 * @returns {undefined} no return value
 */
UwsRequest.prototype._handleAborted = function _handleAborted() {
    if (this.aborted) {
        return;
    }

    this.aborted = true;
    this.complete = false;

    if (this.socket) {
        this.socket.destroyed = true;
        this.socket.readable = false;
        this.socket.writable = false;
    }

    this.emit('aborted');
    this.emit('close');

    if (!this._bodyEnded) {
        this.push(null);
    }
};

module.exports = UwsRequest;
