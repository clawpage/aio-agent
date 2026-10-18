/**
 * Title a freshly created conversation carries until it is named. It is stored
 * and matched by value (the single blank default conversation), so it stays the
 * same in every language (the console lists these conversations only in its
 * legacy view, for control planes without the task inbox).
 */
export const DEFAULT_CONVERSATION_TITLE = "新会话"; // i18n-exempt: stored marker of the blank default conversation, matched in SQL

/** Event emitted after a conversation is renamed, so open clients refresh. */
export const TITLE_UPDATED_EVENT = "conversation.title_updated";
