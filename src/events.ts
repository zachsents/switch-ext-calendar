// What Calendar tells the brain. Only events from a day back to two months ahead are told; one
// that comes into that span later is told then.
import { defineEvent } from "switch-ext-kit"
import { Schema } from "effect"

import { Heartbeat } from "./heartbeat.ts"
import { event } from "./model.ts"

/** Set when Switch made the change: the write's id, which `undo` takes. */
const write = { write: Schema.optionalKey(Schema.String) }

export const EventCreated = defineEvent(
  "calendar.event.created",
  1,
  Schema.Struct({
    event,
    /** Read on the first sync, not newly made. */
    initial: Schema.optionalKey(Schema.Boolean),
    ...write,
  }),
)

export const EventChanged = defineEvent(
  "calendar.event.changed",
  1,
  Schema.Struct({ event, changes: Schema.Array(Schema.String), ...write }),
)

export const EventCancelled = defineEvent(
  "calendar.event.cancelled",
  1,
  Schema.Struct({ event, ...write }),
)

/** Someone else's invite, waiting on the user's answer. */
export const InviteReceived = defineEvent("calendar.invite.received", 1, Schema.Struct({ event }))

export const StartingSoon = defineEvent(
  "calendar.starting_soon",
  1,
  Schema.Struct({ event, minutes: Schema.Finite }),
)

/** Two events that hold the same time. */
export const Conflict = defineEvent(
  "calendar.conflict",
  1,
  Schema.Struct({ events: Schema.Array(event) }),
)

/** The next meeting changed. Null: nothing left today. */
export const Next = defineEvent(
  "calendar.next",
  1,
  Schema.Struct({
    next: Schema.NullOr(
      Schema.Struct({
        event: Schema.String,
        title: Schema.String,
        start: Schema.Finite,
        end: Schema.Finite,
        location: Schema.NullOr(Schema.String),
      }),
    ),
  }),
)

export const calendarEvents = [
  EventCreated,
  EventChanged,
  EventCancelled,
  InviteReceived,
  StartingSoon,
  Conflict,
  Next,
  Heartbeat,
]
