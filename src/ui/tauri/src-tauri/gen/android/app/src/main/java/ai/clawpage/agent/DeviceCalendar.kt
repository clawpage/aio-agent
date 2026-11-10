package ai.clawpage.agent

import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.provider.CalendarContract.Calendars
import android.provider.CalendarContract.Events
import android.provider.CalendarContract.Instances
import org.json.JSONArray
import org.json.JSONObject
import java.text.ParsePosition
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone

// The phone's calendars for the agent (docs/EXEC-ENVS.md, capability `calendar`), answering what the iPhone
// app answers for the same tools (DeviceTools.swift): the calendars, the events between two times, and a new
// event. Through the system's calendar provider, with READ_CALENDAR and WRITE_CALENDAR, which Android asks
// for when the person turns the calendar on in the console.

class ToolError(val code: String, override val message: String) : Exception(message)

/** ISO 8601 dates and date-times as the tools take them, and as they give them back (the phone's time zone). */
object Dates {
  class Parsed(val ms: Long, val dateOnly: Boolean)

  private fun format(pattern: String, zone: TimeZone = TimeZone.getDefault()) =
    SimpleDateFormat(pattern, Locale.US).apply { timeZone = zone; isLenient = false }

  private fun whole(f: SimpleDateFormat, text: String): Date? {
    val at = ParsePosition(0)
    val date = f.parse(text, at)
    return if (date != null && at.index == text.length) date else null
  }

  /** An ISO 8601 date (dateOnly, the start of that day here) or date-time; without an offset, this phone's time zone. */
  fun parse(raw: Any?, field: String): Parsed? {
    val text = (raw as? String)?.trim().orEmpty()
    if (text.isEmpty()) return null
    if (text.length == 10) whole(format("yyyy-MM-dd"), text)?.let { return Parsed(it.time, true) }
    for (pattern in listOf("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", "yyyy-MM-dd'T'HH:mm:ssXXX", "yyyy-MM-dd'T'HH:mmXXX",
      "yyyy-MM-dd'T'HH:mm:ss.SSS", "yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd HH:mm")) {
      whole(format(pattern), text)?.let { return Parsed(it.time, false) }
    }
    throw ToolError("invalid", "$field is not an ISO 8601 date or date-time: $text")
  }

  /** The end of a range: a date alone means the end of that day. */
  fun end(parsed: Parsed): Long = if (parsed.dateOnly) nextDay(parsed.ms) else parsed.ms

  private fun nextDay(ms: Long): Long = Calendar.getInstance().apply { timeInMillis = ms; add(Calendar.DAY_OF_MONTH, 1) }.timeInMillis

  fun string(ms: Long): String = format("yyyy-MM-dd'T'HH:mm:ssXXX").format(Date(ms))

  /** The same calendar day, here, of a UTC midnight (how the provider keeps all-day events). */
  fun localDay(utcMidnight: Long): Long {
    val utc = Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply { timeInMillis = utcMidnight }
    return Calendar.getInstance().apply {
      clear()
      set(utc.get(Calendar.YEAR), utc.get(Calendar.MONTH), utc.get(Calendar.DAY_OF_MONTH))
    }.timeInMillis
  }

  /** The UTC midnight of the calendar day a local time falls on. */
  fun utcDay(localMs: Long): Long {
    val local = Calendar.getInstance().apply { timeInMillis = localMs }
    return Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply {
      clear()
      set(local.get(Calendar.YEAR), local.get(Calendar.MONTH), local.get(Calendar.DAY_OF_MONTH))
    }.timeInMillis
  }
}

fun intArg(args: JSONObject, key: String, default: Int, max: Int): Int =
  if (args.opt(key) is Number) args.getInt(key).coerceIn(0, max) else default

fun clip(text: String?, length: Int): Any =
  if (text.isNullOrEmpty()) JSONObject.NULL else if (text.length > length) text.take(length) + "…" else text

object DeviceCalendar {
  private lateinit var context: Context

  fun init(context: Context) { this.context = context.applicationContext }

  private val resolver get() = context.contentResolver

  private inline fun <T> Cursor?.each(read: (Cursor) -> T): List<T> = this?.use { c -> buildList { while (c.moveToNext()) add(read(c)) } } ?: emptyList()

  private class Info(val id: Long, val title: String, val account: String, val writable: Boolean, val primary: Boolean)

  private fun calendars(): List<Info> = resolver.query(
    Calendars.CONTENT_URI,
    arrayOf(Calendars._ID, Calendars.CALENDAR_DISPLAY_NAME, Calendars.ACCOUNT_NAME, Calendars.CALENDAR_ACCESS_LEVEL, Calendars.IS_PRIMARY),
    null, null, Calendars._ID,
  ).each { c ->
    Info(c.getLong(0), c.getString(1).orEmpty(), c.getString(2).orEmpty(), c.getInt(3) >= Calendars.CAL_ACCESS_CONTRIBUTOR, c.getInt(4) == 1)
  }

  /** Where a new event goes when none is named: the primary calendar one can write to, else the first writable one. */
  private fun fallback(all: List<Info>): Info? = all.firstOrNull { it.writable && it.primary } ?: all.firstOrNull { it.writable }

