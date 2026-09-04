// ═════════════════════════════════════════════════════════════
// WalkIn 會議室預約 — 同步後端（Google Apps Script）
// ─────────────────────────────────────────────────────────────
// 功能（每 5 分鐘由時間觸發器執行 syncTick）：
//  1. 自動確認「使用時數」的會員預約（驗時數批次、開放時段、衝突）
//  2. 已確認預約 → 建立 Google 日曆事件；取消/婉拒 → 刪除事件；
//     日曆上被手動刪除的系統事件 → 預約改為取消、釋出時段
//  3. 日曆上手動建立的事件 → 匯入為 cal 占用時段（擋預約）
//  4. Email 通知：新申請通知管理員；確認/婉拒通知預約人
//
// ── 部署步驟 ──
// 1) script.google.com 新增專案，貼上本檔為 Code.gs
// 2) 專案設定 → 指令碼屬性（Script Properties）新增：
//      FB_EMAIL    = walkinstudiotw@gmail.com
//      FB_PASSWORD = <Firebase 登入密碼>
//      FB_API_KEY  = AIzaSyBYowX8BzAMlGE1CjTAKg2y3mZyEbU4StU
//      DB_URL      = https://talkloudpm-default-rtdb.asia-southeast1.firebasedatabase.app
//      ADMIN_EMAIL = walkinstudiotw@gmail.com   （接收新申請通知）
// 3) 專案設定 → 時區改為 Asia/Taipei（重要！事件時間依此解讀）
// 4) 編輯器先手動執行一次 syncTick 完成授權（Calendar + Gmail + 外部連線）
// 5) 觸發器 → 新增：syncTick、時間驅動、每 5 分鐘
// （日曆 ID 與事件格式存在網頁後台「設定」，此處不用設）
// ═════════════════════════════════════════════════════════════

var ROOT = 'meeting-room';
var TAG_KEY = 'wkroom';

function props_() { return PropertiesService.getScriptProperties(); }

