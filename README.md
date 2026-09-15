# 課堂點名及評分系統

Vue3 + Express + PostgreSQL 嘅課堂點名 / 評分 / 大測登記系統。

## 目錄結構

```
server/   後端 (Express + pg + exceljs)
client/   前端 (Vue3 + Vite)
```

## 安裝

```bash
cd server && npm install
cd ../client && npm install
```

## 資料庫 (PostgreSQL)

呢個系統用 PostgreSQL,需要一個 `DATABASE_URL` 連線字串(格式 `postgres://user:password@host:port/dbname`)。
Schema 會喺 server 啟動嗰陣自動建立(`CREATE TABLE IF NOT EXISTS`),唔使自己手動 migrate。

**本機開發**:喺 `server/` 底下建立一個 `.env` 檔案(唔會被 git 追蹤),入面寫:

```
DATABASE_URL=postgres://...你嘅連線字串...
```

如果冇本機 Postgres,可以直接用 Render 嗰個 Postgres 嘅 **External Connection String**(喺 Render Dashboard 嗰個 Postgres 頁面攞到),本機同正式環境共用同一個資料庫。

**正式環境 (Render)**:專案根目錄嘅 `render.yaml` 已經定義咗一個 Postgres(`attendance-db`)同一個 web service,並且自動將 `DATABASE_URL` 接駁埋一齊 —— 喺 Render 用「New +」→「Blueprint」揀呢個 repo 就會自動建立晒,唔使手動設定環境變數。

## 開發模式運行

開兩個終端機:

```bash
# 終端機 1:後端 (http://localhost:3000)
cd server
npm run dev

# 終端機 2:前端 (http://localhost:5173,已設定 proxy 去 /api)
cd client
npm run dev
```

瀏覽器開 http://localhost:5173 。

## 正式環境運行

```bash
cd client && npm run build   # build 出 client/dist
cd ../server && npm start    # Express 會自動 serve client/dist,單一 port (預設 3000)
```

## 預設帳號

首次啟動,如果資料庫入面未有任何用戶,會自動建立:

- 帳號:`admin`
- 密碼:`admin123`
- 角色:管理員

**請第一時間登入並喺「帳戶設定」更改密碼。**

## 使用流程

1. 管理員登入 → 「班級 / 科目 / 指派」頁:
   - 新增班級(例如 `F2A(菁)`)
   - 為班級上傳花名冊 Excel(格式:第 5 行開始,A 欄 = 學號,B 欄 = 姓名,同你提供嘅範本一致)
   - 新增科目(例如 `數學`)
   - 建立「班級 x 科目」指派,揀返任教老師 + 導師姓名
2. 「用戶管理」頁新增老師帳號(初始密碼由管理員設定,老師首次登入後應自行更改)
3. 老師登入 → 喺「我負責嘅班級」揀返班級/科目 → 進入班級工作區:
   - **出席**:揀日期 + 單課/連續兩節,逐個學生揀出席狀態(自動計分),可以之後再揀返同一日期編輯
   - **表現分 / 堂課分**:揀日期,逐個學生揀 100/80/60/40 或自訂分數,可事後編輯
   - **大測**:建立測驗(名稱 + 日期),登記分數
   - **匯出 Excel**:匯出同原本表格一致格式嘅完整記錄
4. 管理員可以喺「查看記錄」頁,揀任何班級/科目查看完整記錄同匯出 Excel

## 出席計分規則

- **單課**:準時 100、遲到 90、缺席 0
- **連續兩節**:全程準時 100、第一節遲到 90、缺第一節但第二節準時到 50、缺第一節且第二節遲到 40、全缺 0

呢個規則寫喺 `server/src/utils/scoring.js`,可以按需要調整。

## 記住登入(Cookie)

登入時剔選「記住我」,系統會發一個安全嘅 remember-me token(隨機 selector + validator,只有 hash 存入資料庫,唔會將密碼存喺 cookie)。Token 30 日有效,每次用嚟自動登入都會輪換,減低被盜用風險。

## 已知事項

- `npm audit` 會顯示 client 嘅 `vite`/`esbuild` 同 server 嘅 `exceljs`(transitive `uuid`)有中等風險嘅漏洞,兩者都只影響開發階段/特定情境,對呢個內部工具風險低,如有需要可以自行執行 `npm audit fix --force`(注意會有 breaking change)。
- 因為呢個環境冇瀏覽器自動化工具,前端 UI 已經過 `npm run build` 編譯檢查、同用 curl 完整測試過後端所有 API(登入、上傳花名冊、出席/表現分/堂課分/大測登記、事後編輯、Excel 匯出格式),但實際瀏覽器交互(㨂掣、表格顯示)建議你首次使用時手動行一次登入 → 出席登記 → 匯出流程做核對。
- 資料庫由 `node:sqlite`(本機檔案)改用 PostgreSQL,原因係舊有嘅檔案式資料庫喺 Render 呢類雲端主機冇持久儲存,重新部署會清空。Postgres 版嘅所有 SQL(schema、transaction、ON CONFLICT upsert、JOIN、cascade delete)已經用一個嵌入式 Postgres 相容引擎(`@electric-sql/pglite`)做過完整測試,包括起服務器實際打晒登入/建班/上傳花名冊/出席/評分/測驗/匯出 Excel/刪除呢一輪 API,但未喺你實際嘅 Render Postgres 度驗證過,首次部署後建議行多一次呢個流程做核對。
