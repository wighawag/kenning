import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

/** Who a process is, precisely enough that a reused pid is not mistaken for it. */
export interface ProcessIdentity {
	pid: number;
	/** Process start time as the OS reports it; null when it cannot be read. */
	startTime: string | null;
	bootId: string | null;
	host: string;
}

export interface ProcessProbe {
	self(): ProcessIdentity;
	isAlive(p: ProcessIdentity): boolean;
}

/**
 * The same rule as wherever's assistant lock: a process is alive when its pid
 * runs on this boot with the start time recorded. On another host we cannot
 * know, so it counts as alive (single machine is the stated scope).
 */
export class OsProbe implements ProcessProbe {
	private readonly host = os.hostname();
	private readonly bootId = readBootId();
	private me: ProcessIdentity | undefined;

	self(): ProcessIdentity {
		this.me ??= {
			pid: process.pid,
			startTime: startTimeOf(process.pid),
			bootId: this.bootId,
			host: this.host,
		};
		return this.me;
	}

	isAlive(p: ProcessIdentity): boolean {
		if (p.host !== this.host) return true;
		if (p.bootId && this.bootId && p.bootId !== this.bootId) return false;
		try {
			process.kill(p.pid, 0);
		} catch (e) {
			// EPERM means it exists but belongs to someone else.
			if ((e as NodeJS.ErrnoException).code !== 'EPERM') return false;
		}
		if (!p.startTime) return true;
		const now = startTimeOf(p.pid);
		return now === null || now === p.startTime;
	}
}

function readBootId(): string | null {
	try {
		return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
	} catch {}
	if (process.platform === 'darwin') {
		try {
			return execFileSync('sysctl', ['-n', 'kern.boottime'], {
				encoding: 'utf8',
			}).trim();
		} catch {}
	}
	return null;
}

function startTimeOf(pid: number): string | null {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
		// Field 22 (starttime) counts after the ")" that closes the command name,
		// which may itself contain spaces or parentheses.
		const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
		return rest[19] ?? null;
	} catch {}
	if (process.platform === 'darwin') {
		try {
			return (
				execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
					encoding: 'utf8',
				}).trim() || null
			);
		} catch {}
	}
	return null;
}
