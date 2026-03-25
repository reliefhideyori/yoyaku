// ============================================================
//  予約フォーム — Google Apps Script バックエンド
//  設定は CONFIG オブジェクトのみ編集してください
// ============================================================

const CONFIG = {
  CALENDAR_ID:        'primary',        // カレンダーID（primary = メインカレンダー）
  BUSINESS_START:     9,                // 営業開始時刻（時）
  BUSINESS_END:       21,               // 営業終了時刻（時）
  SLOT_INCREMENT_MINUTES: 30,           // スロットの刻み幅（分）
  TIMEZONE:           'Asia/Tokyo',
  MAX_DURATION:       3,                // 最大予約時間（時間）

  // ===== Twilio SMS 設定 =====
  // 利用する場合は以下4項目を入力し、SMS_ENABLED を true に変更してください
  TWILIO_ACCOUNT_SID: '',               // Account SID（ACxxxxxxxxxxxxxxxxxx）
  TWILIO_AUTH_TOKEN:  '',               // Auth Token
  TWILIO_FROM_NUMBER: '',               // 送信元番号（例: +8150XXXXXXXX）
  SMS_ENABLED:        false,            // true にすると実際にSMSを送信します
  REMINDER_HOUR:      9                 // 当日リマインド送信時刻（時）
};

// ============================================================
//  GET: 空き枠一覧取得
//  パラメータ: ?date=YYYY-MM-DD&duration=N
// ============================================================
function doGet(e) {
  try {
    // ?month=YYYY-MM の場合は月単位の空き状況を返す
    if (e.parameter.month) {
      const duration = parseInt(e.parameter.duration) || 1;
      return getMonthAvailability(e.parameter.month, duration);
    }

    const date     = e.parameter.date;
    const duration = parseInt(e.parameter.duration);

    if (!date || !duration || isNaN(duration) || ![1, 2, 3].includes(duration)) {
      return jsonResponse({ error: 'invalid_params' });
    }

    const slots    = generateSlots(date, duration);
    const busyList = getConflicts(date);
    const now      = new Date();

    const result = slots.map(slot => {
      const isPast      = slot.start <= now;
      const isConflict  = isOverlapping(slot.start, slot.end, busyList);
      return {
        time:      slot.time,
        available: !isPast && !isConflict
      };
    });

    return jsonResponse({ slots: result });

  } catch (err) {
    return jsonResponse({ error: err.message });
  }
}

// ============================================================
//  POST: 予約作成
//  ボディ (JSON文字列): {date, time, duration, service, options, name, phone, memo}
// ============================================================
const SERVICE_LABELS = {
  'interior': '内装清掃',
  'coating':  'ガラスコーティング'
};

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const { date, time, duration, service, options, name, phone, memo } = body;

    // 必須チェック
    if (!date || !time || !duration || !name || !phone) {
      return jsonResponse({ success: false, error: 'missing_fields' });
    }

    // 時刻パース
    const parts  = time.split(':');
    const h      = parseInt(parts[0]);
    const m      = parseInt(parts[1]);
    const dur    = parseInt(duration);
    const endH   = h + dur;

    if (endH > CONFIG.BUSINESS_END) {
      return jsonResponse({ success: false, error: 'out_of_business_hours' });
    }

    const eventStart = toJSTDate(date, h, m);
    const eventEnd   = toJSTDate(date, endH, m);

    // 競合チェック（レースコンディション対策）
    const busyList = getConflicts(date);
    if (isOverlapping(eventStart, eventEnd, busyList)) {
      return jsonResponse({ success: false, error: 'slot_taken' });
    }

    // サービス名を組み立て
    const svcLabel = buildServiceLabel(service, options);

    // カレンダーイベント作成
    const calendar = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
    const event = calendar.createEvent(
      `【予約】${name}様（${svcLabel}）`,
      eventStart,
      eventEnd,
      {
        description: `サービス: ${svcLabel}\n所要時間: ${dur}時間\n電話番号: ${phone}\nご要望・メモ: ${memo || 'なし'}`
      }
    );

    // 予約確認SMS（SMS_ENABLED が true の場合のみ送信）
    try {
      if (CONFIG.SMS_ENABLED) {
        const msg = buildConfirmationSms(name, date, time, dur, svcLabel);
        sendSms(phone, msg);
      }
    } catch (smsErr) {
      // SMS失敗は予約処理に影響させない
      Logger.log('確認SMS送信エラー: ' + smsErr.message);
    }

    return jsonResponse({ success: true, eventId: event.getId() });

  } catch (err) {
    return jsonResponse({ success: false, error: err.message });
  }
}

