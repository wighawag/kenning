import {randomBytes} from 'node:crypto';

/** Short, typed, unguessable ids: `m_` messages, `q_` questions, `h_` attention items, `t_` human turns. */
export function newId(prefix: string): string {
	return `${prefix}_${randomBytes(6).toString('base64url')}`;
}