// ── Firebase 認證與 REST ──
function getToken_() {
  var cache = CacheService.getScriptCache();
  var t = cache.get('fb_token');
  if (t) return t;
  var p = props_();
  var res = UrlFetchApp.fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + p.getProperty('FB_API_KEY'),
    { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify({ email: p.getProperty('FB_EMAIL'), password: p.getProperty('FB_PASSWORD'), returnSecureToken: true }) });
  var body = JSON.parse(res.getContentText());
  if (!body.idToken) throw new Error('Firebase 登入失敗: ' + res.getContentText().slice(0, 200));
  cache.put('fb_token', body.idToken, 3000); // 50 分鐘
  return body.idToken;
}
function fb_(method, path, payload) {
  var url = props_().getProperty('DB_URL') + '/' + ROOT + '/' + path + '.json?auth=' + getToken_();
  var opt = { method: method, muteHttpExceptions: true, contentType: 'application/json' };
  if (payload !== undefined) opt.payload = JSON.stringify(payload);
  var res = UrlFetchApp.fetch(url, opt);
  if (res.getResponseCode() === 401) { // token 過期重試一次
    CacheService.getScriptCache().remove('fb_token');
    url = props_().getProperty('DB_URL') + '/' + ROOT + '/' + path + '.json?auth=' + getToken_();
    res = UrlFetchApp.fetch(url, opt);
  }
  if (res.getResponseCode() >= 400) throw new Error('Firebase ' + method + ' ' + path + ' → ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200));
  var txt = res.getContentText();
  return txt ? JSON.parse(txt) : null;
}
var fbGet = function (p) { return fb_('get', p); };
var fbPatch = function (p, o) { return fb_('patch', p, o); };

// ── 小工具 ──
function pad_(n) { return ('0' + n).slice(-2); }
function fmtD_(d) { return d.getFullYear() + '-' + pad_(d.getMonth() + 1) + '-' + pad_(d.getDate()); }
function fmtT_(m) { return pad_(Math.floor(m / 60)) + ':' + pad_(m % 60); }
function dateAt_(dateStr, minutes) {
  var p = dateStr.split('-');
  return new Date(+p[0], +p[1] - 1, +p[2], 0, minutes);
}
function monthEnd_(y, mo) { return y + '-' + pad_(mo + 1) + '-' + pad_(new Date(y, mo + 1, 0).getDate()); }
function safeKey_(s) { return String(s).replace(/[^A-Za-z0-9_-]/g, ''); }
function renderTpl_(tpl, b) {
  var typeZh = b.kind === 'm' ? '會員' : b.kind === 'v' ? '訪客' : '日曆';
  return String(tpl || '')
    .replace(/\{name\}/g, b.name || '')
    .replace(/\{type\}/g, typeZh)
    .replace(/\{phone\}/g, b.phone || '')
    .replace(/\{code\}/g, b.memberCode || '')
    .replace(/\{note\}/g, b.note || '')
    .replace(/\{date\}/g, b.date || '')
    .replace(/\{time\}/g, fmtT_(b.s) + '–' + fmtT_(b.e));
}

// ── 時數批次制（與網頁端同一套規則） ──
function buildGrants_(quota, grantsObj, today) {
  var list = [];
  for (var k = 0; k < 2; k++) {
    var d = new Date(today.getFullYear(), today.getMonth() + k, 1);
    if (quota > 0) list.push({ h: quota, start: fmtD_(d), exp: monthEnd_(d.getFullYear(), d.getMonth()) });
  }
  for (var gid in (grantsObj || {})) {
    var g = grantsObj[gid];
    list.push({ h: g.h, start: g.start, exp: g.exp });
  }
  list.sort(function (a, b) { return a.exp < b.exp ? -1 : 1; });
  return list.map(function (g) { g.remain = g.h; return g; });
}
function allocate_(grants, uses) { // uses: [{date,h,c}] 依 c 排序
  uses.sort(function (a, b) { return (a.c || 0) - (b.c || 0); });
  uses.forEach(function (u) {
    var need = u.h;
    for (var i = 0; i < grants.length && need > 0; i++) {
      var g = grants[i];
      if (g.start > u.date || g.exp < u.date) continue;
      var take = Math.min(need, g.remain);
      g.remain -= take; need -= take;
    }
  });
  return grants;
}
function availFor_(grants, date) {
  return grants.filter(function (g) { return g.start <= date && date <= g.exp; })
    .reduce(function (a, g) { return a + g.remain; }, 0);
}

// ═══════════ 主流程 ═══════════
function syncTick() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) return;
  try {
    var settings = fbGet('settings') || {};
    var bookings = fbGet('bookings') || {};
    var schedule = fbGet('schedule') || {};
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var windowDays = settings.bookingWindowDays || 30;
    var windowEnd = new Date(today); windowEnd.setDate(windowEnd.getDate() + windowDays + 1);
    var upd = {}; // 多路徑 patch（相對 ROOT）

    processApplications_(settings, upd);
    autoConfirmMembers_(settings, bookings, schedule, today, upd);
    pushToCalendar_(settings, bookings, today, upd);
    importBusyBlocks_(settings, schedule, today, windowEnd, upd);
    sendNotifications_(settings, bookings, upd);

    upd['meta/lastSyncAt'] = Date.now();
    upd['meta/lastError'] = null;
    fbPatch('', upd);
  } catch (err) {
    try { fbPatch('meta', { lastError: String(err), lastErrorAt: Date.now() }); } catch (e2) {}
    throw err;
  } finally {
    lock.releaseLock();
  }
}

