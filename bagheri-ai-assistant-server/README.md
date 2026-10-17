# سرور دستیار هوشمند باقری (Groq) — نسخهٔ ۰٫۱٫۰

> **این نسخه چیست؟**
> یک دستیار فارسی و **فقط‌خواندنی** که از طریق سرور به Groq وصل می‌شود. در حالت عمومی مستقل است؛ کلاینت می‌تواند با رضایت صریح کاربر، خلاصهٔ محدود یک مشتری را برای همان درخواست ارسال کند.
> هیچ عملیات نوشتنی (فاکتور، پرداخت، یادآور) ندارد و هیچ‌وقت چیزی را اجرا نمی‌کند.

## محتویات بسته

| مسیر | کار |
|---|---|
| `ai-assistant-server.js` | سرور (فقط ماژول‌های داخلی Node؛ **بدون وابستگی npm**) |
| `lib/config.js` | خواندن و اعتبارسنجی متغیرهای محیطی |
| `lib/groq.js` | کلاینت Groq (timeout، نگاشت خطا، بدون نشت پاسخ خطا) |
| `lib/validate.js` | اعتبارسنجی سخت‌گیرانهٔ ورودی (فقط `message` و `history`) |
| `lib/http-utils.js` | JSON، خواندن بدنه با سقف، rate limit، لاگر بدون راز |
| `lib/prompt.js` | پرامپت سیستمی فارسی (کلاینت نمی‌تواند آن را عوض کند) |
| `lib/test-page.js` | صفحهٔ تست اختیاری (`/test`) |
| `test/` | تست‌ها (`npm test`) |
| `.env.example` / `.gitignore` / `render.yaml` / `package.json` | پیکربندی |

نیازمندی: **Node ≥ 18**. نیازی به `npm install` برای وابستگی نیست (فقط برای اجرای `npm start` روی Render).

## متغیرهای محیطی

| نام | الزامی؟ | پیش‌فرض | توضیح |
|---|---|---|---|
| `GROQ_API_KEY` | **بله** | — | کلید Groq. فقط در تنظیمات Render؛ هرگز در فایل/گیت |
| `ASSISTANT_ACCESS_TOKEN` | **بله** | — | رشتهٔ تصادفی بلند (≥۲۴ نویسه) که خودتان می‌سازید؛ کلاینت با `Authorization: Bearer …` می‌فرستد. بدون آن، چت **۵۰۳** می‌دهد (fail-closed) |
| `GROQ_MODEL` | توصیه‌شده | `llama-3.3-70b-versatile` | **قبل از استقرار در https://console.groq.com/docs/models چک کنید** (در محیط ساخت تأیید نشد) |
| `ALLOWED_ORIGINS` | برای مرورگر | خالی (همه‌چیز بسته) | مبدأهای مجاز با کاما، مثل `https://USER.github.io` (بدون `/` پایانی) |
| `PORT` | خودکار | `3000` | Render خودش می‌گذارد |
| `TRUST_PROXY` | روی Render: `true` | `false` | برای rate limit از آخرین آیتم `X-Forwarded-For` استفاده می‌کند |
| `ENABLE_TEST_PAGE` | خیر | `false` | فقط هنگام تست `true`؛ صفحهٔ `/test` را فعال می‌کند |
| `GROQ_TIMEOUT_MS` | خیر | `20000` | |
| `GROQ_MAX_COMPLETION_TOKENS` | خیر | `800` | |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | خیر | `20` / `60000` | سقف درخواست به‌ازای هر کلاینت |
| `DAILY_REQUEST_CAP` | خیر | `500` | سقف سراسری روزانه (UTC) برای محافظت از سهمیهٔ Groq |
| `MAX_MESSAGE_CHARS` / `MAX_HISTORY_MESSAGES` / `MAX_BODY_BYTES` | خیر | `2000` / `10` / `16384` | |
| `MAX_CONCURRENT_UPSTREAM` | خیر | `4` | |
| `LOG_LEVEL` | خیر | `info` | `error` / `info` / `debug` |
| `ALLOW_UNAUTHENTICATED` | **فقط توسعه** | `false` | با `true` نقطهٔ پایانی عمومی می‌شود؛ روی Render نگذارید |
| `GROQ_BASE_URL` | خیر | آدرس رسمی Groq | فقط برای تست با mock (http فقط روی localhost) |

## API

### `GET /health`
بدون راز. خلاصهٔ ارسالی به‌صورت دائمی ذخیره نمی‌شود؛ `crmData` فقط در پاسخ هر درخواست نشان می‌دهد آیا context ارسال شده است. `crmTools` و `writes` همچنان false هستند.