  private fun named(raw: Any?, all: List<Info>): Info? {
    val id = (raw as? String)?.takeIf { it.isNotEmpty() } ?: return null
    return all.firstOrNull { it.id.toString() == id } ?: throw ToolError("not_found", "no calendar $id")
  }

  fun list(): JSONObject {
    val all = calendars()
    val default = fallback(all)
    val out = JSONArray()
    for (c in all) out.put(JSONObject().put("id", c.id.toString()).put("title", c.title).put("account", c.account).put("writable", c.writable).put("default", c.id == default?.id))
    return JSONObject().put("calendars", out)
  }

  private fun describe(id: Long, title: String?, start: Long, end: Long, allDay: Boolean, location: String?, notes: String?, calendar: String?, calendarId: Long): JSONObject {
    // All-day events are kept from UTC midnight to UTC midnight; given back as the iPhone does: that day here, to its last second.
    val from = if (allDay) Dates.localDay(start) else start
    val to = if (allDay) Dates.localDay(end) - 1000 else end
    return JSONObject().put("id", id.toString()).put("title", title.orEmpty()).put("start", Dates.string(from)).put("end", Dates.string(to)).put("all_day", allDay)
      .put("location", clip(location, 200)).put("notes", clip(notes, 500)).put("calendar", calendar.orEmpty()).put("calendar_id", calendarId.toString())
  }

  fun events(args: JSONObject): JSONObject {
    val from = Dates.parse(args.opt("from"), "from")
    val to = Dates.parse(args.opt("to"), "to")
    if (from == null || to == null) throw ToolError("invalid", "from and to are required")
    val end = Dates.end(to)
    if (end <= from.ms || end - from.ms > 366L * 86_400_000) throw ToolError("invalid", "the range must be positive and at most 366 days")
    val calendar = named(args.opt("calendar_id"), calendars())
    val found = Instances.query(
      resolver,
      arrayOf(Instances.EVENT_ID, Instances.TITLE, Instances.BEGIN, Instances.END, Instances.ALL_DAY, Instances.EVENT_LOCATION, Instances.DESCRIPTION, Instances.CALENDAR_DISPLAY_NAME, Instances.CALENDAR_ID),
      from.ms, end,
    ).each { c ->
      c.getLong(2) to describe(c.getLong(0), c.getString(1), c.getLong(2), c.getLong(3), c.getInt(4) == 1, c.getString(5), c.getString(6), c.getString(7), c.getLong(8))
    }.filter { calendar == null || it.second.getString("calendar_id") == calendar.id.toString() }.sortedBy { it.first }
    val limit = intArg(args, "limit", 100, 300)
    return JSONObject().put("events", JSONArray(found.take(limit).map { it.second })).put("total", found.size)
  }

  fun create(args: JSONObject): JSONObject {
    val title = args.optString("title", "").trim()
    if (title.isEmpty()) throw ToolError("invalid", "title is required")
    val start = Dates.parse(args.opt("start"), "start") ?: throw ToolError("invalid", "start is required")
    val all = calendars()
    val calendar = named(args.opt("calendar_id"), all) ?: fallback(all) ?: throw ToolError("not_found", "no calendar")
    if (!calendar.writable) throw ToolError("invalid", "calendar ${calendar.title} is read-only")
    val allDay = if (args.opt("all_day") is Boolean) args.getBoolean("all_day") else start.dateOnly
    val end = Dates.parse(args.opt("end"), "end")
    val values = ContentValues().apply {
      put(Events.CALENDAR_ID, calendar.id)
      put(Events.TITLE, title)
      if (args.optString("location").isNotEmpty()) put(Events.EVENT_LOCATION, args.getString("location"))
      if (args.optString("notes").isNotEmpty()) put(Events.DESCRIPTION, args.getString("notes"))
      if (allDay) {
        // The provider wants all-day events in UTC, from midnight to the midnight after the last day.
        val first = Dates.utcDay(start.ms)
        val last = if (end == null) first else Dates.utcDay(if (end.dateOnly) end.ms else end.ms)
        if (last < first) throw ToolError("invalid", "end is before start")
        put(Events.ALL_DAY, 1)
        put(Events.EVENT_TIMEZONE, "UTC")
        put(Events.DTSTART, first)
        put(Events.DTEND, last + 86_400_000)
      } else {
        val until = end?.let { Dates.end(it) } ?: (start.ms + 3_600_000)
        if (until < start.ms) throw ToolError("invalid", "end is before start")
        put(Events.EVENT_TIMEZONE, TimeZone.getDefault().id)
        put(Events.DTSTART, start.ms)
        put(Events.DTEND, until)
      }
    }
    val uri = resolver.insert(Events.CONTENT_URI, values) ?: throw ToolError("failed", "the calendar did not take the event")
    val id = ContentUris.parseId(uri)
    return describe(id, title, values.getAsLong(Events.DTSTART), values.getAsLong(Events.DTEND), allDay,
      values.getAsString(Events.EVENT_LOCATION), values.getAsString(Events.DESCRIPTION), calendar.title, calendar.id)
  }
}
