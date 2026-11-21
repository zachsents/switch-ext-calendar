// The extension's own state, in SQLite: calendars and their sync cursors, every event, what the
// brain has been told, and the write log that undo reads.
import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { Schema } from "effect"

import { event } from "./model.ts"
import type { Calendar, Event } from "./model.ts"

const SCHEMA = `
CREATE TABLE IF NOT EXISTS calendars (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, account TEXT NOT NULL, remote TEXT NOT NULL,
  name TEXT NOT NULL, color TEXT, writable INTEGER NOT NULL, is_primary INTEGER NOT NULL,
  cursor TEXT, synced_at INTEGER, gone INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, calendar TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL,
  status TEXT NOT NULL, body TEXT NOT NULL,
  -- The payload the brain last got for it, or null: it hasn't been told.
  told TEXT,
  invite_told INTEGER NOT NULL DEFAULT 0, soon_told INTEGER);
CREATE INDEX IF NOT EXISTS events_when ON events (start, end);
CREATE INDEX IF NOT EXISTS events_calendar ON events (calendar);
CREATE TABLE IF NOT EXISTS conflicts (pair TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS writes (
  id TEXT PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, calendar TEXT NOT NULL,
  event TEXT NOT NULL, before TEXT, after TEXT, undoes TEXT, undone_by TEXT);
CREATE TABLE IF NOT EXISTS held (
  id TEXT PRIMARY KEY, at INTEGER NOT NULL, tool TEXT NOT NULL, args TEXT NOT NULL,
  item TEXT, summary TEXT NOT NULL, done_at INTEGER);
`

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(event))

interface CalendarRow {
  readonly id: string
  readonly provider: "google"
  readonly account: string
  readonly remote: string
  readonly name: string
  readonly color: string | null
  readonly writable: number
  readonly is_primary: number
  readonly cursor: string | null
}

interface EventRow {
  readonly body: string
  readonly told: string | null
  readonly invite_told: number
  readonly soon_told: number | null
}

export interface Stored {
  readonly event: Event
  readonly told: string | null
  readonly inviteTold: boolean
  readonly soonTold: number | null
}

export interface Write {
  readonly id: string
  readonly at: number
  readonly kind: "create" | "update" | "cancel" | "rsvp" | "undo"
  readonly calendar: string
  readonly event: string
  readonly before: Event | null
  readonly after: Event | null
  readonly undoes: string | null
  readonly undoneBy: string | null
}

interface WriteRow {
  readonly id: string
  readonly at: number
  readonly kind: Write["kind"]
  readonly calendar: string
  readonly event: string
  readonly before: string | null
  readonly after: string | null
  readonly undoes: string | null
  readonly undone_by: string | null
}

const toCalendar = (r: CalendarRow): Calendar & { readonly cursor: string | null } => ({
  id: r.id,
  provider: r.provider,
  account: r.account,
  remote: r.remote,
  name: r.name,
  color: r.color,
  writable: r.writable === 1,
  primary: r.is_primary === 1,
  cursor: r.cursor,
})

const toWrite = (r: WriteRow): Write => ({
  id: r.id,
  at: r.at,
  kind: r.kind,
  calendar: r.calendar,
  event: r.event,
  before: r.before === null ? null : decodeEvent(r.before),
  after: r.after === null ? null : decodeEvent(r.after),
  undoes: r.undoes,
  undoneBy: r.undone_by,
})

