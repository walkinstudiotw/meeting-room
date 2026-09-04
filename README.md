# WalkIn 會議室預約系統

單檔 vanilla JS（`index.html`）+ Firebase Realtime Database + Google Apps Script 同步後端。

- 線上網址：https://walkinstudiotw.github.io/meeting-room/
- 本機模擬模式（假資料、不連 Firebase）：`index.html?mock=1`

## 功能總覽

| 角色 | 功能 |
|---|---|
| 訪客 | 看可預約時段（訪客開放時段）→ 匯款（NT$/hr）＋填帳號末五碼 → 送出申請 → 管理員核對後成立 |
| 會員 | 手機號碼查詢登入 → 看可用時數批次 → 用時數預約（**免審核**，5 分鐘內自動確認）；時數不足改匯款流程 |
| 管理員 | Firebase 登入 → 審核匯款單（顯示金額＋末五碼）、會員 CRUD、手動發放有期限的時數批次、系統設定（開放時段/費率/日曆 ID/事件格式） |

時數規則：每月額度自動成為「當月批次」（月底到期歸零）；手動發放批次照自訂期限；扣抵先用快到期的；預約日必須落在批次有效期內。

## 首次啟用步驟

### 1. Firebase 規則（必做，否則整個系統無法讀寫）

Firebase Console → talkloudpm 專案 → Realtime Database → 規則：
把 `rules.meeting-room.json` 裡的 `meeting-room` 區塊**合併**進既有 rules JSON（與 `walkin-pm` 節點並列），發布。

### 2. 初始化設定

用管理員帳號（walkinstudiotw@gmail.com）打開網站 → 管理後台登入。
首次登入會自動寫入預設設定；到「設定」調整：匯款帳戶資訊（必改）、開放時段、費率、日曆 ID。

### 3. Apps Script 同步後端

1. [script.google.com](https://script.google.com) 新增專案，貼上 `appscript.gs`
2. 專案設定 → 指令碼屬性：`FB_EMAIL` / `FB_PASSWORD` / `FB_API_KEY` / `DB_URL` / `ADMIN_EMAIL`（值見 appscript.gs 開頭註解）
3. 專案設定 → 時區 **Asia/Taipei**
4. 編輯器執行 `testConnection` 完成授權並確認連線（記錄應顯示 settings 與日曆名稱）
5. 執行 `installTrigger` 安裝每 5 分鐘觸發器

### 4. 部署

Push 到 `main` → GitHub Pages（Settings → Pages → Deploy from branch → main / root）。
驗收記得硬刷新（⌘+Shift+R）。

## 信任模型（已知取捨）

- **手機號碼＝會員登入憑證**（無密碼）：知道號碼者可查該會員時數並用其額度預約；濫用時管理員可取消預約並停用會員。
- 開放時段/時數由前端＋Apps Script 在確認時強制；惡意 client 可寫入 out-of-hours 的 pending，會在 5 分鐘內被自動婉拒（會員單）或由人工審核擋下（匯款單）。
- 未登入者可 create pending 申請（欄位有白名單＋長度上限、不佔用已確認時段）；被灌爆時再加訪客通行碼。
- 時段表（無姓名，只有起迄與狀態）全球可讀。
- 管理員 Firebase 密碼存於 Apps Script 指令碼屬性（信任層級同 walkin-pm 寄信 webhook）。
- 日曆手動事件只匯入起迄時間，**不**公開事件標題。

## 資料結構（`/meeting-room/`）

```
settings                        公開讀；roomName/notice/slotMinutes/bookingWindowDays/
                                openHours{visitor,member}/payment{hourlyRate,bankInfo}/
                                calendar{calendarId,eventTitle,eventDesc}
schedule/{date}/{bid}           公開讀 {s,e,st,k}（分鐘制；k: m|v|cal）
bookings/{bid}                  admin 讀；完整預約（含 PII、payLast5、calEventId、通知戳記）
members/{code}                  admin；完整會員資料
membersPublic/{code}            按 key 讀 {name,quota,active}
memberIndex/{手機數字}          按 key 讀 → code
memberGrants/{code}/{gid}       按 code 讀 {h,start,exp,note,at}（手動發放批次）
memberBookings/{code}/{ym}/{bid} 按 code 讀 {date,s,e,st,pay,c}（會員端算餘額）
meta                            admin；lastSyncAt/lastError
```

寫入權限：非管理員只能「create status=pending」與「刪除自己的 pending」（push id 即取消憑證，存 localStorage）；`confirmed` 只有管理員憑證（網頁後台或 Apps Script）能寫。
