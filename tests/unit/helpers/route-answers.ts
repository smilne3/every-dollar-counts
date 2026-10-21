import { MAY_NOT_HAVE_SAVED } from '@/lib/save-response'

// A route's answer as a test compares it: its status, its content type and its body as text.
export const answerOf = async (res: Response) => ({
  status: res.status,
  type: res.headers.get('content-type'),
  text: await res.text(),
})

// What a route answers for a write the database never answered (lib/lost-reply.ts, #173): a 502 in
// plain text, not the route's JSON, which every client reads as an unknown outcome.
export const UNKNOWN_ANSWER = { status: 502, type: 'text/plain; charset=utf-8', text: MAY_NOT_HAVE_SAVED }