export const openStore = (file: string) => {
  if (file !== ":memory:") {
    mkdirSync(path.dirname(file), { recursive: true })
  }
  const db = new Database(file, { create: true })
  db.run("PRAGMA journal_mode = WAL")
  db.run(SCHEMA)
  // Apple's calendars were read once; they're not any more, so what was kept of them goes.
  db.run(
    "DELETE FROM events WHERE calendar IN (SELECT id FROM calendars WHERE provider != 'google')",
  )
  db.run("DELETE FROM calendars WHERE provider != 'google'")

  const calendars = () =>
    db
      .query<CalendarRow, []>(
        "SELECT * FROM calendars WHERE gone = 0 ORDER BY provider, account, name",
      )
      .all()
      .map(toCalendar)

  const putCalendar = (c: Calendar) => {
    db.query(
      `INSERT INTO calendars (id, provider, account, remote, name, color, writable, is_primary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, color = excluded.color,
         writable = excluded.writable, is_primary = excluded.is_primary, gone = 0`,
    ).run(
      c.id,
      c.provider,
      c.account,
      c.remote,
      c.name,
      c.color,
      c.writable ? 1 : 0,
      c.primary ? 1 : 0,
    )
  }

  /** Calendars of a source no longer listed: gone, with their events. */
  const dropCalendars = (provider: string, account: string, keep: readonly string[]) => {
    const all = db
      .query<{ id: string }, [string, string]>(
        "SELECT id FROM calendars WHERE provider = ? AND account = ? AND gone = 0",
      )
      .all(provider, account)
    return all.filter((c) => !keep.includes(c.id)).map((c) => c.id)
  }

  const setCursor = (calendar: string, cursor: string | null) => {
    db.query("UPDATE calendars SET cursor = ?, synced_at = ? WHERE id = ?").run(
      cursor,
      Date.now(),
      calendar,
    )
  }

  /** A calendar no longer read: it and its events go. */
  const markGone = (calendar: string) => {
    db.query("UPDATE calendars SET gone = 1, cursor = NULL WHERE id = ?").run(calendar)
    db.query("DELETE FROM events WHERE calendar = ?").run(calendar)
  }

  const get = (id: string): Stored | null => {
    const r = db
      .query<EventRow, [string]>(
        "SELECT body, told, invite_told, soon_told FROM events WHERE id = ?",
      )
      .get(id)
    return r === null
      ? null
      : {
          event: decodeEvent(r.body),
          told: r.told,
          inviteTold: r.invite_told === 1,
          soonTold: r.soon_told,
        }
  }

  const put = (e: Event) => {
    db.query(
      `INSERT INTO events (id, calendar, start, end, status, body) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET start = excluded.start, end = excluded.end,
         status = excluded.status, body = excluded.body`,
    ).run(e.id, e.calendar, e.start, e.end, e.status, JSON.stringify(e))
  }

  const remove = (id: string) => {
    db.query("DELETE FROM events WHERE id = ?").run(id)
  }

  const idsOf = (calendar: string) =>
    db
      .query<{ id: string }, [string]>("SELECT id FROM events WHERE calendar = ?")
      .all(calendar)
      .map((r) => r.id)

  const setTold = (id: string, told: string | null) => {
    db.query("UPDATE events SET told = ? WHERE id = ?").run(told, id)
  }

  const setInviteTold = (id: string) => {
    db.query("UPDATE events SET invite_told = 1 WHERE id = ?").run(id)
  }

  const setSoonTold = (id: string, start: number) => {
    db.query("UPDATE events SET soon_told = ? WHERE id = ?").run(start, id)
  }

  /** Events overlapping [from, to), soonest first, cancelled ones left out unless asked. */
  const between = (from: number, to: number, cancelled = false): Stored[] =>
    db
      .query<EventRow, [number, number]>(
        `SELECT body, told, invite_told, soon_told FROM events WHERE start < ? AND end > ?
         ${cancelled ? "" : "AND status != 'cancelled'"} ORDER BY start, end`,
      )
      .all(to, from)
      .map((r) => ({
        event: decodeEvent(r.body),
        told: r.told,
        inviteTold: r.invite_told === 1,
        soonTold: r.soon_told,
      }))

  /** Told the brain, but now outside [from, to) or gone: what to take back. */
  const toldOutside = (from: number, to: number) =>
    db
      .query<{ id: string }, [number, number]>(
        "SELECT id FROM events WHERE told IS NOT NULL AND (start >= ? OR end <= ?)",
      )
      .all(to, from)
      .map((r) => r.id)

  const counts = () =>
    db
      .query<{ calendar: string; n: number }, []>(
        "SELECT calendar, count(*) AS n FROM events WHERE status != 'cancelled' GROUP BY calendar",
      )
      .all()

  const conflictSeen = (pair: string) =>
    db.query("SELECT pair FROM conflicts WHERE pair = ?").get(pair) !== null

  const addConflict = (pair: string) => {
    db.query("INSERT OR IGNORE INTO conflicts (pair, at) VALUES (?, ?)").run(pair, Date.now())
  }

  const logWrite = (w: Write) => {
    db.query(
      "INSERT INTO writes (id, at, kind, calendar, event, before, after, undoes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      w.id,
      w.at,
      w.kind,
      w.calendar,
      w.event,
      w.before === null ? null : JSON.stringify(w.before),
      w.after === null ? null : JSON.stringify(w.after),
      w.undoes,
    )
    if (w.undoes !== null) {
      db.query("UPDATE writes SET undone_by = ? WHERE id = ?").run(w.id, w.undoes)
    }
  }

  const writes = (limit: number) =>
    db
      .query<WriteRow, [number]>("SELECT * FROM writes ORDER BY at DESC LIMIT ?")
      .all(limit)
      .map(toWrite)

  const write = (id: string) => {
    const r = db.query<WriteRow, [string]>("SELECT * FROM writes WHERE id = ?").get(id)
    return r === null ? null : toWrite(r)
  }

  const hold = (h: {
    readonly id: string
    readonly tool: string
    readonly args: unknown
    readonly item: string | null
    readonly summary: string
  }) => {
    db.query("INSERT INTO held (id, at, tool, args, item, summary) VALUES (?, ?, ?, ?, ?, ?)").run(
      h.id,
      Date.now(),
      h.tool,
      JSON.stringify(h.args),
      h.item,
      h.summary,
    )
  }

  const held = (id: string) =>
    db
      .query<
        {
          id: string
          tool: string
          args: string
          item: string | null
          summary: string
          done_at: number | null
        },
        [string]
      >("SELECT id, tool, args, item, summary, done_at FROM held WHERE id = ?")
      .get(id)

  const heldDone = (id: string) => {
    db.query("UPDATE held SET done_at = ? WHERE id = ?").run(Date.now(), id)
  }

  return {
    db,
    calendars,
    putCalendar,
    dropCalendars,
    setCursor,
    markGone,
    get,
    put,
    remove,
    idsOf,
    setTold,
    setInviteTold,
    setSoonTold,
    between,
    toldOutside,
    counts,
    conflictSeen,
    addConflict,
    logWrite,
    writes,
    write,
    hold,
    held,
    heldDone,
  }
}

export type Store = ReturnType<typeof openStore>
