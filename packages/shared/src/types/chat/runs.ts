import type { ChatMessageStatus, ChatPageContext } from './messages';

/** The user's answer to a clarification card. It travels in the message body, so it works for read-only users too. */
export interface ChatClarificationAnswerInput {
  clarificationId: string;
  optionIds: string[];
  freeText?: string;
}

/**
 * Body of `POST /chat/threads/:id/messages`. `text` may be empty only when the message carries an
 * attachment or a clarification answer.
 */
export interface ChatSendMessageRequest {
  text: string;
  attachmentIds?: string[];
  pageContext?: ChatPageContext;
  clarificationAnswer?: ChatClarificationAnswerInput;
}

/** The 202 answer to a sent message: the run executes detached, its events stream from `/chat/runs/:runId/events`. */
export interface ChatSendMessageResponse {
  runId: string;
  /** The assistant message the run fills. */
  messageId: string;
  userMessageId: string;
}

/** The answer to a cancel request. `status` is still `streaming` while the run winds down. */
export interface ChatCancelRunResponse {
  runId: string;
  status: ChatMessageStatus;
}