// CORS preflight 対応
function doOptions(e) {
  return ContentService
    .createTextOutput('')
    .setMimeType(ContentService.MimeType.TEXT);
}

// ============================================================
//  SMS: 当日リマインド送信
//  GAS タイムトリガーで毎朝 CONFIG.REMINDER_HOUR に実行してください
//  前日以前に作成された予約のみリマインドを送信します（当日予約はスキップ）
// ============================================================

/**
 * 当日の予約を検索し、前日以前の予約に対してリマインドSMSを送信する
 * GASトリガーで毎朝自動実行する関数
 */
function sendDayOfReminders() {
  if (!CONFIG.SMS_ENABLED) {
    Logger.log('[SMS] SMS_ENABLED が false のため送信スキップ');
    return;
  }

  const today      = new Date();
  const todayStr   = formatDate(today);
  const todayStart = toJSTDate(todayStr, 0, 0);
  const todayEnd   = toJSTDate(todayStr, 23, 59);

  const calendar = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
  const events   = calendar.getEvents(todayStart, todayEnd);

  // 【予約】タイトルのイベントのみ対象
  const bookingEvents = events.filter(ev =>
    !ev.isAllDayEvent() && ev.getTitle().startsWith('【予約】')
  );

  Logger.log(`[SMS] 本日の予約イベント数: ${bookingEvents.length}`);

  bookingEvents.forEach(ev => {
    // 当日に作成されたイベントはスキップ（当日予約には確認SMSが送信済み）
    const createdDate    = ev.getDateCreated();
    const createdDateStr = formatDate(createdDate);
    if (createdDateStr === todayStr) {
      Logger.log(`[SMS] 当日予約のためスキップ: ${ev.getTitle()}`);
      return;
    }

    // description から電話番号と各情報を抽出
    const desc  = ev.getDescription() || '';
    const phone = extractPhone(desc);
    if (!phone) {
      Logger.log(`[SMS] 電話番号が取得できないためスキップ: ${ev.getTitle()}`);
      return;
    }

    // タイトルから顧客名を抽出: 「【予約】山田太郎様（サービス名）」
    const nameMatch = ev.getTitle().match(/【予約】(.+?)様/);
    const guestName = nameMatch ? nameMatch[1] : 'お客様';

    // サービス名を抽出: 「サービス: 手洗い洗車 + 内装清掃」
    const svcMatch  = desc.match(/サービス: (.+)/);
    const svcLabel  = svcMatch ? svcMatch[1] : '';

    const startTime = ev.getStartTime();
    const timeStr   = formatTime(startTime);

    const msg = buildReminderSms(guestName, timeStr, svcLabel);

    try {
      sendSms(phone, msg);
      Logger.log(`[SMS] リマインド送信完了: ${guestName}様 ${phone}`);
    } catch (err) {
      Logger.log(`[SMS] リマインド送信エラー (${phone}): ${err.message}`);
    }
  });
}

/**
 * 当日リマインドトリガーをプログラム的に設定する
 * GASエディタで一度だけ手動実行してください（重複実行に注意）
 */
function createDayOfReminderTrigger() {
  // 既存の同名トリガーを削除
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'sendDayOfReminders') {
      ScriptApp.deleteTrigger(t);
    }
  });
  // 毎日 REMINDER_HOUR 時に実行
  ScriptApp.newTrigger('sendDayOfReminders')
    .timeBased()
    .everyDays(1)
    .atHour(CONFIG.REMINDER_HOUR)
    .create();
  Logger.log(`[SMS] トリガーを設定しました: 毎日${CONFIG.REMINDER_HOUR}時に sendDayOfReminders を実行`);
}

// ============================================================
//  SMS ヘルパー関数
// ============================================================

