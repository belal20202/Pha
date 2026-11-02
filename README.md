# صيدليتي 💊

نظام إدارة صيدلية مشترك (PWA): مخزون لحظي، صور الأدوية، باركود، سجل حركات، أكثر من مستخدم.

## الإعداد

### 1) Firebase
1. ادخل https://console.firebase.google.com وأنشئ مشروعاً جديداً.
2. Build ← Authentication ← Get started ← فعّل **Email/Password**.
3. Build ← Firestore Database ← Create database (Production mode).
4. من تبويب **Rules** الصق محتوى ملف `firestore.rules` واضغط Publish.
5. Project settings ← Your apps ← أضف **Web app** ← انسخ `firebaseConfig`
   وضعه في ملف `firebase-config.js`.
6. Authentication ← Settings ← Authorized domains ← أضف: `USERNAME.github.io`

### 2) GitHub
1. أنشئ مستودعاً جديداً وارفع كل الملفات (بما فيها مجلد `.github`).
2. Settings ← Pages ← Source: **GitHub Actions**.
3. بعد أول push ينتشر الموقع على: `https://USERNAME.github.io/REPO/`

### 3) التثبيت على الموبايل
افتح الرابط في Chrome ← القائمة ⋮ ← "تثبيت التطبيق" / "إضافة إلى الشاشة الرئيسية".

## الاستخدام
- أول مستخدم: إنشاء حساب + يكتب **رمز الصيدلية** (مثال: `ahmed-pharmacy`).
- باقي الموظفين: إنشاء حساب بنفس الرمز، فيشوفون نفس الأدوية فوراً.
- الرمز هو مفتاح الوصول للبيانات، فلا تشاركه إلا مع موظفيك.

## ملاحظات
- الصور تُضغط إلى 320px وتُحفظ داخل Firestore (مجاناً بدون Storage).
- مسح الباركود يحتاج HTTPS (GitHub Pages يوفره) وصلاحية الكاميرا.
- خطة Firebase المجانية (Spark) تكفي لصيدلية صغيرة/متوسطة.
