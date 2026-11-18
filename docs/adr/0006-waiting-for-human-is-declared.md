# A session waits for the human only when that is declared

**Status:** accepted (2026-11-17)

To pi, "waiting for the human" and "idle" are the same: settled, not streaming. kenning starts a turn in an idle session when a message arrives, and holds it for a session that waits for the human. A session is `waiting-for-human` only while it has an open blocking `human_ask`, an open `ctx.ui` dialog, or has said so with `session_register`. Otherwise a settled session is idle and wakes on a message, except while the TUI editor holds text (the human is typing; the message then joins the human's turn) or after `/kenning wake off`. The extension's prompt guidelines tell the agent to raise human decisions with `human_ask`, and a woken turn is told that the message is not the human's answer.

**Rejected:** treating every human-started session as waiting (in the template-tree flow every lane was human-started, so nothing would ever wake and the human would stay the mail carrier) and guessing from the last assistant text (silent when wrong).
