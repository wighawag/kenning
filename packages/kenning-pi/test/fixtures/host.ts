// A stand-in for a host such as wherever: it marks the human's input on the
// session's event bus before sending it, exactly as D22 asks hosts to do.
const HUMAN_INPUT_EVENT = 'kenning:human-input';

export default function (pi: any) {
	pi.registerCommand('test-human-says', {
		description: 'test: send text as if a human typed it on a host',
		async handler(args: string) {
			pi.events.emit(HUMAN_INPUT_EVENT, {text: args, channel: 'test-host'});
			pi.sendUserMessage(args);
		},
	});
}
