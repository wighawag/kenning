/**
 * `node:sqlite` is still flagged experimental and prints a warning on first
 * use. That is noise in a CLI the user runs fifty times a day, so it is
 * silenced here and ONLY here, narrowly: any other warning still gets through.
 */
export function silenceSqliteWarning(): void {
	const proc = process as unknown as {
		emit: (name: string, ...args: unknown[]) => boolean;
	};
	const original = proc.emit.bind(process);
	proc.emit = (name: string, ...args: unknown[]): boolean => {
		if (name === 'warning') {
			const warning = args[0] as {name?: string; message?: string} | undefined;
			if (
				warning?.name === 'ExperimentalWarning' &&
				/SQLite/i.test(warning.message ?? '')
			)
				return false;
		}
		return original(name, ...args);
	};
}
