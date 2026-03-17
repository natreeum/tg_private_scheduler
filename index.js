require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");

const BOT_TOKEN = process.env.BOT_TOKEN;
const TIMEZONE = process.env.TIMEZONE || "Asia/Seoul";

if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN is not set");
}

const bot = new TelegramBot(BOT_TOKEN, {
  polling: {
    params: {
      allowed_updates: ["message"],
    },
  },
  request: { agentOptions: { keepAlive: true, family: 4 } },
});

const DATA_FILE = path.join(__dirname, "data.json");

function ensureDataFile() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify({ events: [] }, null, 2),
      "utf8"
    );
  }
}

function readDb() {
  ensureDataFile();
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function writeDb(db) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), "utf8");
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function makeEventId() {
  return `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function escapeHtml(str = "") {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 본문 예시:
 * 3/20 방탄소년단 6년만에 정규앨범 복귀
 *
 * 하이브 움직임 체크
 */
function parseScheduleMessage(text) {
  if (!text || typeof text !== "string") return null;

  const trimmed = text.trim();
  const lines = trimmed.split("\n");
  if (!lines.length) return null;

  lines.shift(); // 명령어 줄 제거

  const firstLine = lines[0].trim();

  const match = firstLine.match(/^(\d{1,2})\s*\/\s*(\d{1,2})\s+(.+)$/);
  if (!match) return null;

  const month = Number(match[1]);
  const day = Number(match[2]);
  const headline = match[3].trim();
  const note = lines.slice(1).join("\n").trim();

  if (!month || !day || !headline) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  return { month, day, headline, note };
}

function resolveTargetDate(month, day) {
  const now = new Date();
  const currentYear = now.getFullYear();

  let target = new Date(currentYear, month - 1, day);

  if (
    target.getFullYear() !== currentYear ||
    target.getMonth() !== month - 1 ||
    target.getDate() !== day
  ) {
    return null;
  }

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (target < today) {
    target = new Date(currentYear + 1, month - 1, day);

    if (
      target.getFullYear() !== currentYear + 1 ||
      target.getMonth() !== month - 1 ||
      target.getDate() !== day
    ) {
      return null;
    }
  }

  return target;
}

function formatDateKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(
    date.getDate()
  )}`;
}

function formatDisplayDate(date) {
  return `${date.getMonth() + 1}월 ${date.getDate()}일`;
}

function buildTelegramMessageLink(msg) {
  const chat = msg.chat;
  const messageId = msg.message_id;

  if (!chat || !messageId) return null;

  // 공개 그룹(username 있음)
  if (chat.username) {
    return `https://t.me/${chat.username}/${messageId}`;
  }

  // 비공개 supergroup/channel
  if (
    (chat.type === "supergroup" || chat.type === "channel") &&
    String(chat.id).startsWith("-100")
  ) {
    const internalId = String(chat.id).replace("-100", "");
    return `https://t.me/c/${internalId}/${messageId}`;
  }

  return null;
}

function isGroupChat(chat) {
  return chat && (chat.type === "group" || chat.type === "supergroup");
}

function compareEventsByDateAsc(a, b) {
  if (a.dateKey !== b.dateKey) {
    return a.dateKey.localeCompare(b.dateKey);
  }

  // 같은 날짜면 생성순으로 안정 정렬
  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
}

/**
 * D-day 계산
 * 오늘이면 D-Day
 * 미래면 D-3
 * 과거면 D+2
 */
function getDdayLabel(dateKey) {
  const today = new Date();
  const todayStart = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate()
  );

  const [year, month, day] = dateKey.split("-").map(Number);
  const target = new Date(year, month - 1, day);

  const diffMs = target.getTime() - todayStart.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "D-Day";
  if (diffDays > 0) return `D-${diffDays}`;
  return `D+${Math.abs(diffDays)}`;
}

/**
 * 지난 일정 삭제
 * 오늘보다 이전 dateKey 삭제
 */
function removePastEvents() {
  const db = readDb();

  const now = new Date();
  const today = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    now.getHours() + 9 // 9시간 보정 (UTC -> KST)
  );
  const todayKey = formatDateKey(today);

  const beforeCount = db.events.length;

  db.events = db.events.filter((event) => event.dateKey >= todayKey);
  db.events.sort(compareEventsByDateAsc);

  writeDb(db);

  const removedCount = beforeCount - db.events.length;
  return removedCount;
}

function saveEvent(event) {
  const db = readDb();

  // 같은 그룹, 같은 원본 메시지면 중복 저장 방지
  const exists = db.events.some(
    (e) =>
      e.chatId === event.chatId && e.sourceMessageId === event.sourceMessageId
  );

  if (exists) return false;

  db.events.push(event);

  // 날짜 오름차순 정렬
  db.events.sort(compareEventsByDateAsc);

  writeDb(db);
  return true;
}

function getAllChatIds() {
  const db = readDb();
  return [...new Set(db.events.map((e) => e.chatId))];
}

