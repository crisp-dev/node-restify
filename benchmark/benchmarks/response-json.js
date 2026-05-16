'use strict';

var restify = process.argv.includes('version=head')
    ? require('../../lib')
    : require('restify');

var engine = process.env.RESTIFY_ENGINE;
var server = restify.createServer(engine ? { engine: engine } : {});
var path = '/';
var port = 3000;

module.exports = {
    url: 'http://localhost:' + port + path
};

server.get(path, function onRequest(req, res, next) {
    res.send({ hello: 'world' });
    return next();
});

if (!module.parent) {
    server.listen(port);
}
