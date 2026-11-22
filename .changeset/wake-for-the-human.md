---
"kenning": patch
"kenning-pi": patch
---

A session that declared `waiting-for-human` now wakes when the human answers it. Before, an answer given from the inbox (`kenning answer`, or a host's inbox such as wherever's web and Telegram) was held like any other message until the human also typed into that session, so a session that asked a non-blocking `human_ask` and then waited, as the guidelines say, never saw the answer by itself. Messages from other sessions are still held for the human's next turn, and nothing wakes a session while the human is typing into it or with `/kenning wake off` (spec D37).