// 0) 邀請連結 → 自動開通會員
var SITE_URL = 'https://walkinstudiotw.github.io/meeting-room/';
function processApplications_(settings, upd) {
  var apps = fbGet('applications') || {};
  var any = false; for (var k in apps) { any = true; break; }
  if (!any) return;
  var invites = fbGet('invites') || {};
  var members = fbGet('members') || {};
  var index = fbGet('memberIndex') || {};
  var adminMail = props_().getProperty('ADMIN_EMAIL') || props_().getProperty('FB_EMAIL');
  var room = settings.roomName || '會議室';
  for (var token in apps) {
    var app = apps[token];
    var inv = invites[token];
    if (!inv || inv.usedBy || !app.name || !app.phone) { upd['applications/' + token] = null; continue; }
    var phoneKey = String(app.phone).replace(/\D/g, '');
    if (!phoneKey) { upd['applications/' + token] = null; continue; }
    if (index[phoneKey]) { // 手機已屬於既有會員 → 交人工處理
      GmailApp.sendEmail(adminMail, '【' + room + '】會員申請手機重複：' + app.name,
        '申請人 ' + app.name + '（' + app.phone + '）的手機與既有會員 ' + index[phoneKey] + ' 相同，請手動處理。\n邀請備註：' + (inv.note || '—'), { name: room });
      upd['invites/' + token + '/usedBy'] = 'conflict';
      upd['applications/' + token] = null;
      continue;
    }
    var code = 'M' + Date.now().toString(36).toUpperCase();
    while (members[code]) code = 'M' + (Date.now() + Math.floor(Math.random() * 1e6)).toString(36).toUpperCase();
    var type = inv.type === 'prepaid' ? 'prepaid' : 'monthly';
    var quota = type === 'prepaid' ? 0 : (inv.quota || 0);
    upd['members/' + code] = { name: app.name, phone: app.phone, email: app.email || '', quota: quota, active: true, type: type, createdAt: Date.now() };
    upd['membersPublic/' + code] = { name: app.name, quota: quota, active: true, type: type };
    upd['memberIndex/' + phoneKey] = code;
    upd['invites/' + token + '/usedBy'] = code;
    upd['applications/' + token] = null;
    members[code] = {}; index[phoneKey] = code;
    var typeZh = type === 'prepaid' ? '會議室儲值會員' : '2F月租會員';
    GmailApp.sendEmail(adminMail, '【' + room + '】新會員已開通：' + app.name,
      '姓名：' + app.name + '\n電話：' + app.phone + '\nEmail：' + (app.email || '—') +
      '\n類型：' + typeZh + (type === 'monthly' ? ('（月額度 ' + quota + 'h）') : '（請記得為其儲值時數）') +
      '\n編號：' + code + '\n邀請備註：' + (inv.note || '—'), { name: room });
    if (app.email) {
      GmailApp.sendEmail(app.email, '【' + room + '】會員開通完成',
        app.name + ' 您好，\n\n您的' + typeZh + '已開通！\n\n預約方式：前往 ' + SITE_URL +
        ' 的「會員專區」，輸入您的手機號碼即可查詢可用時數並預約。\n\n' + room + ' 敬上', { name: room });
    }
  }
}

// 1) 自動確認會員「使用時數」預約
function autoConfirmMembers_(settings, bookings, schedule, today, upd) {
  var pend = [];
  for (var id in bookings) {
    var b = bookings[id];
    if (b.status === 'pending' && b.kind === 'm' && b.payMethod !== 'transfer') pend.push({ id: id, b: b });
  }
  if (!pend.length) return;
  pend.sort(function (a, b) { return (a.b.createdAt || 0) - (b.b.createdAt || 0); });
  var members = fbGet('members') || {};
  var grantsAll = fbGet('memberGrants') || {};
  var dayKeys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  // 已確認的時數用量（依會員彙整）
  var confirmedUses = {}; // code -> [{date,h,c}]
  for (var bid in bookings) {
    var bb = bookings[bid];
    if (bb.memberCode && bb.payMethod !== 'transfer' && bb.status === 'confirmed')
      (confirmedUses[bb.memberCode] = confirmedUses[bb.memberCode] || []).push({ date: bb.date, h: (bb.e - bb.s) / 60, c: bb.createdAt || 0 });
  }
  pend.forEach(function (item) {
    var id = item.id, b = item.b, code = b.memberCode;
    var ym = b.date.slice(0, 7);
    var reason = null;
    var mem = members[code];
    if (!mem || mem.active === false) reason = '會員不存在或已停用';
    // 開放時段
    if (!reason) {
      var d = new Date(b.date + 'T00:00:00');
      var oh = ((settings.openHours || {}).member || {})[dayKeys[d.getDay()]];
      if (!oh || b.s < oh[0] * 60 || b.e > oh[1] * 60) reason = '不在會員開放時段內';
    }
    // 衝突（confirmed / cal）
    if (!reason) {
      var ents = schedule[b.date] || {};
      for (var sid in ents) {
        if (sid === id) continue;
        var ev = ents[sid];
        if (ev.st !== 'confirmed' && ev.k !== 'cal') continue;
        if (b.s < ev.e && b.e > ev.s) { reason = '時段已被其他預約占用'; break; }
      }
    }
    // 時數批次（儲值會員無月額度）
    if (!reason) {
      var quota = (mem.type === 'prepaid') ? 0 : (mem.quota || 0);
      var grants = allocate_(buildGrants_(quota, grantsAll[code], today), (confirmedUses[code] || []).slice());
      var avail = availFor_(grants, b.date);
      var need = (b.e - b.s) / 60;
      if (need > avail) reason = '可用時數不足（剩 ' + avail + ' 小時）';
    }
    if (reason) {
      upd['bookings/' + id + '/status'] = 'rejected';
      upd['bookings/' + id + '/rejectReason'] = reason;
      upd['schedule/' + b.date + '/' + id] = null;
      upd['memberBookings/' + code + '/' + ym + '/' + id + '/st'] = 'rejected';
      b.status = 'rejected'; b.rejectReason = reason;
    } else {
      upd['bookings/' + id + '/status'] = 'confirmed';
      upd['schedule/' + b.date + '/' + id + '/st'] = 'confirmed';
      upd['memberBookings/' + code + '/' + ym + '/' + id + '/st'] = 'confirmed';
      b.status = 'confirmed';
      (confirmedUses[code] = confirmedUses[code] || []).push({ date: b.date, h: (b.e - b.s) / 60, c: b.createdAt || 0 });
      // 佔位供本輪後續衝突檢查
      (schedule[b.date] = schedule[b.date] || {})[id] = { s: b.s, e: b.e, st: 'confirmed', k: 'm' };
    }
  });
}

