// A scripted model for tests (pi-ai's faux provider), so real pi processes run
// with no network. It acts on directives written in the text it receives:
//   DO <tool> <json args>      call that tool (several lines, several calls)
// `$QID` in the args is replaced by the last `questionId: q_...` it saw, so a
// message can tell its receiver how to answer it. After tool results it replies
// with their text, and stops; with no directive it says "noted".
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
} from '@earendil-works/pi-ai';

type Msg = {role: string; content: string | {type: string; text?: string}[]};

const textOf = (m: Msg) =>
	typeof m.content === 'string'
		? m.content
		: m.content.map((c) => c.text ?? '').join('\n');

export default function (pi: any) {
	const core = createFauxCore({
		provider: 'faux',
		api: 'faux',
		models: [{id: 'brain'}],
	});
	let calls = 0;
	pi.registerProvider('faux', {
		baseUrl: 'http://faux.invalid',
		apiKey: 'none',
		api: 'faux',
		models: [
			{
				id: 'brain',
				name: 'brain',
				reasoning: false,
				input: ['text'],
				cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
				contextWindow: 200000,
				maxTokens: 4000,
			},
		],
		streamSimple: (model: any, context: any, options: any) => {
			core.setResponses([(ctx: any) => respond(ctx.messages as Msg[])]);
			return core.streamSimple(model, context, options);
		},
	});

	function respond(messages: Msg[]) {
		const all = messages.filter((m) => m.role !== 'system');
		let lastAssistant = -1;
		for (let i = all.length - 1; i >= 0; i--)
			if (all[i].role === 'assistant') {
				lastAssistant = i;
				break;
			}
		const fresh = all.slice(lastAssistant + 1);
		const userTexts = fresh.filter((m) => m.role === 'user').map(textOf);
		if (!userTexts.length) {
			const results = fresh.filter((m) => m.role === 'toolResult').map(textOf);
			return fauxAssistantMessage(fauxText('results: ' + results.join(' | ')));
		}
		const text = userTexts.join('\n');
		const qids = [...text.matchAll(/questionId: (q_[\w-]+)/g)].map((m) => m[1]);
		const qid = qids[qids.length - 1] ?? '';
		const calls_: ReturnType<typeof fauxToolCall>[] = [];
		for (const m of text.matchAll(/DO (\w+) (\{[^\n]*\})/g)) {
			try {
				// Only substitute once a question id was seen, so a sender can pass `$QID`
				// through to its receiver.
				const args = JSON.parse(qid ? m[2].replaceAll('$QID', qid) : m[2]);
				calls_.push(fauxToolCall(m[1], args, {id: `call_${++calls}`}));
			} catch (e) {
				return fauxAssistantMessage(
					fauxText(`bad directive: ${m[0]}: ${(e as Error).message}`),
				);
			}
		}
		if (!calls_.length)
			return fauxAssistantMessage(
				fauxText('noted: ' + text.split('\n')[0].slice(0, 120)),
			);
		return fauxAssistantMessage(calls_, {stopReason: 'toolUse'});
	}
}
