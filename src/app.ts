// Calendar as an extension: every Google calendar in one, synced both ways. Its tools read, find
// time and write; its events tell the brain what changed; its widgets are an agenda and an event
// card for chat.
import { Effect, Schema } from "effect"

import { BASIC_CATALOG, defineApp, SWITCH_CATALOG, tool } from "switch-ext-kit"
import { Calendars } from "./calendars.ts"
import * as google from "./google.ts"
import type { Fields } from "./calendars.ts"
import {
  calendarEvents,
  EventCancelled,
  EventChanged,
  EventCreated,
  Next,
  StartingSoon,
} from "./events.ts"
import { awaiting, holds, others, response } from "./model.ts"
import type { Event } from "./model.ts"

const MINUTE = 60_000
const DAY = 86_400_000

/** A time as an agent gives it: ISO, or ms. */
const time = Schema.Union([Schema.String, Schema.Finite])
const toMs = (t: string | number) => (typeof t === "number" ? t : Date.parse(t))
const at = (t: string | number | undefined, fallback: number) => {
  if (t === undefined) {
    return Effect.succeed(fallback)
  }
  const ms = toMs(t)
  return Number.isNaN(ms)
    ? Effect.fail(new Error(`Can't read the time ${String(t)}`))
    : Effect.succeed(ms)
}

