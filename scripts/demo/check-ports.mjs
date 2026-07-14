/**
 * Refuse to start the demo if one of its ports is already taken.
 *
 * This exists because it already went wrong: `serve` lost :8080 to an unrelated
 * Python app on this machine, kept running anyway, and the demo "worked" — except
 * the page being served was somebody else's project. A demo that silently points
 * at the wrong app is worse than one that refuses to start.
 *
 * WHY WE CONNECT RATHER THAN BIND:
 *
 * The obvious check — try to bind the port, treat EADDRINUSE as "busy" — does not
 * work on Windows. Measured on this machine, with a real listener on :4000:
 *
 *     bind 0.0.0.0:4000    -> SUCCEEDS   (wrong!)
 *     bind 127.0.0.1:4000  -> SUCCEEDS   (wrong!)
 *     bind [::]:4000       -> EADDRINUSE (right)
 *
 * and worse, against a server bound only to 127.0.0.1 (uvicorn, which is what
 * actually stole :8080), even the dual-stack bind SUCCEEDS. Windows will happily
 * hand you a socket on an address that overlaps someone else's listener, and you
 * only find out when your requests go to their app.
 *
 * Connecting is unambiguous on every platform: if something accepts a TCP
 * connection on that port, the port is in use. Full stop.
 */
import { connect } from 'node:net';

const PORTS = [
  { port: 4000, what: 'mock widget API' },
  { port: 3005, what: 'DineDirect web app (widget.js + embed)' },
  { port: 8090, what: "the demo restaurant's website" },
];

/** True if anything is listening. We connect; we do not bind. See the note above. */
function isInUse(port) {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });

    const done = (inUse) => {
      socket.destroy();
      resolve(inUse);
    };

    socket.setTimeout(1000);
    // Something accepted the connection — the port is taken.
    socket.once('connect', () => done(true));
    // ECONNREFUSED is what a genuinely free port looks like.
    socket.once('error', () => done(false));
    // A port that accepts but never completes is still not ours to use.
    socket.once('timeout', () => done(true));
  });
}

const taken = [];
for (const entry of PORTS) {
  if (await isInUse(entry.port)) taken.push(entry);
}

if (taken.length > 0) {
  console.error('\n  Cannot start the demo — something is already listening on:\n');
  for (const { port, what } of taken) {
    console.error(`    :${port}   (needed for ${what})`);
  }
  console.error('\n  Find out what:');
  console.error(
    process.platform === 'win32'
      ? `    netstat -ano | findstr :${taken[0].port}`
      : `    lsof -i :${taken[0].port}`,
  );
  console.error('\n  Stop it, or change the ports in package.json (the demo:* scripts).\n');
  process.exit(1);
}

console.log('\n  Ports are free. Starting the demo…\n');
console.log('  ================================================================');
console.log('');
console.log('   THE PRODUCT  ->  http://localhost:3005/s/bellaburger');
console.log('');
console.log('     The real DineDirect storefront. Open this one.');
console.log('     Menu -> cart -> checkout -> pay -> a courier moves on a map.');
console.log('');
console.log('   THE WIDGET   ->  http://localhost:8090');
console.log('');
console.log('     A deliberately UGLY 2014 restaurant website with our widget');
console.log('     embedded. The ugliness is THEIRS, on purpose - it proves the');
console.log('     widget survives a page whose CSS we do not control.');
console.log('     The only DineDirect thing there is the floating Order button.');
console.log('');
console.log('  ================================================================');
console.log('');
console.log('   Mock API     ->  http://localhost:4000  (no database, no Stripe)');
console.log('');
/**
 * NOT bellaburger.localhost:3005.
 *
 * In production a tenant lives on a real subdomain (joes.dinedirect.manvion.ca), and the
 * middleware maps that to /s/joes. But Windows does not resolve *.localhost at all
 * — the OS resolver simply fails — so anyone following that URL on Windows gets a
 * dead hostname and concludes the app is broken. It did exactly that.
 *
 * The /s/<slug> path is the same page via the same code path, and it works on every
 * OS with no hosts-file surgery.
 */
console.log('   (On Windows, *.localhost subdomains do not resolve — hence /s/<slug>.)');
console.log('');
