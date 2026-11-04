# 🌌 Mahyar Gap

🇮🇷 **فارسی** · [🇬🇧 English](README.en.md)

> **دوستانت، فضای خودت، موسیقی مشترک شما.**

Mahyar Gap یک فضای ارتباطی خصوصی برای گروه‌های کوچک دوستانه است؛ با پیام‌رسانی لحظه‌ای، تماس صوتی و تصویری، اشتراک صفحه و پخش موسیقی هماهنگ برای همه اعضای یک اتاق.

> **وضعیت موسیقی:** موسیقی با یک پخش‌کننده HTML Audio در مرورگر هر عضو پخش می‌شود و وضعیت پخش، صف و زمان‌بندی از طریق Socket.IO هماهنگ می‌شود. موسیقی یک Participant صوتی LiveKit نیست. تماس صوتی و تصویری انسان‌ها همچنان از LiveKit استفاده می‌کند.

---

## ✨ امکانات اصلی

| قابلیت | توضیح |
| --- | --- |
| 💬 پیام‌رسانی | کانال متنی، پیام خصوصی، پاسخ، واکنش، پین و وضعیت تایپ |
| 🎙️ Voice | اتاق صوتی زنده با LiveKit، کنترل میکروفن و Deafen |
| 🎥 ویدیو و اشتراک صفحه | دوربین و Screen Share با چیدمان واکنش‌گرا |
| 🎵 Mahyar Music | پخش هماهنگ فایل‌های کتابخانه مشترک در مرورگر همه اعضای Voice |
| 🗂️ Music Library | آپلود فایل مجاز، جست‌وجو، صف و Playlist مشترک |
| 🔊 کنترل شخصی صدا | Volume و Mute موسیقی فقط روی دستگاه خود کاربر |
| 🌐 دوزبانه | صفحه عمومی فارسی (`/fa`) و انگلیسی (`/en`) |
| 🪶 معماری سبک | بدون Music Worker، FFmpeg در مسیر پخش، Redis یا میکروسرویس اضافی |

## 🧭 تجربه پخش موسیقی چگونه کار می‌کند؟

1. یکی از اعضا وارد Voice Channel می‌شود.
2. فایل موسیقی مجاز در Music Library سرور آپلود می‌شود.
3. کاربر در چت همان Voice می‌نویسد: `/mp play Believer`.
4. سرور صف و زمان شروع را با Socket.IO برای اعضای عضو Voice هماهنگ می‌کند.
5. مرورگر هر عضو، همان فایل خصوصی را با URL امضاشده مستقیماً از Railway Bucket پخش می‌کند.
6. Play، Pause، Resume، Skip و Stop مشترک‌اند؛ Volume و Mute هر نفر مستقل است.

**نکته مرورگر:** برای جلوگیری از پخش خودکار ناخواسته، ممکن است هر نفر لازم باشد یک بار روی **Enable Audio** کلیک کند. این محدودیت سیاست Autoplay مرورگر است.

## ⌨️ دستورهای موسیقی

```text
/mp play <track name>
/mp queue
/mp pause
/mp resume
/mp skip
/mp stop
/mp nowplaying
```

Volume و Mute دستور جداگانه ندارند؛ روی ردیف یا پنل **Mahyar Music** راست‌کلیک کنید تا کنترل صدای شخصی باز شود.

## 🏗️ معماری خلاصه

```text
Browser A ── signed media URL ──┐
Browser B ── signed media URL ──┼── Railway Storage Bucket (private audio)
Browser C ── signed media URL ──┘

Mahyar Gap / Express ── PostgreSQL (users, library metadata, playlists)
          │
          └── Socket.IO (shared queue + playback timeline)

Human Voice / Video ── LiveKit
Music Playback ─────── HTMLAudioElement in each browser
```

- فایل صوتی در PostgreSQL ذخیره نمی‌شود؛ فقط مشخصات آهنگ و کلید Object ذخیره می‌شود.
- در حالت عادی، مرورگر فایل را مستقیم از Bucket می‌خواند.
- اگر CORS Bucket اجازه PUT مستقیم ندهد، برنامه به‌صورت خودکار از مسیر آپلود Stream هم‌دامنه استفاده می‌کند؛ این روش از Egress سرویس Railway مصرف می‌کند.
- وضعیت صف و پخش فعلاً در حافظه سرور نگه‌داری می‌شود؛ با Restart برنامه، پخش فعال و صف جاری از نو آغاز می‌شوند.

## 🧰 فناوری‌ها

