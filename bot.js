require("dotenv").config();

const fs = require("fs");
const path = require("path");
const qrcode = require("qrcode-terminal");
const cron = require("node-cron");
const { google } = require("googleapis");
const { Client, LocalAuth } = require("whatsapp-web.js");

const TIMEZONE = process.env.TIMEZONE || "Africa/Lagos";
const POST_HOUR = Number(process.env.POST_HOUR || 8);
const POST_MINUTE = Number(process.env.POST_MINUTE || 0);
const GROUP_ID_FROM_ENV = (process.env.WHATSAPP_GROUP_ID || "").trim();
const GROUP_NAME = (process.env.WHATSAPP_GROUP_NAME || "").trim();
const SPREADSHEET_ID = (process.env.GOOGLE_SHEET_ID || "").trim();
const PEOPLE_RANGE = process.env.PEOPLE_RANGE || "People!A:G";
const EVENTS_RANGE = process.env.EVENTS_RANGE || "Events!A:E";
const POST_MONTHLY_LIST = /^true$/i.test(process.env.POST_MONTHLY_LIST || "true");
const WELCOME_NEW_MEMBERS = /^true$/i.test(process.env.WELCOME_NEW_MEMBERS || "false");
const LOG_FILE = path.join(__dirname, "sent-log.json");

if (!SPREADSHEET_ID) {
  console.error("❌ GOOGLE_SHEET_ID is missing from .env");
  process.exit(1);
}

if (!GROUP_ID_FROM_ENV && !GROUP_NAME) {
  console.error("❌ Add WHATSAPP_GROUP_ID or WHATSAPP_GROUP_NAME to .env");
  process.exit(1);
}

const auth = new google.auth.GoogleAuth({
  keyFile:
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    path.join(__dirname, "service-account.json"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});

const sheets = google.sheets({ version: "v4", auth });

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: "celebration-bot",
    dataPath: path.join(__dirname, ".wwebjs_auth"),
  }),
  puppeteer: {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});

let targetGroupId = null;

function isActive(value) {
  if (value === undefined || value === null || String(value).trim() === "") return true;
  return ["yes", "y", "true", "1", "active"].includes(
    String(value).trim().toLowerCase()
  );
}

function clean(value) {
  return String(value ?? "").trim();
}

// Accepts DD/MM, DD/MM/YYYY, DD-MM, DD-MM-YYYY, or YYYY-MM-DD.
// For birthdays/anniversaries we only use day + month.
function parseDayMonth(value) {
  const s = clean(value);
  if (!s) return null;

  let match = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) {
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (validDayMonth(day, month)) return { day, month };
  }

  match = s.match(/^(\d{1,2})[\/-](\d{1,2})(?:[\/-]\d{2,4})?$/);
  if (match) {
    const day = Number(match[1]);
    const month = Number(match[2]);
    if (validDayMonth(day, month)) return { day, month };
  }

  return null;
}

// Events should be DD/MM/YYYY, DD-MM-YYYY, or YYYY-MM-DD.
function parseFullDate(value) {
  const s = clean(value);
  if (!s) return null;

  let match = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (validDate(year, month, day)) return { year, month, day };
  }

  match = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (match) {
    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = Number(match[3]);
    if (validDate(year, month, day)) return { year, month, day };
  }

  return null;
}

function validDayMonth(day, month) {
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function validDate(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() + 1 === month &&
    d.getUTCDate() === day
  );
}

function localToday() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const obj = {};
  for (const p of parts) {
    if (p.type !== "literal") obj[p.type] = Number(p.value);
  }
  return { year: obj.year, month: obj.month, day: obj.day };
}

function isoDate({ year, month, day }) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function prettyDayMonth(day, month) {
  const d = new Date(Date.UTC(2000, month - 1, day));
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(d);
}

function prettyFullDate({ year, month, day }) {
  const d = new Date(Date.UTC(year, month - 1, day));
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(d);
}

function daysUntilRecurring(day, month) {
  const today = localToday();
  const todayUtc = Date.UTC(today.year, today.month - 1, today.day);
  let targetYear = today.year;
  let targetUtc = Date.UTC(targetYear, month - 1, day);

  if (targetUtc < todayUtc) {
    targetYear += 1;
    targetUtc = Date.UTC(targetYear, month - 1, day);
  }

  return Math.round((targetUtc - todayUtc) / 86400000);
}

