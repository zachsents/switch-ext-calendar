// Whether the sense works: `calendar.heartbeat`, beaten by the sync loop itself, so it stops when
// that loop does. Every five minutes, and at once when what's failing changes.
import { Cause, Effect, Schema } from "effect"
import { defineEvent } from "switch-ext-kit"
import type { AppEventsShape } from "switch-ext-kit"

const EVERY = 5 * 60_000
/** A round's own time: a beat due within this is beaten now. */
const SLACK = 30_000
const LINE = 300

export const Heartbeat = defineEvent(
  "calendar.heartbeat",
  1,
  Schema.Struct({
    entity: Schema.Literal("sense:calendar"),
    summary: Schema.String,
    facts: Schema.Struct({
      /** What's wrong now, in one line; null when nothing is. */
      failing: Schema.NullOr(Schema.String),
      accounts: Schema.Finite,
      calendars: Schema.Finite,
      events: Schema.Finite,
      /** Events and notices not told, each tried again the next round. */
      skipped: Schema.Finite,
    }),
  }),
)

export type Facts = Omit<(typeof Heartbeat.payload.Type)["facts"], "failing">

export const oneLine = (s: string) => {
  const flat = s.replaceAll(/\s+/gu, " ").trim()
  return flat.length > LINE ? `${flat.slice(0, LINE - 1)}…` : flat
}

/** What failed, as one line. */
export const why = (cause: Cause.Cause<unknown>) => {
  const e = Cause.squash(cause)
  return oneLine(e instanceof Error ? e.message : String(e))
}

/** Runs `effect`, defects and all: null when it worked, else its error as one line. */
export const attempt = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.exit(effect), (exit) => (exit._tag === "Success" ? null : why(exit.cause)))

/** Each part's trouble, the items each part skipped, and the beat. */
export const makeHeart = (events: AppEventsShape) => {
  const parts = new Map<string, string>()
  const skipped = new Map<string, number>()
  let told: string | null | undefined
  let at = 0

  const failing = () =>
    parts.size === 0 ? null : [...parts].map(([part, error]) => `${part}: ${error}`).join("; ")

  /** A part's trouble now; null: it works. */
  const set = (part: string, error: string | null) => {
    if (error === null) {
      parts.delete(part)
    } else {
      parts.set(part, oneLine(error))
    }
  }

  /**
   * One pass of a part over its items: each item tried on its own, so one that fails is skipped
   * and the rest go on. `done` makes the items that failed this pass the part's trouble.
   */
  const pass = (part: string) => {
    const failed = new Map<string, string>()
    return {
      item: <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
        Effect.map(attempt(effect), (problem) => {
          if (problem !== null) {
            failed.set(name, problem)
          }
          return problem === null
        }),
      done: () => {
        skipped.set(part, failed.size)
        const [first] = failed
        if (first === undefined) {
          set(part, null)
        } else {
          const line = `${first[0]}: ${first[1]}`
          set(part, failed.size === 1 ? line : `${failed.size} skipped; ${line}`)
        }
      },
    }
  }

  /** Beats when one is due (`round`: the sense's loop calling) or what's failing changed. */
  const beat = (round: boolean, facts: Omit<Facts, "skipped">, summary: string) =>
    Effect.gen(function* beating() {
      const now = Date.now()
      const f = failing()
      if (f === told && !(round && now - at >= EVERY - SLACK)) {
        return
      }
      let n = 0
      for (const k of skipped.values()) {
        n += k
      }
      yield* events.emit(
        Heartbeat.make({
          entity: "sense:calendar",
          summary,
          facts: { failing: f, ...facts, skipped: n },
        }),
      )
      told = f
      at = now
    }).pipe(Effect.ignore({ log: "Warn" }))

  return { set, pass, failing, beat, failingParts: () => [...parts.keys()] }
}
