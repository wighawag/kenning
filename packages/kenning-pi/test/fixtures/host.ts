// A stand-in for a host such as wherever: it marks the human's input on the
// session's event bus before sending it, exactly as D22 asks hosts to do.
const HUMAN_INPUT_EVENT = 'kenning:human-input';
const HUMAN_INPUT_END_EVENT = 'kenning:human-input-end';

export default function (pi: any) {
	pi.registerCommand('test-human-says', {
		description: 'test: send text as if a human typed it on a host',
		async handler(args: string) {
			pi.events.emit(HUMAN_INPUT_EVENT, {text: args, channel: 'test-host'});
			pi.sendUserMessage(args);
		},
	});
	// A host that marked a human's send which then never reached the input
	// handler (another extension handled it, or pi refused it while compacting).
	pi.registerCommand('test-human-mark', {
		description: 'test: emit a human-input mark and send nothing',
		async handler(args: string) {
			pi.events.emit(HUMAN_INPUT_EVENT, {text: args, channel: 'test-host'});
		},
	});
	// A host that awaits its send (wherever's server): the marked send was
	// handled elsewhere, its prompt() resolved, and the host closes the mark.
	pi.registerCommand('test-human-mark-ended', {
		description: 'test: mark, the send goes nowhere, then end the mark',
		async handler(args: string) {
			pi.events.emit(HUMAN_INPUT_EVENT, {text: args, channel: 'test-host'});
			pi.events.emit(HUMAN_INPUT_END_EVENT, {text: args});
		},
	});
	// The same host when the send does go through: its awaited prompt()
	// resolves after the run, so the end comes at agent_settled.
	let endAtSettle: string | undefined;
	pi.on('agent_settled', () => {
		if (endAtSettle === undefined) return;
		pi.events.emit(HUMAN_INPUT_END_EVENT, {text: endAtSettle, id: 'awaited'});
		endAtSettle = undefined;
	});
	pi.registerCommand('test-human-says-awaited', {
		description: 'test: mark, send, end the mark once the run settled',
		async handler(args: string) {
			pi.events.emit(HUMAN_INPUT_EVENT, {
				text: args,
				channel: 'awaited-host',
				id: 'awaited',
			});
			endAtSettle = args;
			pi.sendUserMessage(args);
		},
	});
	// Two marks with the same text: an end closes only the one it names.
	pi.registerCommand('test-two-marks', {
		description: 'test: two marks, end the first by id, send once',
		async handler(args: string) {
			pi.events.emit(HUMAN_INPUT_EVENT, {
				text: args,
				channel: 'first',
				id: 'a',
			});
			pi.events.emit(HUMAN_INPUT_EVENT, {
				text: args,
				channel: 'second',
				id: 'b',
			});
			pi.events.emit(HUMAN_INPUT_END_EVENT, {text: args, id: 'a'});
			pi.events.emit(HUMAN_INPUT_END_EVENT, {text: args}); // no id: closes neither
			pi.sendUserMessage(args);
		},
	});
	// A send that is NOT a human's (a scheduled job's prompt): no mark.
	pi.registerCommand('test-extension-says', {
		description: 'test: send text from an extension, unmarked',
		async handler(args: string) {
			pi.sendUserMessage(args);
		},
	});
}
