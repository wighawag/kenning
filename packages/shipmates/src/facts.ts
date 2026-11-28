import type {ItemStatus, StatusFacts, StatusRef} from './types.js';

/** A time as readers on any machine read it: UTC, to the minute. */
function at(t: number | null): string {
	return t === null ? '' : ` ${new Date(t).toISOString().slice(0, 16)}Z`;
}

/**
 * One id a status line names that is no longer open (D41), in words that say
 * whether the asking session has the answer yet. "Answered" alone misleads
 * the other way: on 2026-11-28 the asker had not read it, and was not acting
 * on it.
 */
export function formatStatusRef(ref: StatusRef): string {
	if (ref.state === 'unknown')
		return `${ref.id}: no such ${ref.kind === 'item' ? 'inbox item' : 'question'} (mistyped, or pruned)`;
	if (ref.kind === 'question') return `${ref.id} ${ref.state}${at(ref.at)}`;
	if (ref.state === 'withdrawn') return `${ref.id} withdrawn${at(ref.at)}`;
	const who = ref.own ? 'this session' : 'the session that asked';
	return `${ref.id} answered by the human${at(ref.at)}${ref.channel ? ` on ${ref.channel}` : ''}, ${ref.answerPending ? `answer not yet delivered to ${who}` : `answer read by ${who}`}`;
}

/** An outstanding item (D41): open, or answered and not yet read by its session. */
export function formatItemFact(i: ItemStatus): string {
	if (i.state === 'open')
		return `${i.id} open${i.blocking ? ' (blocking)' : ''}, asked${at(i.createdAt)}`;
	return `${i.id} answered${at(i.finishedAt)}${i.answerChannel ? ` on ${i.answerChannel}` : ''}, answer not yet delivered`;
}

/**
 * The derived facts as lines for a presence block (D41): what the human owes
 * this session, and the ids its status names that no longer hold. Empty when
 * there is nothing to say.
 */
export function formatStatusFacts(f: StatusFacts): string[] {
	const lines: string[] = [];
	if (f.stale.length) {
		// The warning only where the status may say the opposite of the facts: an
		// answer its session may not have read, or an id shipmates does not know. A
		// status naming an answer it has read, or its own withdrawal, may well be
		// up to date, and would carry the warning on every list.
		const lag = f.stale.some(
			(r) =>
				r.state === 'unknown' ||
				(r.state === 'answered' && (r.kind === 'question' || r.answerPending)),
		);
		lines.push(
			`status names: ${f.stale.map(formatStatusRef).join('; ')}${lag ? ' (the status is its own words and may lag)' : ''}`,
		);
	}
	if (f.items.length)
		lines.push(`its inbox items: ${f.items.map(formatItemFact).join('; ')}`);
	return lines;
}
