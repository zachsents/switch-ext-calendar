// One calendar from many: each source synced into the store, what changed told to the brain, and
// writes sent to the provider that holds the event, logged so each can be undone. Other people's
// invites live in the providers, so they stay the source of truth: a write lands there first.
import { Context, Effect, Layer, Schedule, Schema } from "effect"

import { AppEvents } from "switch-ext-kit"
import * as core from "./core.ts"
import {
  Conflict,
  EventCancelled,
  EventChanged,
  EventCreated,
  InviteReceived,
  Next,
  StartingSoon,
} from "./events.ts"
import * as google from "./google.ts"
import { attempt, makeHeart, why } from "./heartbeat.ts"
import { awaiting, event, holds, others } from "./model.ts"
import type { Calendar, Delta, Event, Response } from "./model.ts"
import type { Settings } from "./settings.ts"
import { openStore } from "./store.ts"
import type { Store, Write } from "./store.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** What the brain is told about: a day back to two months ahead. */
const TOLD_BACK = DAY
const TOLD_AHEAD = 60 * DAY
/** A read reaches this far back; anything older is kept as it was. */
const READ_BACK = 29 * DAY
const SOON_MS = 10 * MINUTE

const hhmm = (ms: number) =>
  new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString()

/** Fields whose change is worth saying. */
const watched = [
  "title",
  "start",
  "end",
  "location",
  "status",
  "response",
  "attendees",
  "notes",
  "call",
] as const

const changesOf = (a: Event, b: Event) =>
  watched.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))

/** The same meeting on two calendars (an invite to two accounts). */
const sameKey = (e: Event) => `${e.ical ?? e.title.toLowerCase()}@${e.start}`

const parseEvent: (json: string) => Event = Schema.decodeUnknownSync(Schema.fromJsonString(event))

export interface Sync {
  readonly calendar: string
  readonly name: string
  readonly provider: string
  readonly account: string
  readonly events: number
  readonly error?: string
}

export interface Fields {
  readonly title?: string
  readonly start?: number
  readonly end?: number
  readonly allDay?: boolean
  readonly location?: string | null
  readonly notes?: string | null
  readonly busy?: boolean
}

export interface Held {
  readonly held: string
  readonly item: string | null
  readonly why: string
}

const heldId = () => `h-${crypto.randomUUID().slice(0, 8)}`
const writeId = () => `w-${crypto.randomUUID().slice(0, 8)}`

