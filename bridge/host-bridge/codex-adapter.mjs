import {
  MessageType,
  createMessage,
  createMockSession,
  createTimelineEvent
} from '../../packages/protocol/index.mjs';

export class MockCodexAdapter {
  constructor(hostId) {
    this.hostId = hostId;
    this.session = createMockSession(hostId);
  }

  listSessions() {
    return [this.session];
  }

  async sendPrompt(sessionId, text) {
    if (sessionId !== this.session.session_id) {
      throw new Error(`Unknown mock session: ${sessionId}`);
    }

    const event = createTimelineEvent(
      sessionId,
      'Prompt routed to Host Bridge',
      `Host Bridge received prompt: ${text}`,
      {
        adapter: 'mock',
        received_prompt: text
      }
    );

    return createMessage(MessageType.TimelineEvent, { event });
  }
}