### `POST /api/assistant/chat`
هدرها: `Content-Type: application/json` و `Authorization: Bearer <ASSISTANT_ACCESS_TOKEN>`

```json
{ "message": "برای ویزیت فردا چه آماده کنم؟",
  "history": [ {"role":"user","content":"…"}, {"role":"assistant","content":"…"} ] }
```
فقط `message` (الزامی) و `history` (اختیاری، `user`/`assistant`) مجازند؛ **هر فیلد دیگر** (`tools`, `action`, `model`, `system`, …) با `400 unsupported_field` رد می‌شود.

موفق: `{"ok":true,"reply":"…","model":"…","mode":"standalone|crm-context","crmData":false|true,"usage":{…}}`
خطا: `{"ok":false,"error":{"code":"…","message":"…"}}`

| وضعیت | `code` |
|---|---|
| 400 | `invalid_json` `invalid_body` `invalid_message` `empty_message` `message_too_long` `invalid_history` `history_too_long` `unsupported_field` |
| 401 | `unauthorized` |
| 403 | `origin_not_allowed` |
| 405 / 404 / 415 / 413 | `method_not_allowed` / `not_found` / `unsupported_media_type` / `body_too_large` |
| 429 | `rate_limited` `too_many_auth_failures` `daily_cap_reached` `upstream_rate_limited` (با `Retry-After`) |
| 502 / 503 / 504 | `upstream_*` · `assistant_not_configured` · `auth_not_configured` · `busy` · `upstream_timeout` |

متن پاسخ مدل **فقط متن** است؛ در کلاینت با `textContent` نمایش دهید، نه `innerHTML`.

## استقرار روی Render (با iPhone)

> این مراحل روی iPhone واقعی اجرا **نشده‌اند** (NOT RUN)؛ بر اساس رابط Render نوشته شده‌اند.

**الف) بردن فایل‌ها روی GitHub**
۱. زیپ را در برنامهٔ Files باز (Unzip) کنید. پوشهٔ `bagheri-ai-assistant-server` ساخته می‌شود.
۲. **با Working Copy (توصیه‌شده):** مخزن جدید بسازید (مثلاً `bagheri-ai-assistant-server`، ترجیحاً **Private**)، محتوای پوشه را داخلش کپی کنید، Commit و Push.
 جایگزین: GitHub در Safari → Add file → Create new file و نوشتن مسیر کامل (مثل `lib/groq.js`) برای هر فایل. روی Safari موبایل آپلود پوشه ممکن نیست.
۳. مطمئن شوید `.env` یا کلید واقعی در مخزن **نیست**.

**ب) ساخت سرویس**
۱. Safari → render.com → ورود با GitHub.
۲. **New +** → **Web Service** → مخزن را انتخاب کنید.
۳. Language: **Node** · Branch: `main` · Root Directory: خالی (اگر پوشه را داخل مخزن دیگری گذاشته‌اید: `server`)
۴. Build Command: `npm install` · Start Command: `npm start` · Instance Type: **Free**
۵. **Environment Variables** را اضافه کنید: `GROQ_API_KEY`، `ASSISTANT_ACCESS_TOKEN`، `GROQ_MODEL`، `TRUST_PROXY=true`، `ALLOWED_ORIGINS`، و موقتاً `ENABLE_TEST_PAGE=true`.
 برای ساخت توکن: Passwords (iOS) → گذرواژهٔ قوی بسازید، کپی کنید و همان را بعداً در کلاینت بگذارید.
۶. **Create Web Service** و صبر برای Deploy (چند دقیقه).

**ج) راستی‌آزمایی**
۱. `https://NAME.onrender.com/health` را در Safari باز کنید: باید `status: ok` و `groqConfigured: true` ببینید.
۲. `https://NAME.onrender.com/test` را باز کنید، توکن را وارد کنید و یک پیام بفرستید. **فقط اگر پاسخ Groq آمد، اتصال زنده تأیید شده است.**
۳. بعد از تست، `ENABLE_TEST_PAGE` را به `false` برگردانید.

نکتهٔ Free: سرویس بعد از چند دقیقه بی‌کاری می‌خوابد؛ اولین درخواست بعدی تا حدود یک دقیقه طول می‌کشد.

## امنیت و محدودیت‌ها

