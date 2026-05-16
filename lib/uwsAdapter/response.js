'use strict';

/*
 * UwsResponse — wraps uWebSockets.js HttpResponse to look like a Node
 * http.ServerResponse.
 *
 * Critical constraints from uws:
 *  - All writes MUST happen inside `uRes.cork(() => {...})` for perf.
 *  - `onAborted` MUST be registered before any async work, otherwise uws will
 *    crash if the client disconnects.
 *  - `writeStatus` / `writeHeader` MUST be called before any `write` / `end`.
 *  - After `end`, `endWithoutBody`, or onAborted firing, the underlying
 *    HttpResponse handle is invalid.
 *
 * Strategy for the POC:
 *  - Buffer all body chunks in `_write` (no syscalls per chunk).
 *  - On `_final`, cork once and call `uRes.end(concatenatedBody)` so uws can
 *    auto-set Content-Length and emit a clean HTTP/1.1 response.
 *  - This is optimal for small JSON responses (restify's main use case) and
 *    avoids fighting backpressure in the POC. Streaming-heavy plugins (gzip,
 *    static) are documented as hors-scope.
 */

var Writable = require('stream').Writable;
var http = require('http');
var util = require('util');

var STATUS_CODES = http.STATUS_CODES;

/**
 * @public
 * @class
 * @param {Object} uRes - uws HttpResponse for this request
 * @param {UwsRequest} wrapReq - paired UwsRequest (for aborted propagation)
 */
function UwsResponse(uRes, wrapReq) {
    Writable.call(this, { highWaterMark: 64 * 1024 });

    this._uwsRes = uRes;
    this._wrapReq = wrapReq;
    this._aborted = false;
    this._ended = false;
    this._chunks = [];
    this._chunksLen = 0;

    this.statusCode = 200;
    this.statusMessage = undefined;
    this.headersSent = false;
    this.finished = false;
    this.sendDate = true;

    // Header storage. Keys preserved as-given; lookup is case-insensitive via
    // a parallel lowercased index for getHeader/removeHeader/hasHeader.
    this._headers = {};
    this._headersLc = {};

    var self = this;

    // MANDATORY abort handler. Without this, uws throws as soon as we attempt
    // to write asynchronously, and crashes the process if the client closes
    // the connection while a handler is pending.
    uRes.onAborted(function onAborted() {
        self._aborted = true;
        self.finished = true;

        if (wrapReq) {
            wrapReq._handleAborted();
        }

        // Tear down the writable stream. Don't propagate as an 'error' event:
        // aborted responses are a normal lifecycle event for the framework.
        self.emit('close');

        // Destroying the stream after we marked _aborted prevents _final from
        // attempting to touch the dead uws handle.
        if (typeof self.destroy === 'function') {
            self.destroy();
        }
    });

    // 'close' on the writable will be emitted by Node anyway when destroyed.
    // We always emit 'finish' from _final ourselves.
}
util.inherits(UwsResponse, Writable);

///--- Header API (compatible with http.ServerResponse)

/**
 * @public
 * @memberof UwsResponse
 * @instance
 * @function setHeader
 * @param {String} name - header name
 * @param {String|Array<String>|Number} value - header value
 * @returns {UwsResponse} self
 */
UwsResponse.prototype.setHeader = function setHeader(name, value) {
    var lc = String(name).toLowerCase();
    this._headers[name] = value;
    this._headersLc[lc] = name;
    return this;
};

UwsResponse.prototype.getHeader = function getHeader(name) {
    var lc = String(name).toLowerCase();
    var key = this._headersLc[lc];
    return key ? this._headers[key] : undefined;
};

UwsResponse.prototype.hasHeader = function hasHeader(name) {
    var lc = String(name).toLowerCase();
    return Object.prototype.hasOwnProperty.call(this._headersLc, lc);
};

UwsResponse.prototype.removeHeader = function removeHeader(name) {
    var lc = String(name).toLowerCase();
    var key = this._headersLc[lc];

    if (key) {
        delete this._headers[key];
        delete this._headersLc[lc];
    }
};

UwsResponse.prototype.getHeaders = function getHeaders() {
    var out = {};
    var keys = Object.keys(this._headers);
    var i;

    for (i = 0; i < keys.length; i++) {
        out[keys[i].toLowerCase()] = this._headers[keys[i]];
    }

    return out;
};

UwsResponse.prototype.getHeaderNames = function getHeaderNames() {
    return Object.keys(this._headersLc);
};