const make = (settings: Settings) =>
  Effect.gen(function* making() {
    const events = yield* AppEvents
    const store: Store = openStore(settings.db)
    /** Connected Google accounts with Calendar's scope, as the core last said. */
    let googles: readonly string[] = []
    /** Asked the user to connect one already, this run. */
    let asked = false
    /** Writes waiting to be told, by event id. */
    const writeOf = new Map<string, string>()
    let lastNext = ""
    let lastTick = Date.now()
    const heart = makeHeart(events)

    const calendarOf = (id: string) => store.calendars().find((c) => c.id === id) ?? null

    // Applying what a source says

    /**
     * Stores what a source says. An event that won't store is skipped, and the cursor stays where
     * it was, so the next read brings it again; what failed comes back.
     */
    const apply = (calendar: Calendar, delta: Delta) => {
      const seen = new Set<string>()
      const failed: string[] = []
      const each = (what: string, store1: () => void) => {
        try {
          store1()
        } catch (error) {
          failed.push(`${what}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      for (const e of delta.events) {
        seen.add(e.id)
        each(`${e.title} (${e.id})`, () => {
          store.put(e)
        })
      }
      const gone = [...delta.gone]
      if (delta.full) {
        const since = Date.now() - READ_BACK
        for (const id of store.idsOf(calendar.id)) {
          const s = store.get(id)
          if (!seen.has(id) && s !== null && s.event.end > since) {
            gone.push(id)
          }
        }
      }
      for (const id of gone) {
        each(id, () => {
          const s = store.get(id)
          if (s !== null && s.event.status !== "cancelled") {
            store.put({ ...s.event, status: "cancelled" })
          }
        })
      }
      if (failed.length === 0 && (delta.cursor !== null || delta.full)) {
        store.setCursor(calendar.id, delta.cursor)
      }
      return failed
    }

    const syncGoogle = (account: string) =>
      Effect.gen(function* syncing() {
        const out: Sync[] = []
        const cals = yield* google.calendarsOf(account)
        for (const c of cals) {
          store.putCalendar(c)
        }
        for (const id of store.dropCalendars(
          "google",
          account,
          cals.map((c) => c.id),
        )) {
          store.markGone(id)
        }
        const cursors = new Map(store.calendars().map((c) => [c.id, c.cursor]))
        for (const c of cals) {
          const first = (cursors.get(c.id) ?? null) === null
          const result = yield* Effect.result(google.read(c, cursors.get(c.id) ?? null))
          if (result._tag === "Failure") {
            out.push({ ...summary(c), error: result.failure.message })
            continue
          }
          const failed = apply(c, result.success)
          if (first) {
            initial.add(c.id)
          }
          const [one] = failed
          out.push(
            one === undefined
              ? summary(c)
              : {
                  ...summary(c),
                  error: failed.length === 1 ? one : `${failed.length} not stored; ${one}`,
                },
          )
        }
        return out
      })

    const summary = (c: Calendar): Sync => ({
      calendar: c.id,
      name: c.name,
      provider: c.provider,
      account: c.account,
      events: store.counts().find((x) => x.calendar === c.id)?.n ?? 0,
    })

    /** Calendars whose first read this is: what they hold isn't news. */
    const initial = new Set<string>()

    // Telling the brain

    const tell = Effect.gen(function* telling() {
      const now = Date.now()
      const span = store.between(now - TOLD_BACK, now + TOLD_AHEAD, true)
      const emails = new Set<string>()
      for (const s of span) {
        for (const p of others(s.event)) {
          emails.add(p.email)
        }
      }
      const known = yield* core.people([...emails])
      const withPeople = (e: Event): Event => {
        const people: Record<string, string> = {}
        for (const p of others(e)) {
          const id = known[p.email]
          if (id !== undefined) {
            people[p.email] = id
          }
        }
        return Object.keys(people).length === 0 ? e : { ...e, people }
      }
      // Each event on its own: one that can't be told stays untold, and is tried again next time.
      const pass = heart.pass("tell")
      for (const s of span) {
        const e = withPeople(s.event)
        yield* pass.item(
          `${e.title} (${e.id})`,
          Effect.gen(function* tellingOne() {
            const json = JSON.stringify(e)
            const write = writeOf.get(e.id)
            const by = write === undefined ? {} : { write }
            if (s.told === null) {
              if (e.status !== "cancelled") {
                const first = initial.has(e.calendar)
                yield* events.emit(
                  EventCreated.make({ event: e, ...(first ? { initial: true } : {}), ...by }),
                )
                store.setTold(e.id, json)
              }
            } else if (e.status === "cancelled") {
              yield* events.emit(EventCancelled.make({ event: e, ...by }))
              store.setTold(e.id, null)
            } else if (s.told !== json) {
              const changes = changesOf(parseEvent(s.told), e)
              if (changes.length > 0 || write !== undefined) {
                yield* events.emit(EventChanged.make({ event: e, changes, ...by }))
              }
              store.setTold(e.id, json)
            }
            writeOf.delete(e.id)
            if (!s.inviteTold && awaiting(e, now) && !initial.has(e.calendar)) {
              yield* events.emit(InviteReceived.make({ event: e }))
              store.setInviteTold(e.id)
            } else if (!s.inviteTold && initial.has(e.calendar)) {
              store.setInviteTold(e.id)
            }
          }),
        )
      }
      pass.done()
      initial.clear()
      yield* conflicts
    })

    // What's on: merged across calendars, the same meeting once

    const merged = (from: number, to: number) => {
      const out = new Map<string, Event & { readonly also: readonly string[] }>()
      for (const s of store.between(from, to)) {
        const key = sameKey(s.event)
        const had = out.get(key)
        if (had === undefined) {
          out.set(key, { ...s.event, also: [] })
        } else {
          out.set(key, { ...had, also: [...had.also, s.event.calendar] })
        }
      }
      return [...out.values()]
    }

    const conflictsIn = (from: number, to: number) => {
      const busy = merged(from, to).filter(holds)
      const pairs: (readonly [Event, Event])[] = []
      for (let i = 0; i < busy.length; i += 1) {
        const a = busy[i]
        if (a === undefined) {
          continue
        }
        for (let j = i + 1; j < busy.length; j += 1) {
          const b = busy[j]
          if (b === undefined || b.start >= a.end) {
            break
          }
          if (b.start < a.end && a.start < b.end) {
            pairs.push([a, b])
          }
        }
      }
      return pairs
    }

    const conflicts = Effect.gen(function* conflicting() {
      const now = Date.now()
      const pass = heart.pass("conflicts")
      for (const [a, b] of conflictsIn(now, now + 14 * DAY)) {
        const pair = [a, b]
          .map((e) => `${e.id}@${e.start}-${e.end}`)
          .toSorted()
          .join("|")
        if (!store.conflictSeen(pair)) {
          yield* pass.item(
            `${a.title} and ${b.title}`,
            Effect.gen(function* tellingOne() {
              yield* events.emit(Conflict.make({ events: [a, b] }))
              store.addConflict(pair)
            }),
          )
        }
      }
      pass.done()
    })

    // The clock: starting soon, and the next meeting

    const tick = Effect.gen(function* ticking() {
      const now = Date.now()
      const upcoming = merged(now, now + DAY).filter((e) => holds(e) && e.start > now)
      const pass = heart.pass("clock")
      for (const e of upcoming.filter((x) => x.start - now <= SOON_MS)) {
        const s = store.get(e.id)
        if (s !== null && s.soonTold !== e.start) {
          yield* pass.item(
            `${e.title} (${e.id})`,
            Effect.gen(function* tellingOne() {
              yield* events.emit(
                StartingSoon.make({ event: e, minutes: Math.round((e.start - now) / MINUTE) }),
              )
              store.setSoonTold(e.id, e.start)
            }),
          )
        }
      }
      const first = upcoming.find((e) => sameDay(e.start, now))
      const next =
        first === undefined
          ? null
          : {
              event: first.id,
              title: first.title,
              start: first.start,
              end: first.end,
              location: first.location,
            }
      const key = JSON.stringify(next)
      if (key !== lastNext) {
        yield* pass.item(
          "next",
          Effect.gen(function* tellingNext() {
            yield* events.emit(Next.make({ next }))
            lastNext = key
          }),
        )
      }
      pass.done()
      lastTick = Date.now()
    })

    // Syncing

    /** Reads every source into the store, telling no one. */
    const pull = Effect.gen(function* pulling() {
      const out: Sync[] = []
      const known = yield* core.googleAccounts(google.SCOPE)
      heart.set("connections", known === null ? "Can't reach the core" : null)
      if (known !== null) {
        googles = known
        if (known.length === 0 && !asked) {
          asked = true
          yield* core.askForGoogle
        }
      }
      for (const account of googles) {
        const r = yield* Effect.exit(syncGoogle(account))
        if (r._tag === "Success") {
          out.push(...r.value)
        } else {
          out.push({
            calendar: `google:${account}`,
            name: account,
            provider: "google",
            account,
            events: 0,
            error: why(r.cause),
          })
        }
      }
      const failed = out.filter((s) => s.error !== undefined)
      heart.set(
        "calendars",
        failed.length === 0 ? null : failed.map((s) => `${s.name}: ${s.error ?? ""}`).join(", "),
      )
      return out
    })

    const sync = Effect.tap(pull, () => tell)

    // Whether it works

    const beat = (round: boolean) =>
      Effect.suspend(() => {
        const calendars = store.calendars().length
        let n = 0
        for (const c of store.counts()) {
          n += c.n
        }
        const failing = heart.failingParts()
        const line =
          failing.length === 0
            ? `${calendars} calendars, ${googles.length} accounts`
            : `failing: ${failing.join(", ")}`
        return heart.beat(round, { accounts: googles.length, calendars, events: n }, line)
      })

    /** One round of the sync loop: every source read and told, then the beat. */
    const syncRound = Effect.gen(function* syncing() {
      const error = yield* attempt(sync)
      heart.set("sync", error)
      const quiet = Date.now() - lastTick
      heart.set(
        "clock loop",
        quiet > 5 * MINUTE ? `no tick since ${new Date(lastTick).toISOString()}` : null,
      )
      yield* beat(true)
    })

    /** One round of the clock loop; a change in what's failing beats at once. */
    const tickRound = Effect.gen(function* ticking() {
      const error = yield* attempt(tick)
      if (error !== null) {
        heart.set("clock", error)
      }
      yield* beat(false)
    })

    // Writing

    // Just started, the first pull may have come before the core answered, leaving no accounts: a
    // call that finds no calendar asks the core for them again before it refuses.
    const resolveCalendar = (given: string | undefined) =>
      Effect.gen(function* resolving() {
        const want = (given ?? settings.calendar ?? "").toLowerCase()
        const pick = () => {
          const all = store.calendars().filter((c) => c.writable)
          return (
            all.find((c) => c.id.toLowerCase() === want) ??
            all.find((c) => c.name.toLowerCase() === want) ??
            (want === "" ? all.find((c) => c.primary && c.account === googles[0]) : undefined) ??
            null
          )
        }
        const found = pick()
        if (found !== null) {
          return found
        }
        googles = (yield* core.googleAccounts(google.SCOPE)) ?? googles
        return pick()
      })

    const find = (id: string) => {
      const s = store.get(id)
      return s === null ? Effect.fail(new Error(`No event ${id}`)) : Effect.succeed(s.event)
    }

    const logged = (
      kind: Write["kind"],
      calendar: Calendar,
      before: Event | null,
      after: Event | null,
      undoes: string | null,
    ) =>
      Effect.gen(function* logging() {
        const id = writeId()
        const eventId = after?.id ?? before?.id ?? ""
        store.logWrite({
          id,
          at: Date.now(),
          kind,
          calendar: calendar.id,
          event: eventId,
          before,
          after,
          undoes,
          undoneBy: null,
        })
        if (after !== null) {
          store.put(after)
        } else if (before !== null) {
          store.put({ ...before, status: "cancelled" })
        }
        writeOf.set(eventId, id)
        yield* tell
        return id
      })

    /** Held for the user: the write would email others, so an action item asks first. */
    const hold = (tool: string, args: unknown, what: string, who: readonly string[]) =>
      Effect.gen(function* holding() {
        const id = heldId()
        const r = yield* core.actionItem(
          `Send: ${what}`,
          `${what}. Google emails ${who.join(", ")}. Approve, and I send it (${id}).`,
        )
        const item = r !== null && typeof r.id === "string" ? r.id : null
        store.hold({ id, tool, args, item, summary: what })
        const held: Held = {
          held: id,
          item,
          why: `Emails ${who.join(", ")}: held until the user approves the action item`,
        }
        return held
      })

    /** A held write may go once the user closed its item as done. */
    const approvedArgs = (held: string, tool: string) =>
      Effect.gen(function* approving() {
        const h = store.held(held)
        if (h === null || h.tool !== tool) {
          return yield* Effect.fail(new Error(`Nothing held as ${held}`))
        }
        if (h.done_at !== null) {
          return yield* Effect.fail(new Error(`${held} was sent already`))
        }
        const ok = h.item !== null && (yield* core.itemDone(h.item))
        if (!ok) {
          return yield* Effect.fail(new Error("Not approved yet"))
        }
        store.heldDone(held)
        const args: unknown = JSON.parse(h.args)
        return args
      })

    const create = (input: {
      readonly calendar?: string
      readonly fields: Fields & {
        readonly title: string
        readonly start: number
        readonly end: number
      }
      readonly attendees?: readonly string[]
      readonly call?: boolean
      readonly approved?: boolean
      readonly undoes?: string
    }) =>
      Effect.gen(function* creating() {
        const calendar = yield* resolveCalendar(input.calendar)
        if (calendar === null) {
          return yield* Effect.fail(new Error(`No calendar ${input.calendar ?? ""} to write to`))
        }
        const guests = input.attendees ?? []
        if (guests.length > 0 && input.approved !== true) {
          return yield* hold(
            "create",
            input,
            `Invite to ${input.fields.title}, ${hhmm(input.fields.start)}`,
            guests,
          )
        }
        const made = yield* google.insert(
          calendar,
          { ...input.fields, attendees: guests, call: input.call === true },
          guests.length > 0,
        )
        const write = yield* logged(
          input.undoes === undefined ? "create" : "undo",
          calendar,
          null,
          made,
          input.undoes ?? null,
        )
        return { write, event: made }
      })

    /** An event from a line of text, as Google reads it; undone like create. */
    const quickAdd = (input: { readonly text: string; readonly calendar?: string }) =>
      Effect.gen(function* adding() {
        const calendar = yield* resolveCalendar(input.calendar)
        if (calendar === null) {
          return yield* Effect.fail(new Error(`No calendar ${input.calendar ?? ""} to write to`))
        }
        let made = yield* google.quickAdd(calendar, input.text)
        // Guests are create's, held for approval: any Google read from the text come off again, unemailed.
        if (others(made).length > 0) {
          made = yield* google.patch(calendar, made.id, { attendees: [] }, false)
        }
        const write = yield* logged("create", calendar, null, made, null)
        return { write, event: made }
      })

    const update = (input: {
      readonly id: string
      readonly fields: Fields
      readonly approved?: boolean
      readonly undoes?: string
    }) =>
      Effect.gen(function* updating() {
        const before = yield* find(input.id)
        const calendar = calendarOf(before.calendar)
        if (calendar === null || !calendar.writable) {
          return yield* Effect.fail(new Error(`${before.calendarName} is read-only`))
        }
        const guests = others(before).map((p) => p.email)
        if (before.organizer !== null && !before.organizer.self && guests.length > 0) {
          return yield* Effect.fail(
            new Error(`It's ${before.organizer.email}'s to change; answer it with rsvp`),
          )
        }
        let f = input.fields
        if (f.start !== undefined && f.end === undefined) {
          f = { ...f, end: f.start + (before.end - before.start) }
        }
        if (f.allDay === undefined && (f.start !== undefined || f.end !== undefined)) {
          f = { ...f, allDay: before.allDay }
        }
        if (guests.length > 0 && input.approved !== true) {
          return yield* hold("update", input, `Change ${before.title}`, guests)
        }
        const after = yield* google.patch(calendar, before.id, f, guests.length > 0)
        if (after.id !== before.id) {
          store.put({ ...before, status: "cancelled" })
        }
        const write = yield* logged(
          input.undoes === undefined ? "update" : "undo",
          calendar,
          before,
          after,
          input.undoes ?? null,
        )
        return { write, event: after }
      })

    const cancel = (input: {
      readonly id: string
      readonly approved?: boolean
      readonly undoes?: string
    }) =>
      Effect.gen(function* cancelling() {
        const before = yield* find(input.id)
        const calendar = calendarOf(before.calendar)
        if (calendar === null || !calendar.writable) {
          return yield* Effect.fail(new Error(`${before.calendarName} is read-only`))
        }
        const guests = others(before).map((p) => p.email)
        if (before.organizer !== null && !before.organizer.self && guests.length > 0) {
          return yield* Effect.fail(
            new Error(`It's ${before.organizer.email}'s; decline it with rsvp`),
          )
        }
        if (guests.length > 0 && input.approved !== true) {
          return yield* hold("cancel", input, `Cancel ${before.title}`, guests)
        }
        yield* google.remove(calendar, before.id, guests.length > 0)
        const write = yield* logged(
          input.undoes === undefined ? "cancel" : "undo",
          calendar,
          before,
          null,
          input.undoes ?? null,
        )
        return { write, cancelled: before.id }
      })

    const rsvp = (input: {
      readonly id: string
      readonly response: Response
      readonly notify?: boolean
      readonly approved?: boolean
      readonly undoes?: string
    }) =>
      Effect.gen(function* responding() {
        const before = yield* find(input.id)
        const calendar = calendarOf(before.calendar)
        if (calendar === null) {
          return yield* Effect.fail(new Error("Its calendar is gone"))
        }
        if (before.response === null) {
          return yield* Effect.fail(new Error("He isn't invited to it"))
        }
        const notify = input.notify === true
        if (notify && input.approved !== true) {
          const organizer = before.organizer?.email ?? "the organizer"
          return yield* hold("rsvp", input, `Answer ${before.title}: ${input.response}`, [
            organizer,
          ])
        }
        const after = yield* google.respond(calendar, before.id, input.response, notify)
        const write = yield* logged(
          input.undoes === undefined ? "rsvp" : "undo",
          calendar,
          before,
          after,
          input.undoes ?? null,
        )
        return { write, event: after }
      })

    /** Undoes a write (the latest not yet undone, if none is named) through the same paths. */
    const undo = (id: string | undefined) =>
      Effect.gen(function* undoing() {
        const w =
          id === undefined
            ? store.writes(200).find((x) => x.undoneBy === null && x.kind !== "undo")
            : store.write(id)
        if (w === undefined || w === null) {
          return yield* Effect.fail(new Error("Nothing to undo"))
        }
        if (w.undoneBy !== null) {
          return yield* Effect.fail(new Error(`${w.id} was undone already`))
        }
        const calendar = calendarOf(w.calendar)
        if (calendar === null) {
          return yield* Effect.fail(new Error("Its calendar is gone"))
        }
        if (w.before === null && w.after !== null) {
          return yield* cancel({ id: w.after.id, undoes: w.id })
        }
        if (w.before !== null && w.after === null) {
          const b = w.before
          // Google keeps a cancelled event: confirming it brings it back as it was.
          const after = yield* google.patch(
            calendar,
            b.id,
            { status: "confirmed" },
            others(b).length > 0,
          )
          const write = yield* logged("undo", calendar, b, after, w.id)
          return { write, event: after }
        }
        if (w.before !== null && w.after !== null) {
          const b = w.before
          if (w.kind === "rsvp" && b.response !== null) {
            return yield* rsvp({ id: w.after.id, response: b.response, undoes: w.id })
          }
          return yield* update({
            id: w.after.id,
            fields: {
              title: b.title,
              start: b.start,
              end: b.end,
              allDay: b.allDay,
              location: b.location,
              notes: b.notes,
              busy: b.busy,
            },
            undoes: w.id,
          })
        }
        return yield* Effect.fail(new Error("Nothing to undo"))
      })

    // Finding time

    const free = (input: {
      readonly from: number
      readonly to: number
      readonly minutes: number
      readonly dayStart: number
      readonly dayEnd: number
      readonly weekends: boolean
      readonly buffer: number
      readonly count: number
    }) => {
      const busy = merged(input.from, input.to)
        .filter(holds)
        .map((e) => [e.start - input.buffer * MINUTE, e.end + input.buffer * MINUTE] as const)
      const slots: { start: number; end: number }[] = []
      const day = new Date(input.from)
      day.setHours(0, 0, 0, 0)
      for (let d = day.getTime(); d < input.to && slots.length < input.count; d += DAY) {
        const date = new Date(d)
        const weekday = date.getDay()
        if (!input.weekends && (weekday === 0 || weekday === 6)) {
          continue
        }
        const open = new Date(d)
        open.setHours(Math.floor(input.dayStart), (input.dayStart % 1) * 60, 0, 0)
        const close = new Date(d)
        close.setHours(Math.floor(input.dayEnd), (input.dayEnd % 1) * 60, 0, 0)
        let at = Math.max(open.getTime(), input.from)
        // Start on a quarter hour.
        at = Math.ceil(at / (15 * MINUTE)) * 15 * MINUTE
        const end = Math.min(close.getTime(), input.to)
        const today = busy.filter(([s, e]) => s < end && e > at).toSorted((a, b) => a[0] - b[0])
        for (const [s, e] of today) {
          if (s - at >= input.minutes * MINUTE) {
            slots.push({ start: at, end: s })
          }
          at = Math.max(at, Math.ceil(e / (5 * MINUTE)) * 5 * MINUTE)
        }
        if (end - at >= input.minutes * MINUTE) {
          slots.push({ start: at, end })
        }
      }
      return slots.slice(0, input.count)
    }

    const status = () => ({
      calendars: store.calendars().map((c) => ({
        id: c.id,
        name: c.name,
        provider: c.provider,
        account: c.account,
        writable: c.writable,
        events: store.counts().find((x) => x.calendar === c.id)?.n ?? 0,
        synced: c.cursor !== null,
      })),
    })

    return {
      store,
      pull,
      sync,
      tick,
      syncRound,
      tickRound,
      merged,
      conflictsIn,
      create,
      quickAdd,
      update,
      cancel,
      rsvp,
      undo,
      free,
      status,
      approvedArgs,
      find,
    }
  })

export class Calendars extends Context.Service<
  Calendars,
  Effect.Success<ReturnType<typeof make>>
>()("switch/calendar/Calendars") {
  static readonly layer = (settings: Settings) => Layer.effect(Calendars, make(settings))

  /** Keeps every source in sync and the brain told, until the scope closes. */
  static readonly workers = Layer.effectDiscard(
    Effect.gen(function* working() {
      const c = yield* Calendars
      yield* Effect.forkScoped(Effect.repeat(c.syncRound, Schedule.spaced("1 minute")))
      yield* Effect.forkScoped(Effect.repeat(c.tickRound, Schedule.spaced("30 seconds")))
    }),
  )
}