| لایه | فناوری |
| --- | --- |
| Runtime | Node.js 22.22+ |
| Backend | Express + TypeScript |
| Realtime | Socket.IO |
| Voice / Video | LiveKit (`livekit-server-sdk`, `livekit-client`) |
| Database | PostgreSQL + Prisma |
| Object Storage | Railway Storage Bucket (S3-compatible) |
| Audio validation | FFmpeg / FFprobe فقط برای اعتبارسنجی آپلود و Artwork، نه پخش |
| Frontend | HTML، JavaScript، CSS و Tailwind build |

## ✅ پیش‌نیازها

- Node.js نسخه 22.22 یا بالاتر
- PostgreSQL
- یک پروژه LiveKit برای Voice و Video انسانی
- Railway Project و یک Railway Storage Bucket خصوصی به نام دلخواه (پیشنهاد: `mahyar-music`)
- FFmpeg و FFprobe برای اعتبارسنجی فایل‌های آپلودشده (در Dockerfile نصب می‌شوند)

## 🚀 اجرای محلی

```bash
# نصب وابستگی‌ها
npm ci

# ساخت فایل تنظیمات
cp .env.example .env

# ساخت Prisma Client و اجرای Migrationها
npm run db:generate
npm run db:migrate

# اجرای محیط توسعه
npm run dev
```

صفحه‌ها:

| مسیر | کاربرد |
| --- | --- |
| `/` | هدایت به صفحه فارسی |
| `/fa` | صفحه معرفی فارسی |
| `/en` | صفحه معرفی انگلیسی |
| `/app` | برنامه اصلی |

برای نسخه تولیدی:

```bash
npm run build
npm start
```

## 🚂 راه‌اندازی روی Railway

1. Repository را به Railway متصل کنید.
2. سرویس PostgreSQL را به پروژه اضافه و `DATABASE_URL` را به سرویس وب متصل کنید.
3. سرویس وب را با Dockerfile موجود Deploy کنید.
4. متغیرهای LiveKit و JWT را در Variables سرویس وب تنظیم کنید.
5. یک **Storage Bucket** به همان Railway Project اضافه کنید.
6. مقادیر Credentials مربوط به Bucket را با Variable Reference به سرویس وب وصل کنید.
7. بعد از Deploy، صفحه `/app` را باز و Upload و Playback را آزمایش کنید.

### ☁️ ساخت Railway Storage Bucket

1. در Railway Dashboard پروژه Mahyar Gap را باز کنید.
2. در محیط موردنظر (معمولاً Production) گزینه **Create → Bucket** را انتخاب کنید.
3. نام Bucket را مثلاً `mahyar-music` بگذارید و Region نزدیک به سرویس وب را انتخاب کنید.
4. Bucket را ایجاد کنید و وارد بخش **Credentials** شوید.
5. متغیرهای زیر را از Credentials بردارید و با Variable Reference به سرویس وب وصل کنید:

| متغیر | مقدار |
| --- | --- |
| `AWS_ENDPOINT_URL` | Endpoint نمایش‌داده‌شده در Credentials |
| `AWS_ACCESS_KEY_ID` | Access Key |
| `AWS_SECRET_ACCESS_KEY` | Secret Key |
| `AWS_S3_BUCKET_NAME` | شناسه واقعی S3 Bucket، نه صرفاً نام نمایشی |
| `AWS_DEFAULT_REGION` | Region نمایش‌داده‌شده |
| `AWS_S3_URL_STYLE` | طبق Credentials؛ معمولاً `virtual-hosted` |

**مهم:** کلیدها را فقط در Railway Variables قرار دهید؛ آن‌ها را در README، Git، مرورگر یا پیام‌ها منتشر نکنید. برنامه از AWS SDK صرفاً برای پروتکل سازگار با S3 استفاده می‌کند؛ Provider ذخیره‌سازی همین Railway Bucket است.

### 📤 آپلود موسیقی و CORS

- برنامه ابتدا آپلود مستقیم مرورگر به Bucket را با Presigned URL امتحان می‌کند.
- اگر Bucket به‌دلیل نبود CORS، درخواست مرورگر را رد کند، برنامه به‌صورت خودکار فایل را از مسیر هم‌دامنه و به‌شکل Stream به Bucket می‌فرستد.
- بنابراین CORS برای کارکرد پایه آپلود الزامی نیست؛ تنظیم CORS فقط مسیر مستقیم را ممکن می‌کند و فشار Egress سرویس وب را کاهش می‌دهد.
- مسیر جایگزین فایل را کامل در RAM نگه نمی‌دارد، اما ترافیک آن از سرویس وب Railway عبور می‌کند.

### 🔐 متغیرهای مهم

