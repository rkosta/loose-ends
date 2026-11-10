import type { PromptComposeResult, PromptComposeSection } from 'claude-code'

// Fixed text: it never carries the thread list, so the section stays cached
// for the whole conversation.
const RULE =
  '**Loose ends.** This project keeps a list of open discussion threads (tools `park`, `close`, `list`). If your previous reply raised 2+ separate points that needed the user\'s input (in prose or as questions in a question dialog) and their reply took up only some or none of them, call `park` with the rest, then say "Parked: …" in one line. A label is a short noun phrase of about 50 characters naming the decision, not the question with its options ("repo hosting", "HANDOFF.md: README or docs/"), clear without this conversation, with no prefix shared across labels. When a parked thread is settled, call `close` with a one-line note; if threads remain open, add one line, "Still open: #id label, …". When the user\'s reply changes what a thread asks, close it with a note saying so and park the new question. Never park implementation steps, todo items or trivia. After `/clear` or at session start, call `list` only when you need to know what\'s pending.'

export const RULE_SECTION: PromptComposeSection = {
  id: 'loose-ends:rule',
  scope: 'session',
  text: RULE,
}

/** The sections beneath, unchanged, with the rule last. */
export function withRule(composed: PromptComposeResult): PromptComposeResult {
  return { sections: [...composed.sections, RULE_SECTION] }
}
