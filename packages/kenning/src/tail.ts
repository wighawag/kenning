import fs from 'node:fs';

export interface TailMessage {
	role: 'user' | 'assistant';
	text: string;
	timestamp: string | null;
}

export interface Tail {
	messages: TailMessage[];
	/** True when a message was cut, or the total cap or the scan bound dropped older ones. */
	truncated: boolean;
	scannedBytes: number;
}

export interface TailOptions {
	messages?: number;
	perMessageBytes?: number;
	totalBytes?: number;
	/** Stop scanning backwards after this many bytes (tool results can be most of a file). */
	maxScanBytes?: number;
}

const CHUNK = 64 * 1024;

/**
 * The last user and assistant texts of a pi transcript, read BACKWARDS from the
 * end in chunks, never materialising the file: transcripts reach 62 MB (wherever
 * CONTEXT.md, "Reading transcripts"), and most of their bytes are tool results we
 * skip. Lines are recognised by their head before being parsed, so a 500 KB tool
 * result is never turned into an object.
 */
export function readTail(file: string, opts: TailOptions = {}): Tail {
	const want = opts.messages ?? 6;
	const perMessage = opts.perMessageBytes ?? 2048;
	const total = opts.totalBytes ?? 12 * 1024;
	const maxScan = opts.maxScanBytes ?? 8 * 1024 * 1024;
	let fd: number;
	try {
		fd = fs.openSync(file, 'r');
	} catch {
		return {messages: [], truncated: false, scannedBytes: 0};
	}
	const found: TailMessage[] = [];
	let truncated = false;
	let scanned = 0;
	try {
		let pos = fs.fstatSync(fd).size;
		let carry: Buffer = Buffer.alloc(0);
		while (pos > 0 && found.length < want) {
			if (scanned >= maxScan) {
				truncated = true;
				break;
			}
			const len = Math.min(CHUNK, pos);
			pos -= len;
			const buf = Buffer.alloc(len);
			fs.readSync(fd, buf, 0, len, pos);
			scanned += len;
			let data = Buffer.concat([buf, carry]);
			// Every complete line is after the first newline (or the file start).
			let end = data.length;
			for (let i = data.length - 1; i >= -1 && found.length < want; i--) {
				if (i >= 0 && data[i] !== 0x0a) continue;
				if (i < 0 && pos > 0) break; // the first line of this chunk may be partial
				const lineBuf = data.subarray(i + 1, end);
				end = i;
				const m = parseLine(lineBuf);
				if (m) found.push(m);
			}
			carry = data.subarray(0, Math.max(end, 0));
			if (carry.length > maxScan) {
				truncated = true;
				break;
			}
		}
	} finally {
		fs.closeSync(fd);
	}
	const out: TailMessage[] = [];
	let used = 0;
	for (const m of found) {
		let text = m.text;
		if (Buffer.byteLength(text) > perMessage) {
			text = cut(text, perMessage) + '...';
			truncated = true;
		}
		const size = Buffer.byteLength(text);
		if (used + size > total) {
			truncated = true;
			break;
		}
		used += size;
		out.push({...m, text});
	}
	return {messages: out.reverse(), truncated, scannedBytes: scanned};
}

const HEAD = 512;

function parseLine(line: Buffer): TailMessage | null {
	if (line.length === 0) return null;
	// pi writes `type` and the fixed keys before `message`, so the first
	// occurrence of the role marker in the head is the structural one.
	const head = line.subarray(0, HEAD).toString('utf8');
	if (!head.startsWith('{"type":"message"')) return null;
	const roleMatch = /"message":\{"role":"(\w+)"/.exec(head);
	if (!roleMatch || (roleMatch[1] !== 'user' && roleMatch[1] !== 'assistant'))
		return null;
	let entry: {timestamp?: string; message?: {role: string; content: unknown}};
	try {
		entry = JSON.parse(line.toString('utf8'));
	} catch {
		return null;
	}
	const content = entry.message?.content;
	let text = '';
	if (typeof content === 'string') text = content;
	else if (Array.isArray(content))
		text = content
			.filter(
				(b): b is {type: 'text'; text: string} =>
					!!b && (b as {type?: string}).type === 'text',
			)
			.map((b) => b.text)
			.join('\n');
	text = text.trim();
	if (!text) return null;
	return {
		role: roleMatch[1] as 'user' | 'assistant',
		text,
		timestamp: entry.timestamp ?? null,
	};
}

function cut(s: string, bytes: number): string {
	const b = Buffer.from(s);
	if (b.length <= bytes) return s;
	// Do not split a multi-byte character.
	let end = bytes;
	while (end > 0 && (b[end] & 0xc0) === 0x80) end--;
	return b.subarray(0, end).toString('utf8');
}