const iso = (ms: number) => new Date(ms).toISOString()
const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(" ", " ")
const weekday = (ms: number) => new Date(ms).toLocaleDateString("en-US", { weekday: "short" })
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString()
const startOfDay = (ms: number) => {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** An event as tools give it: times in ISO, the rest as it is. */
const shown = (e: Event & { readonly also?: readonly string[] }) => ({
  ...e,
  start: iso(e.start),
  end: iso(e.end),
})

const list = tool(
  "list",
  {
    description:
      "Events on every calendar in a span (default: now through 7 days), soonest first, the same meeting once. `query` matches title, place, notes and people.",
    readOnly: true,
    input: Schema.Struct({
      from: Schema.optionalKey(time),
      to: Schema.optionalKey(time),
      query: Schema.optionalKey(Schema.String),
      calendar: Schema.optionalKey(Schema.String),
    }),
  },
  (input) =>
    Effect.gen(function* listing() {
      const c = yield* Calendars
      const from = yield* at(input.from, Date.now())
      const to = yield* at(input.to, from + 7 * DAY)
      const q = input.query?.toLowerCase()
      const events = c.merged(from, to).filter((e) => {
        if (
          input.calendar !== undefined &&
          e.calendar !== input.calendar &&
          e.calendarName !== input.calendar
        ) {
          return false
        }
        if (q === undefined) {
          return true
        }
        const text = [
          e.title,
          e.location,
          e.notes,
          ...e.attendees.flatMap((p) => [p.email, p.name]),
        ]
          .join(" ")
          .toLowerCase()
        return text.includes(q)
      })
      return { events: events.map(shown) }
    }),
)

const free = tool(
  "free",
  {
    description:
      "Free times that fit across every calendar: stretches of at least `minutes` between `dayStart` and `dayEnd` (hours, local; default 9–18) on weekdays unless `weekends`, with `buffer` minutes kept around each event.",
    readOnly: true,
    input: Schema.Struct({
      minutes: Schema.Finite,
      from: Schema.optionalKey(time),
      to: Schema.optionalKey(time),
      dayStart: Schema.optionalKey(Schema.Finite),
      dayEnd: Schema.optionalKey(Schema.Finite),
      weekends: Schema.optionalKey(Schema.Boolean),
      buffer: Schema.optionalKey(Schema.Finite),
      count: Schema.optionalKey(Schema.Finite),
    }),
  },
  (input) =>
    Effect.gen(function* finding() {
      const c = yield* Calendars
      const from = yield* at(input.from, Date.now())
      const to = yield* at(input.to, from + 7 * DAY)
      const slots = c.free({
        from,
        to,
        minutes: input.minutes,
        dayStart: input.dayStart ?? 9,
        dayEnd: input.dayEnd ?? 18,
        weekends: input.weekends ?? false,
        buffer: input.buffer ?? 0,
        count: input.count ?? 10,
      })
      return { slots: slots.map((s) => ({ start: iso(s.start), end: iso(s.end) })) }
    }),
)

const conflicts = tool(
  "conflicts",
  {
    description: "Events that hold the same time, across calendars (default: the next 14 days).",
    readOnly: true,
    input: Schema.Struct({ from: Schema.optionalKey(time), to: Schema.optionalKey(time) }),
  },
  (input) =>
    Effect.gen(function* finding() {
      const c = yield* Calendars
      const from = yield* at(input.from, Date.now())
      const to = yield* at(input.to, from + 14 * DAY)
      return { conflicts: c.conflictsIn(from, to).map(([a, b]) => [shown(a), shown(b)]) }
    }),
)

const fieldsInput = {
  title: Schema.optionalKey(Schema.String),
  start: Schema.optionalKey(time),
  end: Schema.optionalKey(time),
  /** Length, when there's no end. */
  minutes: Schema.optionalKey(Schema.Finite),
  allDay: Schema.optionalKey(Schema.Boolean),
  location: Schema.optionalKey(Schema.NullOr(Schema.String)),
  notes: Schema.optionalKey(Schema.NullOr(Schema.String)),
  busy: Schema.optionalKey(Schema.Boolean),
}

const readFields = (input: {
  readonly title?: string
  readonly start?: string | number
  readonly end?: string | number
  readonly minutes?: number
  readonly allDay?: boolean
  readonly location?: string | null
  readonly notes?: string | null
  readonly busy?: boolean
}) =>
  Effect.gen(function* reading() {
    const out: { -readonly [K in keyof Fields]: Fields[K] } = {}
    if (input.title !== undefined) {
      out.title = input.title
    }
    if (input.start !== undefined) {
      out.start = yield* at(input.start, 0)
    }
    if (input.end !== undefined) {
      out.end = yield* at(input.end, 0)
    } else if (input.minutes !== undefined && out.start !== undefined) {
      out.end = out.start + input.minutes * MINUTE
    }
    if (input.allDay !== undefined) {
      out.allDay = input.allDay
    }
    if (input.location !== undefined) {
      out.location = input.location
    }
    if (input.notes !== undefined) {
      out.notes = input.notes
    }
    if (input.busy !== undefined) {
      out.busy = input.busy
    }
    return out
  })

/** `approved`: a held write's id, sent once the user approved its action item. */
const approved = { approved: Schema.optionalKey(Schema.String) }

const createInput = Schema.Struct({
  ...fieldsInput,
  title: Schema.String,
  start: time,
  calendar: Schema.optionalKey(Schema.String),
  /** Guests' emails. Inviting anyone is held for the user's approval first. */
  attendees: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Add a Google Meet link. */
  call: Schema.optionalKey(Schema.Boolean),
  ...approved,
})

const create = tool(
  "create",
  {
    description:
      "Put an event on a calendar (default: the user's own Google calendar): title, start, and end or minutes (an hour if neither). Guests are emailed, so with `attendees` it's held as an action item until the user approves, then sent with `approved`.",
    input: createInput,
  },
  (input) =>
    Effect.gen(function* creating() {
      const c = yield* Calendars
      const given =
        input.approved === undefined
          ? input
          : Schema.decodeUnknownSync(createInput)(yield* c.approvedArgs(input.approved, "create"))
      const f = yield* readFields(given)
      const start = f.start ?? 0
      const end = f.end ?? start + (f.allDay === true ? DAY : 60 * MINUTE)
      const r = yield* c.create({
        ...(given.calendar === undefined ? {} : { calendar: given.calendar }),
        fields: { ...f, title: given.title, start, end },
        ...(given.attendees === undefined ? {} : { attendees: given.attendees }),
        ...(given.call === undefined ? {} : { call: given.call }),
        approved: input.approved !== undefined,
      })
      return "event" in r ? { write: r.write, event: shown(r.event) } : r
    }),
)

const quickAdd = tool(
  "quick_add",
  {
    description:
      'Put an event on a Google calendar from a line of text, as Google reads it, like "Lunch at Cafe Rio tomorrow 12:30" (default calendar: the user\'s own Google one). Emails no one; for guests use create.',
    input: Schema.Struct({ text: Schema.String, calendar: Schema.optionalKey(Schema.String) }),
  },
  (input) =>
    Effect.gen(function* adding() {
      const c = yield* Calendars
      const r = yield* c.quickAdd({
        text: input.text,
        ...(input.calendar === undefined ? {} : { calendar: input.calendar }),
      })
      return { write: r.write, event: shown(r.event) }
    }),
)

const updateInput = Schema.Struct({ id: Schema.String, ...fieldsInput, ...approved })

const update = tool(
  "update",
  {
    description:
      "Change an event: retitle it, move it (a new start keeps its length), change where or what. One with guests is held for the user's approval first, since Google emails them.",
    input: updateInput,
  },
  (input) =>
    Effect.gen(function* updating() {
      const c = yield* Calendars
      const given =
        input.approved === undefined
          ? input
          : Schema.decodeUnknownSync(updateInput)(yield* c.approvedArgs(input.approved, "update"))
      const fields = yield* readFields(given)
      const r = yield* c.update({ id: given.id, fields, approved: input.approved !== undefined })
      return "event" in r ? { write: r.write, event: shown(r.event) } : r
    }),
)

const cancelInput = Schema.Struct({ id: Schema.String, ...approved })

const cancel = tool(
  "cancel",
  {
    description:
      "Cancel an event the user organizes (someone else's invite is declined with rsvp instead). One with guests is held for the user's approval first.",
    input: cancelInput,
  },
  (input) =>
    Effect.gen(function* cancelling() {
      const c = yield* Calendars
      const given =
        input.approved === undefined
          ? input
          : Schema.decodeUnknownSync(cancelInput)(yield* c.approvedArgs(input.approved, "cancel"))
      return yield* c.cancel({ id: given.id, approved: input.approved !== undefined })
    }),
)

const rsvpInput = Schema.Struct({
  id: Schema.String,
  response,
  /** Email the organizer too: held for the user's approval first. */
  notify: Schema.optionalKey(Schema.Boolean),
  ...approved,
})

const rsvp = tool(
  "rsvp",
  {
    description:
      "Answer an invite: accepted, declined or tentative. The organizer sees it on their calendar; `notify` emails them too, after the user approves.",
    input: rsvpInput,
  },
  (input) =>
    Effect.gen(function* responding() {
      const c = yield* Calendars
      const given =
        input.approved === undefined
          ? input
          : Schema.decodeUnknownSync(rsvpInput)(yield* c.approvedArgs(input.approved, "rsvp"))
      const r = yield* c.rsvp({
        id: given.id,
        response: given.response,
        ...(given.notify === undefined ? {} : { notify: given.notify }),
        approved: input.approved !== undefined,
      })
      return "event" in r ? { write: r.write, event: shown(r.event) } : r
    }),
)

const undo = tool(
  "undo",
  {
    description: "Undo a write (by its id; default the latest not yet undone).",
    input: Schema.Struct({ write: Schema.optionalKey(Schema.String) }),
  },
  (input) =>
    Effect.gen(function* undoing() {
      const c = yield* Calendars
      const r = yield* c.undo(input.write)
      return "event" in r ? { write: r.write, event: shown(r.event) } : r
    }),
)

const writes = tool(
  "writes",
  {
    description: "Every write Switch made to a calendar, newest first, with what it was before.",
    readOnly: true,
    input: Schema.Struct({ limit: Schema.optionalKey(Schema.Finite) }),
  },
  (input) =>
    Effect.gen(function* reading() {
      const c = yield* Calendars
      return {
        writes: c.store.writes(Math.min(500, input.limit ?? 50)).map((w) => ({
          ...w,
          at: iso(w.at),
          before: w.before === null ? null : shown(w.before),
          after: w.after === null ? null : shown(w.after),
        })),
      }
    }),
)

const sync = tool(
  "sync",
  { description: "Read every calendar for changes now: each calendar with its event count." },
  () =>
    Effect.gen(function* syncing() {
      const c = yield* Calendars
      return { calendars: yield* c.sync }
    }),
)

const status = tool(
  "status",
  {
    description: "The calendars: each one's source, whether it can be written, and its events.",
    readOnly: true,
  },
  () =>
    Effect.gen(function* reading() {
      const c = yield* Calendars
      return c.status()
    }),
)

// Widgets' data

const row = (e: Event, now: number, conflicted: ReadonlySet<string>) => ({
  id: e.id,
  time: (() => {
    const t = e.allDay ? "Day" : clock(e.start)
    return sameDay(e.start, now) ? t : `${weekday(e.start)} ${t}`
  })(),
  title: e.title,
  running: e.start <= now && e.end > now && !e.allDay,
  needsYou: awaiting(e, now),
  conflict: conflicted.has(e.id),
})

const agenda = tool(
  "agenda",
  {
    description: "Today's events still to come, or the next one if today is done.",
    readOnly: true,
  },
  () =>
    Effect.gen(function* reading() {
      const c = yield* Calendars
      const now = Date.now()
      const today = c
        .merged(now, startOfDay(now) + DAY)
        .filter((e) => e.status !== "cancelled" && e.response !== "declined")
      const conflicted = new Set(c.conflictsIn(now, now + DAY).flatMap(([a, b]) => [a.id, b.id]))
      const rows = today.map((e) => row(e, now, conflicted))
      let day = "Today"
      if (rows.length === 0) {
        const next = c
          .merged(now, now + 30 * DAY)
          .find((e) => e.status !== "cancelled" && e.response !== "declined" && !e.allDay)
        if (next !== undefined) {
          rows.push(row(next, now, conflicted))
          day = "Next"
        }
      }
      // Nothing at all: only the empty word, no heading over it.
      const empty = rows.length === 0
      return { day: empty ? "" : day, rows, empty: empty ? "Clear" : "" }
    }),
)

const get = tool(
  "get",
  {
    description:
      "One event in full (default: the next one): when, where, the call, who's coming and their answers.",
    readOnly: true,
    input: Schema.Struct({ id: Schema.optionalKey(Schema.String) }),
  },
  (input) =>
    Effect.gen(function* reading() {
      const c = yield* Calendars
      const now = Date.now()
      const e: Event | undefined =
        input.id === undefined
          ? c.merged(now, now + 30 * DAY).find((x) => holds(x) && x.end > now)
          : yield* c.find(input.id)
      if (e === undefined) {
        return { title: "Nothing next", fields: [], people: [] }
      }
      const span = e.allDay
        ? new Date(e.start).toLocaleDateString("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric",
          })
        : `${weekday(e.start)} ${clock(e.start)}–${clock(e.end)}`
      const answer = {
        accepted: "Yes",
        declined: "No",
        tentative: "Maybe",
        needsAction: "",
      } as const
      const fields = [
        { label: "When", value: span },
        ...(e.location === null ? [] : [{ label: "Where", value: e.location }]),
        ...(e.call === null ? [] : [{ label: "Call", value: e.call.replace(/^https?:\/\//u, "") }]),
        { label: "Calendar", value: e.calendarName },
      ]
      const people = others(e).map((p) => ({ label: p.name || p.email, value: answer[p.status] }))
      return {
        id: e.id,
        title: e.title,
        needsYou: awaiting(e, now),
        fields,
        people,
        event: shown(e),
      }
    }),
)

const changed = [EventCreated.type, EventChanged.type, EventCancelled.type]

export const calendarApp = defineApp<Calendars>({
  name: "calendar",
  version: "1",
  connections: [
    { provider: "google", scopes: [google.SCOPE], multiple: true, legacy: "switch-calendar" },
  ],
  instructions:
    "Every Google calendar of the user's in one, synced both ways: the providers hold the truth, writes go to them and each can be undone. Anything that would email someone else (guests, cancellations, RSVP notes) is held as an action item until the user approves.",
  tools: [
    list,
    agenda,
    get,
    free,
    conflicts,
    create,
    quickAdd,
    update,
    cancel,
    rsvp,
    undo,
    writes,
    sync,
    status,
  ],
  events: calendarEvents,
  widgets: [
    {
      name: "agenda",
      title: "Agenda",
      surfaces: ["space"],
      resource: "ui://calendar/agenda",
      size: {
        aspect: "tall",
        min: { cols: 3, rows: 4 },
        preferred: { cols: 4, rows: 6 },
        grows: true,
      },
      tool: "agenda",
      refresh: [...changed, Next.type, StartingSoon.type],
      // Today's lines: the time, the live marks, the title. When today is done, the next one.
      a2ui: () => [
        { version: "1.0", createSurface: { surfaceId: "agenda", catalogId: SWITCH_CATALOG } },
        {
          version: "1.0",
          updateComponents: {
            surfaceId: "agenda",
            components: [
              {
                id: "root",
                component: "Column",
                catalogId: BASIC_CATALOG,
                children: ["head", "rows", "empty"],
              },
              {
                id: "head",
                component: "Text",
                catalogId: BASIC_CATALOG,
                text: {
                  "@call": "formatString",
                  catalogId: BASIC_CATALOG,
                  args: { value: `# \${/day}` },
                },
              },
              {
                id: "rows",
                component: "List",
                catalogId: BASIC_CATALOG,
                children: { componentId: "row", path: "/rows" },
              },
              {
                id: "row",
                component: "Slot",
                time: { "@path": "time" },
                title: { "@path": "title" },
                running: { "@path": "running" },
                needsYou: { "@path": "needsYou" },
                conflict: { "@path": "conflict" },
              },
              {
                id: "empty",
                component: "Text",
                catalogId: BASIC_CATALOG,
                text: { "@path": "/empty" },
                variant: "caption",
              },
            ],
          },
        },
      ],
    },
    {
      name: "event",
      title: "Event",
      surfaces: ["chat"],
      resource: "ui://calendar/event",
      tool: "get",
      refresh: changed,
      // An event: its title, then a line each for when, where, the call and its calendar, then who.
      a2ui: () => [
        { version: "1.0", createSurface: { surfaceId: "event", catalogId: SWITCH_CATALOG } },
        {
          version: "1.0",
          updateComponents: {
            surfaceId: "event",
            components: [
              {
                id: "root",
                component: "Column",
                catalogId: BASIC_CATALOG,
                children: ["title", "fields", "people"],
              },
              {
                id: "title",
                component: "Title",
                label: { "@path": "/title" },
                needsYou: { "@path": "/needsYou" },
              },
              {
                id: "fields",
                component: "List",
                catalogId: BASIC_CATALOG,
                children: { componentId: "field", path: "/fields" },
              },
              {
                id: "people",
                component: "List",
                catalogId: BASIC_CATALOG,
                children: { componentId: "field", path: "/people" },
              },
              {
                id: "field",
                component: "Field",
                label: { "@path": "label" },
                value: { "@path": "value" },
              },
            ],
          },
        },
      ],
    },
  ],
})
