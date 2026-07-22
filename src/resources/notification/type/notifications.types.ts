/** Push payload shape (docs/CONTRACT.md — NotificationsModule). */
export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, string>;
}
