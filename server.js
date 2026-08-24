/**
 * أثر النخبة للهدايا — Backend الدفع عبر Stripe
 * ============================================================================
 * الجديد في النسخة دي:
 *   ✅ أنواع منتجات متعددة (PRODUCTS)
 *   ✅ أكواد خصم بصلاحية وحد أدنى للكمية وحد أقصى للاستخدام (PROMOS)
 *   ✅ نقطة /api/products — الموقع بيجيب منها الأسعار (مصدر واحد للحقيقة)
 *   ✅ نقطة /api/validate-promo — التحقق من الكود قبل الدفع
 *   ✅ CORS مقفول على athar-gifts.com بس
 *   ✅ إيميل التأكيد بقى فيه المنتج والخصم
 *
 * ⚠️ الأسعار هنا هي المرجع النهائي. الموقع بيقرأ منها.
 * ============================================================================
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

/* ==========================================================================
   ⚙️  ١ — المنتجات والأسعار  ←←← عدّل من هنا
   ========================================================================== */
const PRODUCTS = {
  'founder-6': {
    ar: 'فنجان المؤسس — طقم ٦',
    en: "Founder's Cup — Set of 6",
    price: 500,                                  // ← السعر بالدرهم
    descAr: '٦ فناجين سيراميك فاخر + علبة هدايا',
    descEn: '6 premium ceramic cups + gift box',
    active: true,
  },

  // ↓↓↓ الأنواع الجديدة — غيّر active لـ true واملا البيانات ↓↓↓
  'founder-12': {
    ar: 'فنجان المؤسس — طقم ١٢',
    en: "Founder's Cup — Set of 12",
    price: 0,                                    // ← حط السعر
    descAr: '',
    descEn: '',
    active: false,                               // ← خليها true عشان تظهر
  },
  'founder-dallah': {
    ar: 'الطقم الكامل + دلّة',
    en: 'Full Set + Dallah',
    price: 0,
    descAr: '',
    descEn: '',
    active: false,
  },
};

/* ==========================================================================
   ⚙️  ٢ — أكواد الخصم  ←←← عدّل من هنا
   type: 'percent' = نسبة مئوية  |  'fixed' = مبلغ ثابت بالدرهم
   ========================================================================== */
const PROMOS = {
  'ATHAR10': {
    type: 'percent',
    value: 10,
    label: 'خصم ١٠٪',
    expires: '2026-12-31',      // آخر يوم صلاحية
    minQty: 1,                  // أقل كمية
    maxUses: 100,               // 0 = بلا حد
    used: 0,
  },
  // مثال لخصم مؤسسي بمبلغ ثابت:
  // 'ERTH500': { type:'fixed', value:500, label:'خصم ٥٠٠ درهم',
  //              expires:'2026-12-31', minQty:5, maxUses:20, used:0 },
};

/* ========================================================================== */

const SITE = 'https://athar-gifts.com';

/* عنوان المرسِل — يتظبط من Render بدون تعديل كود.
   قبل توثيق الدومين في Resend بيفضل على العنوان التجريبي تلقائياً.
   بعد التوثيق: ضيف متغير RESEND_FROM في Render بالقيمة:
   أثر النخبة للهدايا <orders@send.athar-gifts.com>            */
const MAIL_FROM = process.env.RESEND_FROM
  || 'أثر النخبة للهدايا <onboarding@resend.dev>';

/* المستقبِلين — يقبل عنوان واحد أو أكتر مفصولين بفاصلة، مثال:
   info@athar-gifts.com, mohamedrezk@athar-gifts.com          */
const NOTIFY_TO = (process.env.NOTIFY_EMAIL || '')
  .split(',').map(e => e.trim()).filter(Boolean);

// CORS: موقعك بس هو اللي يقدر يكلم السيرفر
app.use(cors({
  origin: [SITE, 'https://www.athar-gifts.com'],
}));

/* --------------------------------------------------------------------------
   الحسبة — المرجع الوحيد للمبلغ المحصّل
   -------------------------------------------------------------------------- */
function validatePromo(code, qty) {
  if (!code) return { valid: false };
  const key = String(code).trim().toUpperCase();
  const p = PROMOS[key];
  if (!p) return { valid: false, reason: 'كود غير موجود' };
  if (p.expires && new Date() > new Date(p.expires + 'T23:59:59'))
    return { valid: false, reason: 'الكود منتهي الصلاحية' };
  if (p.minQty && qty < p.minQty)
    return { valid: false, reason: `الكود يبدأ من ${p.minQty} أطقم` };
  if (p.maxUses && p.used >= p.maxUses)
    return { valid: false, reason: 'الكود استُهلك بالكامل' };
  return { valid: true, key, type: p.type, value: p.value, label: p.label };
}

function priceOrder({ productId, quantity, promoCode }) {
  const product = PRODUCTS[productId];
  if (!product || !product.active) throw new Error('منتج غير متاح');
  if (!product.price || product.price <= 0) throw new Error('سعر المنتج غير محدد');

  const qty = Math.max(1, Math.min(500, Number(quantity) || 1));
  const subtotal = product.price * qty;

  let discount = 0, promoLabel = null, promoKey = null;
  const chk = validatePromo(promoCode, qty);
  if (chk.valid) {
    discount = chk.type === 'percent'
      ? Math.round(subtotal * (chk.value / 100))
      : Math.min(chk.value, subtotal);
    promoLabel = chk.label;
    promoKey = chk.key;
  }

  return {
    product, productId, qty, subtotal,
    discount, promoLabel, promoKey,
    total: Math.max(0, subtotal - discount),
  };
}

