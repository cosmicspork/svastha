// Where questions are answered: here, on the owner's node, or whichever can.
//
// Both machines can answer, and until now which one did was decided entirely by
// circumstance — this device answered whenever it had an endpoint, and the node
// got the question otherwise. That is a reasonable default and a poor rule: a
// person who has an endpoint on their phone *and* a node may want the node's
// bigger model, or may want their record never to leave the phone. Neither is
// expressible by configuring an endpoint or not.
//
// So it is a stated choice with three positions, and page reading follows it too
// (`read-page.ts`) — the owner picked where their record gets processed, not
// where one feature of it does.
import { get, put } from './db'

/** `prefs` key. Device-local: this device's routing, not record content. */
const WHERE_KEY = 'ai-answer-where'

export type AnswerWhere = 'auto' | 'device' | 'node'

export const ANSWER_WHERE_DEFAULT: AnswerWhere = 'auto'

export async function loadAnswerWhere(): Promise<AnswerWhere> {
  const stored = await get<string>('prefs', WHERE_KEY)
  return stored === 'device' || stored === 'node' ? stored : ANSWER_WHERE_DEFAULT
}

export async function saveAnswerWhere(where: AnswerWhere): Promise<void> {
  await put('prefs', where, WHERE_KEY)
}

/**
 * Whether the next question is answered on **this device**.
 *
 * Note what `device` returns when nothing is configured: `true`. That is
 * deliberate and it is the whole point of the setting. The caller's fallback for
 * `false` is to send the question to the node, and an owner who said "answer on
 * this device" has said, in as many words, not to do that. So the question stays
 * here and the answering path raises its honest "no endpoint is configured on
 * this device" — an error the owner can act on, rather than a silent hand-off to
 * the machine they excluded.
 *
 * Pure, so both the routing and that deliberate asymmetry are testable without a
 * vault or an endpoint.
 */
export function answersHere(where: AnswerWhere, deviceConfigured: boolean): boolean {
  switch (where) {
    case 'device':
      return true
    case 'node':
      return false
    case 'auto':
      return deviceConfigured
  }
}