- کلید Groq فقط در هدر درخواست سرور به Groq می‌رود؛ در پاسخ، هدر، لاگ و خطا ظاهر نمی‌شود (تست می‌شود). لاگ‌ها بدنه/هدر/IP نمی‌گیرند.
- **توکن دسترسی یک کلید مشترک است، نه احراز هویت کاربری.** اگر در برنامهٔ سمت کاربر ذخیره شود، هر کس به آن دستگاه/کد دسترسی داشته باشد می‌بیند. برای برنامهٔ تک‌کاربرهٔ شخصی کافی است؛ با rate limit، سقف روزانه، CORS و قفل تلاش‌های ناموفق کامل می‌شود. اگر لو رفت، مقدار را در Render عوض کنید.
- CORS صرفاً مرورگر را محدود می‌کند، نه ابزارهایی مثل curl؛ محافظ اصلی همان توکن است.
- حافظهٔ rate limit/سقف روزانه **در حافظهٔ پروسه** است و با ری‌استارت صفر می‌شود (تک‌نمونه). برای چند نمونه به ذخیرهٔ مشترک نیاز است.
- مدل ممکن است اشتباه کند؛ پرامپت سیستمی آن را به عدم‌اختراع داده و صراحت دربارهٔ «فرض» ملزم می‌کند، ولی تضمین نیست.
- پیام‌های کاربر به Groq (شخص ثالث) ارسال می‌شود؛ داده‌های حساس مشتریان را در گفت‌وگو ننویسید تا اتصال CRM با سیاست حریم خصوصی مشخص شود.
- در محیط ساخت **راستی‌آزمایی زندهٔ مدل و endpoint Groq انجام نشد** (شبکه در دسترس نبود). نام مدل و پارامتر `max_completion_tokens` طبق دانش از مستندات Groq انتخاب شده‌اند؛ اگر `/test` خطای `upstream_model_unavailable` یا `upstream_bad_request` داد، `GROQ_MODEL` را با فهرست رسمی تطبیق دهید.

## گام بعدی امن برای اتصال داده‌های CRM (اجرا نشده)

CRM یک برنامهٔ offline-first در مرورگر است و سرور به IndexedDB دسترسی ندارد. کوچک‌ترین مسیر امن:
۱. در مرورگر، با موتورهای قطعی موجود، یک **خلاصهٔ کوچک و صریح برای یک مشتری** ساخته شود (چند خرید آخر، مانده، توصیهٔ Action).
۲. کاربر قبل از ارسال آن را ببیند و تأیید کند و به‌صورت فیلد جدید `context` همراه `message` فرستاده شود (نه کل دیتابیس).
۳. سرور آن را با طرح (schema) و سقف حجم اعتبارسنجی کند و در پرامپت با برچسب «داده ارائه‌شده توسط کاربر» بگذارد.
این کار نیازمند تغییر در همین سرور (فیلد `context`) و یک دکمهٔ جدید در CRM است و باید جداگانه و با تأیید انجام شود.


## اتصال محدود به BAGHERI CRM — پچ اکتبر ۲۰۲۶

در CRM یک مسیر «بیشتر ← دستیار فروش باقری» اضافه شده است. کاربر توکن را فقط در همان صفحه وارد می‌کند (در localStorage ذخیره نمی‌شود). انتخاب مشتری و رضایت ارسال الزامی است؛ سپس فقط خلاصه‌ای محدود از نام مشتری، مانده محاسبه‌شده توسط موتور موجود CRM، پنج فاکتور اخیر، چهار ویزیت اخیر و پیشنهاد موجود Intelligence ارسال می‌شود. خلاصه در سرور ذخیره نمی‌شود و هیچ API نوشتنی اضافه نشده است.

برای فعال شدن درخواست مرورگر، در Render → SF-crm → Environment متغیر `ALLOWED_ORIGINS` را تنظیم کنید تا دقیقاً **origin** سایت GitHub Pages را شامل شود، بدون مسیر و بدون اسلش پایانی؛ مثال: `https://USERNAME.github.io`. اگر origin سایت مجاز نباشد، مرورگر درخواست را با `origin_not_allowed` رد می‌کند. پس از ذخیره، منتظر Deploy بمانید.

این اتصال «ارسال خلاصه هنگام سؤال» است، نه همگام‌سازی دائمی. در حالت گفت‌وگوی عمومی هیچ داده‌ای از CRM ارسال نمی‌شود. اطلاعات منتخب به سرور Render و سپس به Groq می‌رود؛ از ارسال داده‌ای که نمی‌خواهید به سرویس شخص ثالث برسد خودداری کنید.