function daysUntilFullDate(date) {
  const today = localToday();
  const todayUtc = Date.UTC(today.year, today.month - 1, today.day);
  const targetUtc = Date.UTC(date.year, date.month - 1, date.day);
  return Math.round((targetUtc - todayUtc) / 86400000);
}

function parseReminderDays(value) {
  const s = clean(value);
  if (!s) return [7, 1, 0];
  return s
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isInteger(x) && x >= 0);
}

function loadSentLog() {
  try {
    return JSON.parse(fs.readFileSync(LOG_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveSentLog(log) {
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function hasSent(key) {
  const log = loadSentLog();
  return Boolean(log[key]);
}

function markSent(key) {
  const log = loadSentLog();
  log[key] = new Date().toISOString();

  // Keep the file from growing forever: retain only the latest 2,000 entries.
  const entries = Object.entries(log);
  const trimmed = entries.slice(-2000);
  saveSentLog(Object.fromEntries(trimmed));
}

async function readRange(range) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range,
    valueRenderOption: "FORMATTED_VALUE",
  });
  return response.data.values || [];
}

async function getPeople() {
  const rows = await readRange(PEOPLE_RANGE);
  if (rows.length < 2) return [];

  // People columns:
  // A Name
  // B Birthday
  // C Anniversary
  // D WhatsAppNumber (optional)
  // E Active
  // F BirthdayMessage (optional)
  // G AnniversaryMessage (optional)
  return rows.slice(1).map((row) => ({
    name: clean(row[0]),
    birthdayRaw: clean(row[1]),
    anniversaryRaw: clean(row[2]),
    whatsappNumber: clean(row[3]).replace(/\D/g, ""),
    active: isActive(row[4]),
    birthdayMessage: clean(row[5]),
    anniversaryMessage: clean(row[6]),
  })).filter((p) => p.name && p.active);
}

async function getEvents() {
  const rows = await readRange(EVENTS_RANGE);
  if (rows.length < 2) return [];

  // Events columns:
  // A Event
  // B Date
  // C ReminderDays  e.g. 7,1,0
  // D Active
  // E Message (optional)
  return rows.slice(1).map((row) => ({
    event: clean(row[0]),
    dateRaw: clean(row[1]),
    reminderDays: parseReminderDays(row[2]),
    active: isActive(row[3]),
    message: clean(row[4]),
  })).filter((e) => e.event && e.active);
}

function defaultBirthdayMessage(name) {
  return [
    `🎉🎂 *HAPPY BIRTHDAY ${name.toUpperCase()}!* 🎂🎉`,
    "",
    `Today we celebrate you, ${name}! 🥳`,
    "",
    "May this new year bring you happiness, favour, good health and many more reasons to smile. ❤️",
    "",
    `Everyone, please help us celebrate ${name}! 🎊🎈`,
  ].join("\n");
}

function defaultAnniversaryMessage(name) {
  return [
    "💍❤️ *HAPPY ANNIVERSARY!* ❤️💍",
    "",
    `Today we celebrate ${name}.`,
    "Wishing you many more beautiful years of love, joy and wonderful memories together. 🥂✨",
    "",
    "Everyone, please help us celebrate them! 🎉",
  ].join("\n");
}

async function send(text) {
  if (!targetGroupId) throw new Error("Target group has not been resolved.");
  return client.sendMessage(targetGroupId, text);
}

async function 	resolveTargetGroup() {
if (GROUP_ID_FROM_ENV) {
  targetGroupId = GROUP_ID_FROM_ENV;
  console.log(`✅ Target group ID: ${targetGroupId}`);
  return;
}
  const chats = await client.getChats();
  const matches = chats.filter(
    (chat) => chat.isGroup && chat.name.trim().toLowerCase() === GROUP_NAME.toLowerCase()
  );

  if (matches.length === 0) {
    throw new Error(
      `Could not find group named "${GROUP_NAME}". Run "npm run groups" to list group names and IDs.`
    );
  }

  if (matches.length > 1) {
    throw new Error(
      `More than one group is named "${GROUP_NAME}". Run "npm run groups" and set WHATSAPP_GROUP_ID instead.`
    );
  }

  targetGroupId = matches[0].id._serialized;
  console.log(`✅ Target group: ${matches[0].name} (${targetGroupId})`);
}

async function postDailyCelebrations() {
  const today = localToday();
  const todayIso = isoDate(today);
  const people = await getPeople();

  for (const person of people) {
    const birthday = parseDayMonth(person.birthdayRaw);
    if (birthday && birthday.day === today.day && birthday.month === today.month) {
      const key = `birthday|${person.name}|${todayIso}`;
      if (!hasSent(key)) {
        await send(person.birthdayMessage || defaultBirthdayMessage(person.name));
        markSent(key);
        console.log(`🎂 Birthday posted for ${person.name}`);
      }
    }

    const anniversary = parseDayMonth(person.anniversaryRaw);
    if (
      anniversary &&
      anniversary.day === today.day &&
      anniversary.month === today.month
    ) {
      const key = `anniversary|${person.name}|${todayIso}`;
      if (!hasSent(key)) {
        await send(
          person.anniversaryMessage || defaultAnniversaryMessage(person.name)
        );
        markSent(key);
        console.log(`💍 Anniversary posted for ${person.name}`);
      }
    }
  }
}

async function postEventReminders() {
  const events = await getEvents();
  const today = localToday();

  for (const item of events) {
    const date = parseFullDate(item.dateRaw);
    if (!date) {
      console.warn(`⚠️ Skipping event with invalid date: ${item.event} (${item.dateRaw})`);
      continue;
    }

    const daysLeft = daysUntilFullDate(date);
    if (daysLeft < 0 || !item.reminderDays.includes(daysLeft)) continue;

    const key = `event|${item.event}|${isoDate(date)}|${daysLeft}`;
    if (hasSent(key)) continue;

    let text = item.message;
    if (!text) {
      if (daysLeft === 0) {
        text = [
          "📅🎉 *EVENT TODAY!*",
          "",
          `*${item.event}*`,
          prettyFullDate(date),
          "",
          "Don't forget! 🔔",
        ].join("\n");
      } else if (daysLeft === 1) {
        text = [
          "⏰ *EVENT REMINDER*",
          "",
          `*${item.event}* is tomorrow — ${prettyFullDate(date)}.`,
          "",
          "See you there! 🎉",
        ].join("\n");
      } else {
        text = [
          "⏰ *EVENT REMINDER*",
          "",
          `*${item.event}* is in ${daysLeft} days.`,
          prettyFullDate(date),
          "",
          "Save the date! 📌",
        ].join("\n");
      }
    }

    await send(text);
    markSent(key);
    console.log(`📅 Event reminder posted: ${item.event} (${daysLeft} days)`);
  }
}

async function postMonthlyBirthdayList() {
  if (!POST_MONTHLY_LIST) return;

  const today = localToday();
  if (today.day !== 1) return;

  const key = `monthly-birthdays|${today.year}-${String(today.month).padStart(2, "0")}`;
  if (hasSent(key)) return;

  const people = await getPeople();
  const birthdays = people
    .map((p) => ({ ...p, date: parseDayMonth(p.birthdayRaw) }))
    .filter((p) => p.date && p.date.month === today.month)
    .sort((a, b) => a.date.day - b.date.day);

  if (!birthdays.length) return;

  const monthName = new Intl.DateTimeFormat("en-GB", {
    month: "long",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(2000, today.month - 1, 1)));

  const lines = birthdays.map(
    (p) => `🎂 ${String(p.date.day).padStart(2, "0")} ${monthName} — ${p.name}`
  );

  const text = [
    `🎉 *${monthName.toUpperCase()} CELEBRANTS* 🎉`,
    "",
    ...lines,
    "",
    "Let's make sure we celebrate everyone! 🥳❤️",
  ].join("\n");

  await send(text);
  markSent(key);
  console.log(`🗓️ Monthly birthday list posted for ${monthName}`);
}

async function runDailyJobs() {
  console.log(`\n⏰ Running daily checks at ${new Date().toISOString()}`);
  try {
    await postDailyCelebrations();
    await postEventReminders();
    await postMonthlyBirthdayList();
  } catch (error) {
    console.error("❌ Daily job failed:", error.message);
  }
}

async function upcomingBirthdays(limit = 10) {
  const people = await getPeople();
  return people
    .map((p) => ({
      name: p.name,
      date: parseDayMonth(p.birthdayRaw),
    }))
    .filter((p) => p.date)
    .map((p) => ({
      ...p,
      days: daysUntilRecurring(p.date.day, p.date.month),
    }))
    .sort((a, b) => a.days - b.days || a.name.localeCompare(b.name))
    .slice(0, limit);
}

async function upcomingAnniversaries(limit = 10) {
  const people = await getPeople();
  return people
    .map((p) => ({
      name: p.name,
      date: parseDayMonth(p.anniversaryRaw),
    }))
    .filter((p) => p.date)
    .map((p) => ({
      ...p,
      days: daysUntilRecurring(p.date.day, p.date.month),
    }))
    .sort((a, b) => a.days - b.days || a.name.localeCompare(b.name))
    .slice(0, limit);
}

async function upcomingEvents(limit = 10) {
  const events = await getEvents();
  return events
    .map((e) => ({ ...e, date: parseFullDate(e.dateRaw) }))
    .filter((e) => e.date)
    .map((e) => ({ ...e, days: daysUntilFullDate(e.date) }))
    .filter((e) => e.days >= 0)
    .sort((a, b) => a.days - b.days)
    .slice(0, limit);
}

client.on("qr", (qr) => {
  console.log("\n📱 Scan this QR code in WhatsApp → Settings → Linked devices → Link a device\n");
  qrcode.generate(qr, { small: true });
});

client.on("authenticated", () => {
  console.log("🔐 WhatsApp authenticated.");
});

client.on("auth_failure", (message) => {
  console.error("❌ WhatsApp authentication failed:", message);
});

client.on("disconnected", (reason) => {
  console.error("⚠️ WhatsApp disconnected:", reason);
});

client.on("ready", async () => {
  try {
    console.log("🤖 WhatsApp Celebration Bot is online.");
await resolveTargetGroup();
    const expression = `${POST_MINUTE} ${POST_HOUR} * * *`;
    cron.schedule(expression, runDailyJobs, {
      timezone: TIMEZONE,
      name: "daily-celebration-check",
      noOverlap: true,
    });

    console.log(
      `🕗 Daily check scheduled for ${String(POST_HOUR).padStart(2, "0")}:${String(POST_MINUTE).padStart(2, "0")} (${TIMEZONE}).`
    );
    console.log("💬 Commands: !help, !birthdays, !anniversaries, !events, !ping");
    console.log("🧪 To test today's data immediately, type !runcheck in the target group.");
  } catch (error) {
    console.error("❌ Startup error:", error.message);
  }
});

client.on("message_create", async (message) => {
  if (!targetGroupId) return;

  const chatId = message.fromMe ? message.to : message.from;
  if (chatId !== targetGroupId) return;

  const body = clean(message.body).toLowerCase();
  try {
    if (body === "!ping") {
      await message.reply("🤖 Bot is online!");
      return;
    }

    if (body === "!help") {
      await message.reply(
        [
          "🤖 *CELEBRATION BOT COMMANDS*",
          "",
          "!birthdays — upcoming birthdays",
          "!anniversaries — upcoming anniversaries",
          "!events — upcoming events",
          "!ping — check whether the bot is online",
          "!runcheck — run today's scheduled checks now",
        ].join("\n")
      );
      return;
    }

    if (body === "!birthday" || body.startsWith("!birthday ")) {
  const query = clean(message.body.slice("!birthday".length));

  if (!query) {
    await message.reply(
      [
        "🎂 *BIRTHDAY SEARCH*",
        "",
        "Use one of these:",
        "!birthday today",
        "!birthday tomorrow",
        "!birthday 26/08",
        "!birthday Toluwani",
      ].join("\n")
    );
    return;
  }

  const people = await getPeople();
  const today = localToday();

  let targetDay = null;
  let targetMonth = null;
  let dateLabel = "";

  // TODAY
  if (query.toLowerCase() === "today") {
    targetDay = today.day;
    targetMonth = today.month;
    dateLabel = "today";
  }

  // TOMORROW
  else if (query.toLowerCase() === "tomorrow") {
    const tomorrow = new Date(
      Date.UTC(today.year, today.month - 1, today.day + 1)
    );

    targetDay = tomorrow.getUTCDate();
    targetMonth = tomorrow.getUTCMonth() + 1;
    dateLabel = "tomorrow";
  }

  // DATE — e.g. 26/08
  else {
    const parsedDate = parseDayMonth(query);

    if (parsedDate) {
      targetDay = parsedDate.day;
      targetMonth = parsedDate.month;
      dateLabel = prettyDayMonth(targetDay, targetMonth);
    }
  }

  // If the query was a date / today / tomorrow
  if (targetDay !== null && targetMonth !== null) {
    const matches = people
      .map((person) => ({
        ...person,
        birthday: parseDayMonth(person.birthdayRaw),
      }))
      .filter(
        (person) =>
          person.birthday &&
          person.birthday.day === targetDay &&
          person.birthday.month === targetMonth
      );

    if (!matches.length) {
      await message.reply(
        `🎂 No birthdays found for ${dateLabel}.`
      );
      return;
    }

    const text = [
      `🎂 *BIRTHDAYS — ${dateLabel.toUpperCase()}*`,
      "",
      ...matches.map((person) => `🎉 ${person.name}`),
    ].join("\n");

    await message.reply(text);
    return;
  }

  // Otherwise treat the query as a person's name
  const nameQuery = query.toLowerCase();

  const matches = people.filter((person) =>
    person.name.toLowerCase().includes(nameQuery)
  );

  if (!matches.length) {
    await message.reply(
      `🔎 I couldn't find anyone matching "${query}".`
    );
    return;
  }

  const lines = matches.map((person) => {
    const birthday = parseDayMonth(person.birthdayRaw);

    if (!birthday) {
      return `⚠️ ${person.name} — birthday not listed`;
    }

    const days = daysUntilRecurring(
      birthday.day,
      birthday.month
    );

    const when =
      days === 0
        ? "today"
        : days === 1
        ? "tomorrow"
        : `in ${days} days`;

    return `🎂 *${person.name}*\n📅 ${prettyDayMonth(
      birthday.day,
      birthday.month
    )}\n⏳ ${when}`;
  });

  await message.reply(lines.join("\n\n"));
  return;
}
if (body === "!birthdays") {
      const items = await upcomingBirthdays();
      const text = items.length
        ? [
            "🎂 *UPCOMING BIRTHDAYS*",
            "",
            ...items.map((p) => {
              const when =
                p.days === 0 ? "today" : p.days === 1 ? "tomorrow" : `in ${p.days} days`;
              return `🎉 ${prettyDayMonth(p.date.day, p.date.month)} — ${p.name} (${when})`;
            }),
          ].join("\n")
        : "No birthdays are currently listed.";
      await message.reply(text);
      return;
    }

    if (body === "!anniversaries") {
      const items = await upcomingAnniversaries();
      const text = items.length
        ? [
            "💍 *UPCOMING ANNIVERSARIES*",
            "",
            ...items.map((p) => {
              const when =
                p.days === 0 ? "today" : p.days === 1 ? "tomorrow" : `in ${p.days} days`;
              return `❤️ ${prettyDayMonth(p.date.day, p.date.month)} — ${p.name} (${when})`;
            }),
          ].join("\n")
        : "No anniversaries are currently listed.";
      await message.reply(text);
      return;
    }

    if (body === "!events") {
      const items = await upcomingEvents();
      const text = items.length
        ? [
            "📅 *UPCOMING EVENTS*",
            "",
            ...items.map((e) => {
              const when =
                e.days === 0 ? "today" : e.days === 1 ? "tomorrow" : `in ${e.days} days`;
              return `📌 ${e.event} — ${prettyFullDate(e.date)} (${when})`;
            }),
          ].join("\n")
        : "No upcoming events are currently listed.";
      await message.reply(text);
      return;
    }

    if (body === "!runcheck") {
      await message.reply("🔎 Running today's birthday, anniversary and event checks now...");
      await runDailyJobs();
      await message.reply("✅ Check completed.");
      return;
    }
  } catch (error) {
    console.error("❌ Command failed:", error);
    await message.reply("⚠️ I couldn't complete that command. Check the bot terminal for details.");
  }
});

client.on("group_join", async (notification) => {
  if (!WELCOME_NEW_MEMBERS) return;
  if (!targetGroupId || notification.chatId !== targetGroupId) return;

  try {
    const count = notification.recipientIds?.length || 1;
    await notification.reply(
      count > 1
        ? "👋 Welcome to the group! We're happy to have you all here. 🎉"
        : "👋 Welcome to the group! We're happy to have you here. 🎉"
    );
  } catch (error) {
    console.error("⚠️ Welcome message failed:", error.message);
  }
});

client.initialize();
