export type MessageHeaders = Record<string, string | string[]>;

export interface Message {
  headers: MessageHeaders;
  body: string;
  url?: string;
  messageId?: string;
}
