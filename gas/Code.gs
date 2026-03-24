// ============================================================
//  予約フォーム — Google Apps Script バックエンド
//  設定は CONFIG オブジェクトのみ編集してください
// ============================================================

const CONFIG = {
  CALENDAR_ID: 'primary',          // カレンダーID（primary = メインカレンダー）
  BUSINESS_START: 9,               // 営業開始時刻（時）
  BUSINESS_END: 21,                // 営業終了時刻（時）
  SLOT_INCREMENT_MINUTES: 30,      // スロットの刻み幅（分）
  TIMEZONE: 'Asia/Tokyo',
  MAX_DURATION: 3                  // 最大予約時間（時間）
};

// ============================================================
//  GET: 空き枠一覧取得
//  パラメータ: ?date=YYYY-MM-DD&duration=N
// ============================================================
function doGet(e) {
  try {
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
//  内部ヘルパー関数
// ============================================================

/**
 * 指定日・利用時間の候補スロットを生成する
 * @param {string} dateStr - "YYYY-MM-DD"
 * @param {number} duration - 利用時間（時間）
 * @returns {Array} [{time, start, end}]
 */
function generateSlots(dateStr, duration) {
  const slots       = [];
  const startMin    = CONFIG.BUSINESS_START * 60;
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