// 2) 已確認 → 日曆事件；取消/婉拒 → 刪事件；日曆端刪除 → 預約取消
function pushToCalendar_(settings, bookings, today, upd) {
  var calId = ((settings.calendar || {}).calendarId || '').trim();
  if (!calId) return;
  var cal = CalendarApp.getCalendarById(calId);
  if (!cal) throw new Error('找不到日曆：' + calId + '（請確認此帳號有該日曆的編輯權限）');
  var titleTpl = (settings.calendar || {}).eventTitle || '【預約】{name}（{type}）';
  var descTpl = (settings.calendar || {}).eventDesc || '';
  var tStr = fmtD_(today);
  for (var id in bookings) {
    var b = bookings[id];
    if (b.status === 'confirmed' && !b.calEventId && b.date >= tStr) {
      var ev = cal.createEvent(renderTpl_(titleTpl, b), dateAt_(b.date, b.s), dateAt_(b.date, b.e),
        { description: renderTpl_(descTpl, b) });
      ev.setTag(TAG_KEY, id);
      upd['bookings/' + id + '/calEventId'] = ev.getId();
    } else if ((b.status === 'cancelled' || b.status === 'rejected') && b.calEventId) {
      try { var old = CalendarApp.getEventById(b.calEventId); if (old) old.deleteEvent(); } catch (e) {}
      upd['bookings/' + id + '/calEventId'] = null;
    } else if (b.status === 'confirmed' && b.calEventId && b.date >= tStr) {
      var exist = null;
      try { exist = CalendarApp.getEventById(b.calEventId); } catch (e) {}
      if (!exist) { // 管理者直接在日曆刪除 → 視為取消
        upd['bookings/' + id + '/status'] = 'cancelled';
        upd['bookings/' + id + '/calEventId'] = null;
        upd['schedule/' + b.date + '/' + id] = null;
        if (b.memberCode) upd['memberBookings/' + b.memberCode + '/' + b.date.slice(0, 7) + '/' + id + '/st'] = 'cancelled';
        b.status = 'cancelled';
      }
    }
  }
}

// 3) 日曆手動事件 → cal 占用時段（全窗掃描、冪等替換）
function importBusyBlocks_(settings, schedule, today, windowEnd, upd) {
  var calId = ((settings.calendar || {}).calendarId || '').trim();
  if (!calId) return;
  var cal = CalendarApp.getCalendarById(calId);
  if (!cal) return;
  var events = cal.getEvents(today, windowEnd);
  var desired = {}; // date -> {calKey:{s,e,st,k}}
  events.forEach(function (ev) {
    if (ev.getTag(TAG_KEY)) return; // 系統自建事件
    var st = ev.getStartTime(), en = ev.getEndTime();
    var key = 'cal_' + safeKey_(ev.getId()).slice(0, 40);
    if (ev.isAllDayEvent()) {
      var d0 = new Date(st); d0.setHours(0, 0, 0, 0);
      var dEnd = new Date(en); // 全天事件結束為次日 0:00
      for (var d = new Date(d0); d < dEnd && d < windowEnd; d.setDate(d.getDate() + 1)) {
        (desired[fmtD_(d)] = desired[fmtD_(d)] || {})[key + '_' + fmtD_(d).replace(/-/g, '')] = { s: 0, e: 1440, st: 'confirmed', k: 'cal' };
      }
      return;
    }
    // 一般（可能跨日）事件：逐日切割
    var cur = new Date(st); cur.setHours(0, 0, 0, 0);
    while (cur < en && cur < windowEnd) {
      var dayStart = new Date(cur);
      var dayEndM = 1440;
      var sM = (fmtD_(dayStart) === fmtD_(st)) ? st.getHours() * 60 + st.getMinutes() : 0;
      var eM = (fmtD_(dayStart) === fmtD_(en)) ? en.getHours() * 60 + en.getMinutes() : dayEndM;
      if (eM > sM) {
        var kk = key + (fmtD_(st) === fmtD_(en) ? '' : '_' + fmtD_(dayStart).replace(/-/g, ''));
        (desired[fmtD_(dayStart)] = desired[fmtD_(dayStart)] || {})[kk] = { s: sM, e: eM, st: 'confirmed', k: 'cal' };
      }
      cur.setDate(cur.getDate() + 1);
    }
  });
  // 差異比對：窗內既有 cal 項 vs desired
  var tStr = fmtD_(today), wStr = fmtD_(windowEnd);
  for (var date in schedule) {
    if (date < tStr || date > wStr) continue;
    for (var sid in schedule[date]) {
      if (schedule[date][sid].k !== 'cal') continue;
      var want = (desired[date] || {})[sid];
      if (!want) upd['schedule/' + date + '/' + sid] = null; // 日曆上已移除/移動
    }
  }
  for (var dd in desired) {
    for (var kk2 in desired[dd]) {
      var cur2 = (schedule[dd] || {})[kk2];
      var w = desired[dd][kk2];
      if (!cur2 || cur2.s !== w.s || cur2.e !== w.e) upd['schedule/' + dd + '/' + kk2] = w;
    }
  }
}

