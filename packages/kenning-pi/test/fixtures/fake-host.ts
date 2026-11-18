// A fake host, like wherever, registered in-process in ONE pi (the
// orchestrator). It spawns each child as its own `pi --mode rpc` process (its
// own process group) on an explicit session path, resolves as soon as that
// path is final, and stops a child by sending it RPC `abort`. Every request is
// appended to $KENNING_TEST_HOST_LOG so the test can check what kenning asked.
import {spawn, type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {registerHost, type KenningHost} from 'kenning';

export default function (pi: any) {
	const children = new Map<string, ChildProcess>();
	const log = (entry: object) =>
		fs.appendFileSync(
			process.env.KENNING_TEST_HOST_LOG!,
			JSON.stringify(entry) + '\n',
		);
	const host: KenningHost = {
		async spawn(req) {
			log({type: 'spawn', req});
			const cmd = JSON.parse(process.env.KENNING_SPAWN_COMMAND!) as string[];
			const sessionFile = path.join(
				process.env.KENNING_TEST_SESSION_DIR!,
				`${new Date().toISOString().replace(/[:.]/g, '-')}_${randomUUID()}.jsonl`,
			);
			const out = fs.openSync(
				path.join(
					path.dirname(process.env.KENNING_TEST_HOST_LOG!),
					`child-${children.size}.events`,
				),
				'a',
			);
			const child = spawn(
				cmd[0],
				[...cmd.slice(1), '--mode', 'rpc', '--session', sessionFile],
				{cwd: req.folder, detached: true, stdio: ['pipe', out, out]},
			);
			fs.closeSync(out);
			children.set(sessionFile, child);
			return {sessionFile};
		},
		async stop(sessionFile, opts) {
			log({type: 'stop', sessionFile, by: opts.by});
			const child = children.get(sessionFile);
			if (!child) return 'not-mine';
			child.stdin!.write(JSON.stringify({id: 'stop', type: 'abort'}) + '\n');
			return 'stopped';
		},
	};
	const off = registerHost(host);
	pi.on('session_shutdown', () => {
		off();
		for (const c of children.values())
			try {
				process.kill(-c.pid!, 'SIGTERM');
			} catch {}
	});
}
