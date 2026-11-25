# الدليل الشامل لمنشئ التقارير الديناميكي (Call Center Report Builder)

## 1. نظرة عامة على النظام (System Architecture)
يتيح **Report Builder** إنشاء تقارير مخصصة (Custom SQL Reports) ونشرها فوراً داخل لوحة تحكم المشرفين (`Call Center -> Reports`) في نظام **Issabel PBX** دون الحاجة لتعديل الكود البرمجي أو إعادة تشغيل خدمة `cc-middleware`.

* **مسار الإدارة (Admin UI):** `Call Center -> Report Builder` (`/cc/#report-builder`) — مخصص لمديري النظام (Administrators).
* **مسار التشغيل للمشرفين (Supervisor UI):** `Call Center -> Reports` (`/cc/#reports`) — تظهر فيه التقارير المفعّلة (`Active`) تلقائياً تحت القسم المحدد (`Agents` / `Queues` / `Calls`) مع دعم التصفية (Pagination) والتصدير إلى **CSV** و **Excel**.
* **جدول التخزين:** تُحفظ تعريفات التقارير في قاعدة بيانات MySQL (`asterisk.cc_custom_reports`).

---

## 2. مكونات واجهة إنشاء التقرير (Builder Fields)

| الحقل | الوصف | ملاحظات مهمة |
| :--- | :--- | :--- |
| **Report Title** | اسم التقرير الذي سيظهر للمشرفين في القائمة المنسدلة | يفضل أن يكون واضحاً ومختصراً (مثل: `Agent Daily Pause Summary`). |
| **Category** | القسم الذي سيندرج تحته التقرير (`Agents`, `Queues`, `Calls`) | يحدد التبويب الذي سيظهر فيه التقرير داخل صفحة `Reports`. |
| **Enabled Filters** | الفلاتر التي ستظهر للمستخدم عند فتح التقرير | `Date Range` مفعّل دائماً. يمكنك تفعيل `Agent` أو `Queue` أو `Reason` حسب احتياج الاستعلام. |
| **SQL Query** | استعلام قراءة البيانات (`SELECT` فقط) | اضغط على زر **Edit SQL** لتفعيل التعديل في المحرر، واستخدم أزرار **Insert parameters** لإدراج المتغيرات بأمان. |
| **Test / Preview Query** | زر اختبار الاستعلام وعرض أول 15 صفاً في صندوق `Live Preview` | استخدمه دائماً للتأكد من صحة الاستعلام وأسماء الأعمدة قبل الحفظ. |

---

## 3. المتغيرات الديناميكية (Bound Parameters)

عند كتابة الاستعلام، لا تضع تواريخ أو أرقام ثابتة، بل استخدم المتغيرات التالية التي يربطها السيرفر تلقائياً وبأمان تام (Prepared Statements) لحماية النظام من SQL Injection:

| المتغير | النوع والقيمة الممررة | طريقة الاستخدام الصحيحة في `WHERE` |
| :--- | :--- | :--- |
| `:from_date` | تاريخ البداية بصيغة `'YYYY-MM-DD'` | `DATE(event_time) BETWEEN :from_date AND :to_date` |
| `:to_date` | تاريخ النهاية بصيغة `'YYYY-MM-DD'` | `DATE(event_time) BETWEEN :from_date AND :to_date` |
| `:agent_ext` | رقم تحويلة الإيجنت (مثل `'1003'`) أو `''` عند اختيار الكل | `(:agent_ext IN ('', 'all') OR a.sip_extension = :agent_ext)` |
| `:queue_name` | رقم الكيو (مثل `'800'`) أو `''` عند اختيار الكل | `(:queue_name IN ('', 'all') OR queue_name = :queue_name)` |
| `:reason` | سبب الرفض (`'TIMEOUT'` أو `'DECLINED'`) أو `''` للكل | `(:reason IN ('', 'all') OR reason = :reason)` |

> **تنبيه هام جداً:**
> 1. **لا تضع علامات تنصيص (`' '`) حول المتغيرات** داخل الاستعلام (اكتب `:from_date` وليس `':from_date'`) لأن السيرفر يمررها كقيم نصية جاهزة.
> 2. **لا تضع فاصلة منقوطة (`;`)** في نهاية الاستعلام.
> 3. استخدم `AS \`Column Name\`` لتسمية الأعمدة بأسماء احترافية تظهر مباشرة في رأس الجدول وملفات Excel/CSV.

---

## 4. قواعد الأمان والقيود (Security & Guardrails)

لضمان استقرار سيرفر الاتصال وحماية قاعدة البيانات:
1. **للقراءة فقط (Read-Only):** يجب أن يبدأ الاستعلام بكلمة `SELECT` (أو `WITH` متبوعة بـ `SELECT`).
2. **الكلمات المحظورة:** يُرفض أي استعلام يحتوي على أوامر تعديل أو حذف مثل: `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `TRUNCATE`, `CREATE`, `REPLACE`, `GRANT`, `REVOKE`, `INTO OUTFILE`.
3. **حد الصفوف الأقصى (Row Cap):**
   * وضع **Live Preview** يعرض بحد أقصى **15 صفاً**.
   * وضع التشغيل الفعلي في **Reports** يعرض ويصدّر بحد أقصى **5,000 صف**.

---

## 5. خريطة الجداول المتاحة في قاعدة البيانات (Database Schema Reference)

### أ. جداول الميدل وير (`asterisk` DB)
1. **`cc_agents`** (بيانات الإيجنتس):
   * `id`, `username` (اسم الإيجنت), `sip_extension` (التحويلة مثل `1003`), `is_active`
2. **`cc_agent_logs`** (سجل الدخول والخروج والبريكات):
   * `id`, `agent_id`, `event_type` (`login`, `logout`, `pause`, `unpause`), `pause_reason_id`, `event_time`
3. **`custom_pause_reasons`** (أسباب البريك المخصصة):
   * `id`, `name` (مثل `Break`, `Pray`, `Meeting`)
4. **`queue_requeue_logs`** (سجل عدم الرد ورفض المكالمات):
   * `id`, `caller_id`, `queue_name`, `agent_name`, `agent_ext`, `reason` (`TIMEOUT` أو `DECLINED`), `ring_duration_ms`, `created_at`
5. **`cc_daily_agent_stats`** (الإحصائيات اليومية المجمعة للإيجنت):
   * `stat_date`, `agent_ext`, `agent_name`, `calls_taken`, `calls_made`, `talk_time_sec`, `pause_time_sec`

### ب. جدول سجل المكالمات (`asteriskcdrdb.cdr`)
* **