| متغیر | کاربرد |
| --- | --- |
| `DATABASE_URL` | اتصال PostgreSQL |
| `JWT_ACCESS_SECRET` | کلید محرمانه JWT |
| `LIVEKIT_URL` | آدرس LiveKit |
| `LIVEKIT_API_KEY` | کلید API LiveKit |
| `LIVEKIT_API_SECRET` | Secret API LiveKit |
| `AWS_ENDPOINT_URL` | Endpoint مربوط به Railway Bucket |
| `AWS_ACCESS_KEY_ID` | کلید دسترسی Bucket |
| `AWS_SECRET_ACCESS_KEY` | کلید محرمانه Bucket |
| `AWS_S3_BUCKET_NAME` | شناسه S3 Bucket |
| `AWS_DEFAULT_REGION` | Region Bucket |
| `AWS_S3_URL_STYLE` | سبک آدرس‌دهی Bucket |
| `MUSIC_MAX_FILE_MB` | سقف حجم هر فایل؛ پیش‌فرض 25 MB |
| `MUSIC_SERVER_QUOTA_MB` | سهمیه هر سرور؛ پیش‌فرض 500 MB |
| `MUSIC_MAX_DURATION_SEC` | حداکثر طول آهنگ؛ پیش‌فرض 1800 ثانیه |
| `MUSIC_MAX_TRACKS` | حداکثر تعداد آهنگ هر سرور |
| `MUSIC_MAX_QUEUE` | حداکثر تعداد آیتم صف |

جزئیات کامل متغیرها و نمونه‌ها در `.env.example` است. مقدارهای محرمانه را فقط از Railway Credentials بردارید.

## 🧪 تست و بررسی

```bash
npm run lint
npm run build
npm test
```

برای پخش واقعی باید این سناریو را در محیط Deploy‌شده انجام دهید:

1. یک فایل MP3 کوچک و مجاز Upload کنید.
2. مطمئن شوید Track در Music Library ثبت شده است.
3. دو مرورگر مستقل وارد یک Voice Channel شوند.
4. در یکی `/mp play <track>` را اجرا کنید.
5. در هر دو مرورگر در صورت نیاز روی **Enable Audio** کلیک کنید.
6. Pause/Resume/Skip و Volume شخصی را آزمایش کنید.

موفقیت Build یا نمایش حالت Playing، به‌تنهایی اثبات پخش واقعی نیست.

## 🛠️ عیب‌یابی سریع

| مشکل | بررسی |
| --- | --- |
| Upload انجام نمی‌شود | Variables Bucket، اعتبارنامه، حجم فایل، سهمیه و Logs سرویس وب را بررسی کنید. |
| خطای CORS | مسیر Stream هم‌دامنه باید خودکار فعال شود؛ اگر نشد Network و Logs را بررسی کنید. |
| آهنگ پیدا نمی‌شود | مطمئن شوید فایل در همان Server آپلود شده و هنوز در Library موجود است. |
| یک نفر صدا نمی‌شنود | روی همان دستگاه Enable Audio را بزنید، Mute و Volume مرورگر را بررسی کنید. |
| صدا بین افراد ناهماهنگ است | اتصال Socket.IO، latency شبکه و ساعت سیستم را بررسی کنید؛ هم‌زمانی میلی‌ثانیه‌ای تضمین‌شده نیست. |
| Voice کار نمی‌کند | تنظیمات LiveKit، مجوز میکروفن/مرورگر و Logs را بررسی کنید. |
| صف پس از Restart پاک شد | صف فعلی در حافظه نگه‌داری می‌شود و در این نسخه Persistent نیست. |

## 🔒 امنیت و محدودیت‌ها

- Bucket خصوصی است و دسترسی فایل‌ها از مسیر احراز هویت‌شده و URL امضاشده انجام می‌شود.
- فایل‌هایی را آپلود کنید که مالک آن هستید یا مجوز اشتراک‌گذاری آن‌ها را دارید.
- توکن، Secret و Presigned URL را در Issueها یا اسکرین‌شات‌های عمومی قرار ندهید.
- محدودیت‌های رایگان Railway به اعتبار، مصرف Storage، Egress، CPU و RAM وابسته‌اند و نامحدود نیستند؛ سقف جاری را در پنل و مستندات Railway بررسی کنید.
- پخش مرورگری به پشتیبانی فرمت توسط مرورگر بستگی دارد؛ MP3 فرمت اصلی پیشنهادی است.

---

<p align="center"><strong>MAHYAR GAP</strong><br/>Your Friends. Your Space. Your Music. 💜</p>