function getUpcomingEventsForChat(chatId) {
  const db = readDb();

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayKey = formatDateKey(today);

  return db.events
    .filter((e) => e.chatId === chatId && e.dateKey >= todayKey)
    .sort(compareEventsByDateAsc);
}

function buildSummaryMessage(events) {
  if (!events.length) {
    return "등록된 예정 일정이 없습니다.";
  }

  const lines = ["<b>📌 일정 모음</b>", ""];

  for (const event of events) {
    const dday = getDdayLabel(event.dateKey);

    let line =
      `[${events.indexOf(event) + 1}] ${escapeHtml(event.displayDate)} ` +
      `[${escapeHtml(dday)}] ` +
      `${escapeHtml(event.headline)}`;

    lines.push(line);

    if (event.note) {
      lines.push(`  └ ${escapeHtml(event.note)}`);
    }

    if (event.sourceLink) {
      lines.push(`👉 <a href="${event.sourceLink}">메세지 원본</a>`);
    }

    lines.push("");
  }

  return lines.join("\n").trim();
}

bot.on("message", async (msg) => {
  try {
    if (!msg.text) return;

    const chat = msg.chat;
    const text = msg.text.trim();

    if (!isGroupChat(chat)) return;

    if (text === "!목록") {
      const events = getUpcomingEventsForChat(chat.id);

      await bot.sendMessage(chat.id, buildSummaryMessage(events), {
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
      return;
    }

    if (text.startsWith("!등록")) {
      const parsed = parseScheduleMessage(text);

      if (!parsed) {
        await bot.sendMessage(
          chat.id,
          "등록 형식이 올바르지 않습니다.\n예시:\n!등록\n3/20 방탄소년단 6년만에 정규앨범 복귀\n\n하이브 움직임 체크",
          {
            reply_to_message_id: msg.message_id,
          }
        );
        return;
      }

      const targetDate = resolveTargetDate(parsed.month, parsed.day);
      if (!targetDate) {
        await bot.sendMessage(chat.id, "날짜 형식을 해석하지 못했습니다.", {
          reply_to_message_id: msg.message_id,
        });
        return;
      }

      const event = {
        id: makeEventId(),
        chatId: chat.id,
        chatTitle: chat.title || "",
        chatType: chat.type,
        dateKey: formatDateKey(targetDate),
        displayDate: formatDisplayDate(targetDate),
        headline: parsed.headline,
        note: parsed.note,
        originalText: text,
        sourceMessageId: msg.message_id,
        sourceLink: buildTelegramMessageLink(msg),
        senderId: msg.from?.id || null,
        createdAt: new Date().toISOString(),
      };

      const saved = saveEvent(event);

      if (!saved) return;

      await bot.sendMessage(
        chat.id,
        [
          "일정을 등록했습니다.",
          `- 날짜: ${event.displayDate}`,
          `- 디데이: ${getDdayLabel(event.dateKey)}`,
          `- 제목: ${event.headline}`,
        ].join("\n"),
        {
          reply_to_message_id: msg.message_id,
        }
      );
    }

    if (text.startsWith("!삭제 ")) {
      // 명령어 이후 본문만 파싱
      const idxInput = Number(text.slice("!삭제 ".length).trim()) - 1;

      const dbRaw = readDb();

      const channelEvents = getUpcomingEventsForChat(chat.id);
      const eventToDelete = channelEvents[idxInput];

      let eventIdx = -1;
      for (let i = 0; i < dbRaw.events.length; i++) {
        if (dbRaw.events[i].id === eventToDelete.id) {
          eventIdx = i;
          break;
        }
      }

      if (eventIdx < 0 || dbRaw.events.length <= eventIdx) {
        await bot.sendMessage(chat.id, "삭제할 일정을 찾을 수 없습니다.", {
          reply_to_message_id: msg.message_id,
        });
        return;
      }

      dbRaw.events.splice(eventIdx, 1);
      writeDb(dbRaw);

      await bot.sendMessage(chat.id, "일정을 삭제했습니다.", {
        reply_to_message_id: msg.message_id,
      });
    }
  } catch (error) {
    console.error("message handler error:", error);
  }
});

// 매일 오전 08:00 그룹별 일정 발송
cron.schedule(
  "0 8,22 * * *",
  async () => {
    try {
      // 지난 일정 먼저 정리
      const removedCount = removePastEvents();
      console.log(`[cleanup] removed ${removedCount} past event(s)`);

      const chatIds = getAllChatIds();

      for (const chatId of chatIds) {
        const events = getUpcomingEventsForChat(chatId);
        if (!events.length) continue;

        await bot.sendMessage(chatId, buildSummaryMessage(events), {
          parse_mode: "HTML",
          disable_web_page_preview: true,
        });
      }
    } catch (error) {
      console.error("cron error:", error);
    }
  },
  { timezone: TIMEZONE }
);

console.log("Bot is running...");
