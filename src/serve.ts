// Calendar's layers, and serving it on stdio, syncing.
import { Layer } from "effect"
import { AppEvents, serveStdio } from "switch-ext-kit"

import { calendarApp } from "./app.ts"
import { Calendars } from "./calendars.ts"
import { loadSettings } from "./settings.ts"

export const calendarLayer = () =>
  Layer.provideMerge(Calendars.layer(loadSettings()), AppEvents.layer(calendarApp))

/** Serves Calendar on stdio, syncing, until the client goes. */
export const serveCalendar = async () => {
  await serveStdio(
    calendarApp,
    Layer.provideMerge(Calendars.workers, Calendars.layer(loadSettings())),
  )
}
