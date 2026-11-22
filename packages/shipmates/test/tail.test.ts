import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {readTail} from '../src/index.js';
import {tempDir} from './helpers.js';

let n = 0;
const line = (role: string, content: unknown) =>
	JSON.stringify({
		type: 'message',
		id: `e${n++}`,
		parentId: null,
		timestamp: '2026-11-17T10:00:00Z',
		message: {role, content, timestamp: 1},
	});

function transcript(lines: string[]): string {
	const f = path.join(tempDir(), 's.jsonl');
	fs.writeFileSync(
		f,
		[
			JSON.stringify({type: 'session', version: 3, id: 'x', cwd: '/r'}),
			...lines,
		].join('\n') + '\n',
	);
	return f;
}

describe('readTail', () => {
	it('returns the last user and assistant texts, oldest first, without tool output', () => {
		const f = transcript([
			line('user', 'Do step S1.'),
			line('assistant', [
				{type: 'thinking', thinking: 'hmm'},
				{type: 'toolCall', name: 'bash', arguments: {}},
			]),
			line('toolResult', [{type: 'text', text: 'X'.repeat(500_000)}]),
			line('assistant', [
				{type: 'text', text: 'I pushed missiv main (c3821ce).'},
			]),
			line('user', [{type: 'text', text: 'done it worked'}]),
		]);
		const tail = readTail(f, {messages: 6});
		expect(tail.messages.map((m) => [m.role, m.text])).toEqual([
			['user', 'Do step S1.'],
			['assistant', 'I pushed missiv main (c3821ce).'],
			['user', 'done it worked'],
		]);
	});

	it('keeps only the newest N and caps each message and the total', () => {
		const lines = Array.from({length: 20}, (_, i) =>
			line('assistant', [{type: 'text', text: `${i}:` + 'y'.repeat(3000)}]),
		);
		const tail = readTail(transcript(lines), {
			messages: 6,
			perMessageBytes: 2048,
			totalBytes: 5000,
		});
		expect(tail.messages[tail.messages.length - 1].text.startsWith('19:')).toBe(
			true,
		);
		for (const m of tail.messages)
			expect(Buffer.byteLength(m.text)).toBeLessThanOrEqual(2048 + 3);
		expect(
			tail.messages.reduce((a, m) => a + Buffer.byteLength(m.text), 0),
		).toBeLessThanOrEqual(5000 + 10);
		expect(tail.truncated).toBe(true);
	});

	it('reads from the end: a huge transcript costs only what it scans', () => {
		const big = Array.from({length: 200}, () =>
			line('toolResult', [{type: 'text', text: 'Z'.repeat(100_000)}]),
		);
		const f = transcript([
			line('user', 'first'),
			...big,
			line('assistant', [{type: 'text', text: 'last'}]),
		]);
		const tail = readTail(f, {messages: 6, maxScanBytes: 1_000_000});
		expect(tail.messages.map((m) => m.text)).toEqual(['last']);
		expect(tail.scannedBytes).toBeLessThanOrEqual(1_100_000);
	});

	it('a missing file is an empty tail, not an error', () => {
		expect(readTail('/nope/x.jsonl')).toEqual({
			messages: [],
			truncated: false,
			scannedBytes: 0,
		});
	});
});
