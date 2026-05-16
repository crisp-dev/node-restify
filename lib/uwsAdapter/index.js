'use strict';

/*
 * Restify uWebSockets.js adapter — entry point.
 *
 * This module exposes a `createServer()` factory that returns an object
 * conforming to the subset of `http.Server` semantics used by `lib/server.js`,
 * plus the `UwsRequest` / `UwsResponse` classes so that the prototype patches
 * in `lib/request.js` and `lib/response.js` can be applied to them.
 *
 * Loading `uWebSockets.js` itself is deferred until `createServer()` is
 * called, so requiring this module is safe even on platforms where the uws
 * binary is missing.
 */

var UwsServer = require('./server');
var UwsRequest = require('./request');
var UwsResponse = require('./response');

/**
 * Factory matching the contract of `http.createServer()` as used by restify.
 *
 * @public
 * @function createServer
 * @param {Object} [options] - adapter options
 * @returns {UwsServer} server instance
 */
function createServer(options) {
    return new UwsServer(options);
}

module.exports = {
    createServer: createServer,
    UwsServer: UwsServer,
    UwsRequest: UwsRequest,
    UwsResponse: UwsResponse
};
