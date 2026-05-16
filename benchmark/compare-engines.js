#!/usr/bin/env node
'use strict';

/*
 * compare-engines.js — POC benchmark harness for the uWebSockets.js adapter.
 *
 * Spawns each benchmark scenario twice (engine=http and engine=uws), runs
 * autocannon against it, and prints a side-by-side throughput table.
 *
 * Usage:
 *   node benchmark/compare-engines.js                   # all scenarios, defaults
 *   node benchmark/compare-engines.js response-json     # single scenario
 *   DURATION=10 CONNECTIONS=200 PIPELINING=10 \
 *     node benchmark/compare-engines.js
 */

var path = require('path');
var spawn = require('child_process').spawn;
var autocannon = require('autocannon');

var DEFAULT_SCENARIOS = [
    'response-json',
    'response-text',
    'router-heavy',
    'middleware'
];

var DURATION = parseInt(process.env.DURATION, 10) || 10;
var CONNECTIONS = parseInt(process.env.CONNECTIONS, 10) || 100;
var PIPELINING = parseInt(process.env.PIPELINING, 10) || 10;
var WARMUP_MS = 500;

var requested = process.argv.slice(2).filter(function filter(a) {
    return !a.startsWith('-');
});
var scenarios = requested.length > 0 ? requested : DEFAULT_SCENARIOS;

function startServer(scenario, engine) {
    return new Promise(function exec(resolve, reject) {
        var script = path.join(__dirname, 'benchmarks', scenario + '.js');
        var env = Object.assign({}, process.env);

        if (engine) {
            env.RESTIFY_ENGINE = engine;
        } else {
            delete env.RESTIFY_ENGINE;
        }

        var child = spawn(process.execPath, [script, 'version=head'], {
            env: env,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        var settled = false;
        var stderr = '';

        child.stderr.on('data', function onErr(buf) {
            stderr += buf.toString();
        });

        child.on('exit', function onExit(code) {
            if (!settled) {
                settled = true;
                reject(
                    new Error(
                        'server exited early (code ' + code + '): ' + stderr
                    )
                );
            }
        });

        setTimeout(function ready() {
            if (settled) {
                return;
            }

            settled = true;
            resolve(child);
        }, WARMUP_MS);
    });
}

function stopServer(child) {
    return new Promise(function exec(resolve) {
        if (!child || child.killed) {
            resolve();
            return;
        }

        child.once('exit', function onExit() {
            resolve();
        });
        child.kill('SIGKILL');
    });
}

function runBench(url) {
    return new Promise(function exec(resolve, reject) {
        autocannon(
            {
                url: url,
                connections: CONNECTIONS,
                pipelining: PIPELINING,
                duration: DURATION
            },
            function done(err, result) {
                if (err) {
                    reject(err);
                    return;
                }

                resolve(result);
            }
        );
    });
}

function summarize(result) {
    return {
        reqAvg: result.requests.average,
        reqStdev: result.requests.stddev,
        latencyP50: result.latency.p50,
        latencyP99: result.latency.p99,
        throughputAvg: result.throughput.average,
        errors: result.errors,
        timeouts: result.timeouts
    };
}

function fmtNum(n) {
    if (typeof n !== 'number') {
        return String(n);
    }

    if (n >= 1000) {
        return n.toFixed(0);
    }

    return n.toFixed(2);
}

async function runScenario(scenario) {
    var url = 'http://localhost:3000/';

    // router-heavy uses a deep path
    if (scenario === 'router-heavy') {
        url =
            'http://localhost:3000/whiskeys/scotch/islay/lagavulin/16-years/50';
    }

    var results = {};
    var engines = ['http', 'uws'];

    for (var i = 0; i < engines.length; i++) {
        var engine = engines[i];
        var label = engine === 'http' ? null : engine;

        console.log('  > ' + scenario + ' [' + engine + ']');
        var server = await startServer(scenario, label);

        try {
            var raw = await runBench(url);
            results[engine] = summarize(raw);
        } finally {
            await stopServer(server);
            // Give the OS a moment to release the port.
            await new Promise(function wait(r) {
                setTimeout(r, 300);
            });
        }
    }

    return results;
}

async function main() {
    console.log('# restify uws-adapter benchmark');
    console.log(
        '# duration=' +
            DURATION +
            's connections=' +
            CONNECTIONS +
            ' pipelining=' +
            PIPELINING
    );
    console.log();

    var all = {};

    for (var i = 0; i < scenarios.length; i++) {
        console.log('## ' + scenarios[i]);
        all[scenarios[i]] = await runScenario(scenarios[i]);
        console.log();
    }

    var header =
        'scenario'.padEnd(18) +
        '| ' +
        'engine'.padEnd(6) +
        '| ' +
        'req/s'.padStart(10) +
        ' | ' +
        'p50 (ms)'.padStart(9) +
        ' | ' +
        'p99 (ms)'.padStart(9) +
        ' | ' +
        'MB/s'.padStart(8) +
        ' | ' +
        'errors'.padStart(7);

    console.log(header);
    console.log('-'.repeat(header.length));

    Object.keys(all).forEach(function each(scenario) {
        var row = all[scenario];
        var httpReq = row.http.reqAvg;

        ['http', 'uws'].forEach(function eachEngine(engine) {
            var r = row[engine];
            var ratio =
                engine === 'uws' && httpReq > 0
                    ? ' (' + (r.reqAvg / httpReq).toFixed(2) + 'x)'
                    : '';

            console.log(
                scenario.padEnd(18) +
                    '| ' +
                    engine.padEnd(6) +
                    '| ' +
                    (fmtNum(r.reqAvg) + ratio).padStart(10) +
                    ' | ' +
                    fmtNum(r.latencyP50).padStart(9) +
                    ' | ' +
                    fmtNum(r.latencyP99).padStart(9) +
                    ' | ' +
                    fmtNum(r.throughputAvg / 1024 / 1024).padStart(8) +
                    ' | ' +
                    String(r.errors).padStart(7)
            );
        });
    });
}

main().catch(function fail(err) {
    console.error('benchmark failed:', err);
    process.exit(1);
});