// 4) Email 通知
function sendNotifications_(settings, bookings, upd) {
  var adminMail = props_().getProperty('ADMIN_EMAIL') || props_().getProperty('FB_EMAIL');
  var room = settings.roomName || '會議室';
  var rate = ((settings.payment || {}).hourlyRate) || 0;
  for (var id in bookings) {
    var b = bookings[id];
    var when = b.date + '（' + '日一二三四五六'.charAt(new Date(b.date + 'T00:00:00').getDay()) + '）' + fmtT_(b.s) + '–' + fmtT_(b.e);
    var payTxt = b.payMethod === 'transfer' ? ('匯款 NT$' + (b.amount || 0) + '・末五碼 ' + (b.payLast5 || '—')) : '使用會員時數';
    // 4a. 新申請（待審核的匯款單）→ 通知管理員
    if (b.status === 'pending' && b.payMethod === 'transfer' && !b.adminNotifiedAt) {
      GmailApp.sendEmail(adminMail, '【' + room + '】新預約申請待審核：' + when,
        '預約時段：' + when + '\n' +
        '申請人：' + (b.name || '') + '（' + (b.kind === 'm' ? '會員 ' + (b.memberCode || '') : '訪客') + '）\n' +
        '電話：' + (b.phone || '') + '\nEmail：' + (b.email || '—') + '\n' +
        '付款：' + payTxt + '\n備註：' + (b.note || '—') + '\n\n' +
        '請至後台核對款項後核准。', { name: room });
      upd['bookings/' + id + '/adminNotifiedAt'] = Date.now();
    }
    // 4b. 確認 / 婉拒 → 通知預約人（有 Email 才寄）
    if ((b.status === 'confirmed' || b.status === 'rejected') && b.email && !b.userNotifiedAt) {
      if (b.status === 'confirmed') {
        GmailApp.sendEmail(b.email, '【' + room + '】預約已確認：' + when,
          (b.name || '') + ' 您好，\n\n您的預約已確認：\n\n' +
          '　時段：' + when + '\n　付款：' + payTxt + '\n\n' +
          (settings.notice ? settings.notice + '\n\n' : '') + room + ' 敬上', { name: room });
      } else {
        GmailApp.sendEmail(b.email, '【' + room + '】預約未能成立：' + when,
          (b.name || '') + ' 您好，\n\n很抱歉，您的預約未能成立：\n\n' +
          '　時段：' + when + '\n　原因：' + (b.rejectReason || '時段無法安排') + '\n\n' +
          '如有匯款，我們將與您聯繫退款事宜。\n\n' + room + ' 敬上', { name: room });
      }
      upd['bookings/' + id + '/userNotifiedAt'] = Date.now();
    }
  }
}

// ── 輔助：手動安裝觸發器（執行一次即可） ──
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncTick') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncTick').timeBased().everyMinutes(5).create();
}
// ── 輔助：測試連線（執行後看記錄） ──
function testConnection() {
  var s = fbGet('settings');
  Logger.log('settings: ' + JSON.stringify(s).slice(0, 300));
  var calId = ((s && s.calendar) || {}).calendarId;
  var cal = calId ? CalendarApp.getCalendarById(calId) : null;
  Logger.log('calendar: ' + (cal ? cal.getName() : '找不到（請確認權限與 ID）'));
}