/**
 * Node-compatible writeHead. Signatures:
 *   writeHead(statusCode)
 *   writeHead(statusCode, statusMessage)
 *   writeHead(statusCode, headers)
 *   writeHead(statusCode, statusMessage, headers)
 *
 * This does NOT actually flush to the wire — uws buffers writes until cork
 * exits, so we just memorize the status and merge any headers.
 *
 * @public
 * @memberof UwsResponse
 * @instance
 * @param {Number} statusCode - HTTP status code
 * @param {String|Object} [arg2] - status message string or headers object
 * @param {Object} [arg3] - headers object (when arg2 is a status message)
 * @returns {UwsResponse} self
 */
UwsResponse.prototype.writeHead = function writeHead(statusCode, arg2, arg3) {
    this.statusCode = statusCode;

    var headers;

    if (typeof arg2 === 'string') {
        this.statusMessage = arg2;
        headers = arg3;
    } else {
        headers = arg2;
    }

    if (headers && typeof headers === 'object') {
        if (Array.isArray(headers)) {
            // [k, v, k, v, ...] form
            var i;

            for (i = 0; i < headers.length; i += 2) {
                this.setHeader(headers[i], headers[i + 1]);
            }
        } else {
            var keys = Object.keys(headers);
            var j;

            for (j = 0; j < keys.length; j++) {
                this.setHeader(keys[j], headers[keys[j]]);
            }
        }
    }

    return this;
};

UwsResponse.prototype.flushHeaders = function flushHeaders() {
    // Nothing to do — headers are flushed when the body is sent.
};

///--- Writable internals

/**
 * Convert any incoming chunk into a Buffer suitable for uws.
 *
 * @private
 * @param {Buffer|String} chunk - chunk
 * @param {String} encoding - encoding
 * @returns {Buffer} buffer
 */
function toBuffer(chunk, encoding) {
    if (Buffer.isBuffer(chunk)) {
        return chunk;
    }

    if (typeof chunk === 'string') {
        return Buffer.from(chunk, encoding || 'utf8');
    }

    return Buffer.from(chunk);
}

UwsResponse.prototype._write = function _write(chunk, encoding, cb) {
    if (this._aborted) {
        cb();
        return;
    }

    var buf = toBuffer(chunk, encoding);
    this._chunks.push(buf);
    this._chunksLen += buf.length;
    cb();
};

UwsResponse.prototype._writev = function _writev(chunks, cb) {
    if (this._aborted) {
        cb();
        return;
    }

    var i;

    for (i = 0; i < chunks.length; i++) {
        var entry = chunks[i];
        var buf = toBuffer(entry.chunk, entry.encoding);
        this._chunks.push(buf);
        this._chunksLen += buf.length;
    }

    cb();
};

UwsResponse.prototype._final = function _final(cb) {
    if (this._aborted) {
        this.finished = true;
        cb();
        return;
    }

    var body =
        this._chunksLen === 0
            ? null
            : this._chunks.length === 1
            ? this._chunks[0]
            : Buffer.concat(this._chunks, this._chunksLen);

    this._chunks = null;

    var self = this;
    var uRes = this._uwsRes;

    uRes.cork(function flush() {
        self._writeStatusAndHeaders();

        if (body && body.length > 0) {
            uRes.end(body);
        } else {
            uRes.end();
        }

        self.headersSent = true;
        self.finished = true;
    });

    cb();
};

UwsResponse.prototype._writeStatusAndHeaders = function _flush() {
    if (this.headersSent) {
        return;
    }

    var uRes = this._uwsRes;
    var statusLine =
        this.statusCode +
        ' ' +
        (this.statusMessage || STATUS_CODES[this.statusCode] || 'OK');

    uRes.writeStatus(statusLine);

    var keys = Object.keys(this._headers);
    var i;

    for (i = 0; i < keys.length; i++) {
        var key = keys[i];
        var value = this._headers[key];

        if (Array.isArray(value)) {
            // Emit one header line per array element (eg. Set-Cookie).
            var j;

            for (j = 0; j < value.length; j++) {
                uRes.writeHeader(key, String(value[j]));
            }
        } else if (value !== undefined && value !== null) {
            uRes.writeHeader(key, String(value));
        }
    }

    this.headersSent = true;
};

/**
 * @public
 * @memberof UwsResponse
 * @instance
 * @function writeContinue
 * @returns {undefined} no return value
 */
UwsResponse.prototype.writeContinue = function writeContinue() {
    // 100-continue is not supported in the POC.
};

UwsResponse.prototype.addTrailers = function addTrailers() {
    // Trailers are not supported in the POC.
};

module.exports = UwsResponse;