/**
 * Twilio API 経由で SMS を送信する
 * @param {string} toPhone - 送信先電話番号（日本形式: 090-XXXX-XXXX）
 * @param {string} message - メッセージ本文
 */
function sendSms(toPhone, message) {
  const sid   = CONFIG.TWILIO_ACCOUNT_SID;
  const token = CONFIG.TWILIO_AUTH_TOKEN;
  const from  = CONFIG.TWILIO_FROM_NUMBER;

  if (!sid || !token || !from) {
    Logger.log('[SMS] Twilio設定が不完全です（SID/Token/From を確認してください）');
    return;
  }

  const to  = formatPhoneForTwilio(toPhone);
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;

  const response = UrlFetchApp.fetch(url, {
    method:             'post',
    headers:            { 'Authorization': 'Basic ' + Utilities.base64Encode(sid + ':' + token) },
    payload:            { To: to, From: from, Body: message },
    muteHttpExceptions: true
  });

  const status = response.getResponseCode();
  if (status < 200 || status >= 300) {
    throw new Error(`Twilio APIエラー (HTTP ${status}): ${response.getContentText()}`);
  }
  Logger.log(`[SMS] 送信成功 → ${to}`);
}

/**
 * 日本の電話番号を Twilio 形式（E.164）に変換する
 * 例: 090-1234-5678 → +81901234567
 * @param {string} phone
 * @returns {string}
 */
function formatPhoneForTwilio(phone) {
  const digits = phone.replace(/[-\s()]/g, '');
  if (digits.startsWith('0')) {
    return '+81' + digits.slice(1);
  }
  // 既に国番号付きの場合はそのまま（先頭に+がなければ追加）
  return digits.startsWith('+') ? digits : '+' + digits;
}

/**
 * 予約確認SMSのメッセージを組み立てる
 * @param {string} name - 顧客名
 * @param {string} date - "YYYY-MM-DD"
 * @param {string} time - "HH:MM"
 * @param {number} dur  - 所要時間（時間）
 * @param {string} svcLabel - サービス名
 * @returns {string}
 */
function buildConfirmationSms(name, date, time, dur, svcLabel) {
  const dateParts = date.split('-');
  const m   = parseInt(dateParts[1]);
  const d   = parseInt(dateParts[2]);
  const dow = ['日', '月', '火', '水', '木', '金', '土'][new Date(date).getDay()];
  return `【ご予約確認】\n${name}様のご予約を承りました。\n日時: ${m}月${d}日(${dow}) ${time}〜\nサービス: ${svcLabel}\nご不明な点はお電話ください。`;
}

/**
 * 当日リマインドSMSのメッセージを組み立てる
 * @param {string} name     - 顧客名
 * @param {string} timeStr  - "HH:MM"
 * @param {string} svcLabel - サービス名
 * @returns {string}
 */
function buildReminderSms(name, timeStr, svcLabel) {
  return `【本日のご予約】\n${name}様、本日${timeStr}よりご予約です。\nサービス: ${svcLabel}\nお気をつけてお越しください。`;
}

/**
 * イベント description から電話番号を抽出する
 * @param {string} description
 * @returns {string|null}
 */
function extractPhone(description) {
  const match = description.match(/電話番号: (.+)/);
  return match ? match[1].trim() : null;
}

/**
 * Date を "HH:MM" 形式にフォーマットする
 * @param {Date} date
 * @returns {string}
 */
