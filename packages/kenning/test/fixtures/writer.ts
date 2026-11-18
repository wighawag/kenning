// A separate OS process hammering one kenning database: it sends `count`
// messages (each retried once with the same requestId, as a flaky caller would)
// and claims every message addressed to its own session.
import {openKenning, silenceSqliteWarning} from '../../src/index.js';

silenceSqliteWarning();
const [stateDir, me, peer, countArg] = process.argv.slice(2);
const k = openKenning({stateDir});
k.register({sessionFile: me, cwd: '/r'});
const claimed: string[] = [];
for (let i = 0; i < Number(countArg); i++) {
	k.send({from: me, to: peer, text: `${me} #${i}`, requestId: `r${i}`});
	k.send({from: me, to: peer, text: `${me} #${i}`, requestId: `r${i}`});
	for (const m of k.claim(me)) claimed.push(m.id);
}
// Keep polling like the extension's poller does (but faster) until the peer
// writing to us is done, i.e. we hold `count` messages.
const sleep = (ms: number) =>
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const deadline = Date.now() + 20_000;
while (claimed.length < Number(countArg) && Date.now() < deadline) {
	for (const m of k.claim(me)) claimed.push(m.id);
	sleep(20);
}
k.markDelivered(me, claimed);
process.stdout.write(JSON.stringify(claimed));
k.close();
