#!/usr/bin/env node
import {runCli} from './cli-run.js';
import {silenceSqliteWarning} from './quiet.js';

silenceSqliteWarning();
process.exitCode = runCli(process.argv.slice(2), {
	env: process.env,
	isTTY: !!(process.stdin.isTTY && process.stdout.isTTY),
	stdout: (s) => process.stdout.write(s),
	stderr: (s) => process.stderr.write(s),
});