function formatTime(date) {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

// ============================================================
//  内部ヘルパー関数
// ============================================================

/**
 * 指定日・利用時間の候補スロットを生成する
 * @param {string} dateStr - "YYYY-MM-DD"
 * @param {number} duration - 利用時間（時間）
 * @returns {Array} [{time, start, end}]
 */
function generateSlots(dateStr, duration) {
  const slots        = [];
  const startMin     = CONFIG.BUSINESS_START * 60;
  const lastStartMin = (CONFIG.BUSINESS_END - duration) * 60;

  for (let min = startMin; min <= lastStartMin; min += CONFIG.SLOT_INCREMENT_MINUTES) {
    const h  = Math.floor(min / 60);
    const m  = min % 60;
    const hh = String(h).padStart(2, '0');
    const mm = String(m).padStart(2, '0');

    slots.push({
      time:  `${hh}:${mm}`,
      start: toJSTDate(dateStr, h, m),
      end:   toJSTDate(dateStr, h + duration, m)
    });
  }

  return slots;
}

/**
 * 指定日のカレンダー予定（busy区間）を取得する
 * 終日イベントは除外
 * @param {string} dateStr - "YYYY-MM-DD"
 * @returns {Array} [{start: Date, end: Date}]
 */
function getConflicts(dateStr) {
  const dayStart = toJSTDate(dateStr, 0, 0);
  const dayEnd   = toJSTDate(dateStr, 23, 59);

  const calendar = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
  const events   = calendar.getEvents(dayStart, dayEnd);

  return events
    .filter(ev => !ev.isAllDayEvent())
    .map(ev => ({ start: ev.getStartTime(), end: ev.getEndTime() }));
}

/**
 * スロット区間がbusyリストと重複するか判定する
 * @param {Date} slotStart
 * @param {Date} slotEnd
 * @param {Array} busyList
 * @returns {boolean}
 */
function isOverlapping(slotStart, slotEnd, busyList) {
  return busyList.some(busy => busy.start < slotEnd && busy.end > slotStart);
}

/**
 * 日付文字列と時刻からJST Dateオブジェクトを生成する
 * @param {string} dateStr - "YYYY-MM-DD"
 * @param {number} h - 時（0-23）
 * @param {number} m - 分（0-59）
 * @returns {Date}
 */
function toJSTDate(dateStr, h, m) {
  const hh = String(h).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  return new Date(`${dateStr}T${hh}:${mm}:00+09:00`);
}

/**
 * 指定月の全日付について空き状況を返す
 * カレンダーイベントを1回のgetEventsで一括取得して効率化
 * @param {string} monthStr - "YYYY-MM" 形式
 * @param {number} duration - 利用時間（時間）
 * @returns {ContentService.TextOutput} { days: { "YYYY-MM-DD": "available"|"few"|"full"|"past" } }
 */
function getMonthAvailability(monthStr, duration) {
  const parts     = monthStr.split('-');
  const year      = parseInt(parts[0]);
  const month     = parseInt(parts[1]) - 1; // 0-indexed
  const now       = new Date();
  const todayStr  = formatDate(now);

  const monthStart = new Date(year, month, 1, 0, 0, 0);
  const monthEnd   = new Date(year, month + 1, 0, 23, 59, 59);
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  // 月全体のカレンダーイベントを1回で取得
  const calendar = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
  const events   = calendar.getEvents(monthStart, monthEnd);
  const busyList = events
    .filter(ev => !ev.isAllDayEvent())
    .map(ev => ({ start: ev.getStartTime(), end: ev.getEndTime() }));

  const days = {};

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${String(year)}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

    // 過去の日付
    if (dateStr < todayStr) {
      days[dateStr] = 'past';
      continue;
    }

    // スロット候補を生成して空き数を計算
    const slots     = generateSlots(dateStr, duration);
    let   available = 0;

    slots.forEach(slot => {
      const isPast     = slot.start <= now;
      const isConflict = isOverlapping(slot.start, slot.end, busyList);
      if (!isPast && !isConflict) available++;
    });

    if (available === 0)      days[dateStr] = 'full';
    else if (available <= 3)  days[dateStr] = 'few';
    else                      days[dateStr] = 'available';
  }

  return jsonResponse({ days });
}

/**
 * Date を "YYYY-MM-DD" 形式にフォーマットする
 * @param {Date} date
 * @returns {string}
 */
function formatDate(date) {
  const y  = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d  = String(date.getDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

/**
 * ContentService で JSON レスポンスを返す
 * @param {Object} data
 * @returns {ContentService.TextOutput}
 */
function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * サービス名を組み立てる
 * @param {string} service - 'wash' | 'wash-plus'
 * @param {Array} options - ['interior', 'coating']
 * @returns {string}
 */
function buildServiceLabel(service, options) {
  if (!service || service === 'wash') return '手洗い洗車';
  const optLabels = (options || []).map(o => SERVICE_LABELS[o] || o);
  if (optLabels.length === 0) return '手洗い洗車';
  return '手洗い洗車 + ' + optLabels.join('・');
}