/* --------------------------------------------------------------------------
   Webhook — لازم يفضل قبل express.json()
   -------------------------------------------------------------------------- */
async function sendOrderEmail(d) {
  const text = `تم استلام دفعة جديدة! ✅

الاسم: ${d.name}
الهاتف: ${d.phone}
البريد: ${d.email || 'غير مذكور'}

المنتج: ${d.productName}
الكمية: ${d.quantity}
الإجمالي الفرعي: ${d.subtotal} درهم${Number(d.discount) > 0 ? `
كود الخصم: ${d.promoCode} (− ${d.discount} درهم)` : ''}
المبلغ المدفوع: ${d.total} درهم

نوع الطلب: ${d.orderType || 'غير محدد'}
عنوان التوصيل: ${d.address}
ملاحظات: ${d.notes || 'لا يوجد'}`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: MAIL_FROM,
      to: NOTIFY_TO,
      subject: `✅ طلب جديد — ${d.productName}`,
      text,
    }),
  });
  if (!res.ok) throw new Error('Resend error: ' + (await res.text()));
}

app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const md = session.metadata || {};

    // ✅ نسجّل استخدام الكود بعد ما الدفع ينجح فعلاً (مش قبله)
    if (md.promoKey && PROMOS[md.promoKey]) PROMOS[md.promoKey].used++;

    try {
      await sendOrderEmail({
        name: md.name,
        phone: md.phone,
        email: session.customer_details?.email || '',
        productName: md.productName,
        quantity: md.quantity,
        subtotal: md.subtotal,
        discount: md.discount,
        promoCode: md.promoCode,
        total: session.amount_total / 100,
        orderType: md.orderType,
        address: md.address,
        notes: md.notes,
      });
      console.log('Order email sent for', session.id);
    } catch (e) {
      console.error('Failed to send order email:', e);
    }
  }

  res.json({ received: true });
});

app.use(express.json());

/* --------------------------------------------------------------------------
   /api/products — الموقع بيجيب الأسعار من هنا (وبيصحّي السيرفر كمان)
   -------------------------------------------------------------------------- */
app.get('/api/products', (req, res) => {
  const list = Object.entries(PRODUCTS)
    .filter(([, p]) => p.active && p.price > 0)
    .map(([id, p]) => ({
      id, ar: p.ar, en: p.en, price: p.price,
      descAr: p.descAr, descEn: p.descEn,
    }));
  res.json({ products: list });
});

/* --------------------------------------------------------------------------
   /api/validate-promo — التحقق من الكود
   -------------------------------------------------------------------------- */
app.post('/api/validate-promo', (req, res) => {
  const { code, quantity } = req.body || {};
  const r = validatePromo(code, Number(quantity) || 1);
  res.json({ valid: r.valid, type: r.type, value: r.value, label: r.label, reason: r.reason });
});

/* --------------------------------------------------------------------------
   /api/create-payment — إنشاء جلسة الدفع
   -------------------------------------------------------------------------- */
app.post('/api/create-payment', async (req, res) => {
  try {
    const { name, phone, email, quantity, address, notes, type,
            productId, promoCode } = req.body;

    if (!name || !phone || !address || !quantity) {
      return res.status(400).json({ error: 'بيانات الطلب ناقصة' });
    }

    // 💰 الحساب على السيرفر — الصفحة بعتت أسماء بس
    const o = priceOrder({ productId: productId || 'founder-6', quantity, promoCode });

    // الخصم بيتعمل ككوبون Stripe عشان يبان للعميل في صفحة الدفع
    let discounts = [];
    if (o.discount > 0) {
      const coupon = await stripe.coupons.create({
        amount_off: Math.round(o.discount * 100),
        currency: 'aed',
        duration: 'once',
        name: o.promoLabel,
        max_redemptions: 1,
      });
      discounts = [{ coupon: coupon.id }];
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'aed',
          product_data: {
            name: o.product.ar,
            description: o.product.descAr || undefined,
          },
          unit_amount: o.product.price * 100,   // Stripe بياخد المبلغ بالفلس
        },
        quantity: o.qty,
      }],
      discounts,
      customer_email: email || undefined,
      metadata: {
        name, phone, address,
        notes: notes || '',
        orderType: type || '',
        productId: o.productId,
        productName: o.product.ar,
        quantity: String(o.qty),
        subtotal: String(o.subtotal),
        discount: String(o.discount),
        promoCode: o.promoKey || '',
        promoKey: o.promoKey || '',
      },
      success_url: `${SITE}/thank-you.html?name=${encodeURIComponent(name)}&total=${o.total}`,
      cancel_url: `${SITE}/index.html#order`,
    });

    res.json({ paymentUrl: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'تعذر إنشاء صفحة الدفع' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ATHAR payment server running on port ${PORT}`);
  console.log(`✉️  المرسِل: ${MAIL_FROM}`);
  console.log(`📬 المستقبِل: ${NOTIFY_TO.join(', ') || '⚠️ غير محدد — NOTIFY_EMAIL فاضي!'}`);
  if (!process.env.RESEND_FROM)
    console.warn('⚠️  RESEND_FROM مش متظبط — الإيميلات بتتبعت من العنوان التجريبي وممكن تروح Junk');
  const bad = Object.entries(PRODUCTS).filter(([, p]) => p.active && !(p.price > 0));
  if (bad.length)
    console.warn('⚠️  منتجات مفعّلة بدون سعر:', bad.map(([id]) => id).join(', '));
});
