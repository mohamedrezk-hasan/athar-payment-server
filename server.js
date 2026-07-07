/**
 * أثر النخبة للهدايا — Backend لإنشاء جلسة دفع عبر Stripe
 * --------------------------------------------------------
 * الغرض: يحمي الـ Secret Key (متخزّنش أبداً جوه كود الموقع نفسه)
 * وينشئ "Checkout Session" آمنة من Stripe لكل طلب.
 *
 * طريقة التشغيل:
 *   1) npm init -y && npm install express cors dotenv stripe
 *   2) اعمل ملف .env جنب السيرفر وحط فيه: STRIPE_SECRET_KEY=sk_live_...
 *   3) node server.js
 *   4) انشره مجاناً على Render / Railway
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// نسعّر المنتج هنا بأمان (السعر ميتحطش في المتصفح عشان محدش يغيّره)
const PRICE_PER_SET_AED = 500; // السعر الرسمي للطقم

// إرسال إيميل تلقائي عبر Resend
async function sendOrderEmail(details) {
  const { name, phone, email, quantity, address, notes, total } = details;
  const text = `تم استلام دفعة جديدة!

الاسم: ${name}
الهاتف: ${phone}
البريد: ${email || 'غير مذكور'}
عدد الأطقم: ${quantity}
الإجمالي المدفوع: ${total} درهم
عنوان التوصيل: ${address}
ملاحظات: ${notes || 'لا يوجد'}`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'أثر النخبة للهدايا <onboarding@resend.dev>',
      to: process.env.NOTIFY_EMAIL, // إيميلك اللي سجلت بيه في Resend
      subject: '✅ دفع ناجح - طلب جديد فنجان المؤسس',
      text,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error('Resend error: ' + errText);
  }
}

// ⚠️ لازم express.raw هنا (قبل express.json) عشان Stripe يتأكد من توقيع الطلب
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const md = session.metadata || {};
    try {
      await sendOrderEmail({
        name: md.name,
        phone: md.phone,
        email: session.customer_details?.email || '',
        quantity: md.quantity,
        address: md.address,
        notes: md.notes,
        total: (session.amount_total / 100),
      });
      console.log('Order email sent for session', session.id);
    } catch (e) {
      console.error('Failed to send order email:', e);
    }
  }

  res.json({ received: true });
});

app.use(cors());
app.use(express.json());

app.post('/api/create-payment', async (req, res) => {
  try {
    const { name, phone, email, quantity, address, notes } = req.body;

    if (!name || !phone || !address || !quantity) {
      return res.status(400).json({ error: 'بيانات الطلب ناقصة' });
    }

    const qty = Number(quantity);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'], // Apple Pay/Google Pay بيظهروا تلقائياً لو الجهاز يدعمهم
      line_items: [
        {
          price_data: {
            currency: 'aed',
            product_data: {
              name: 'فنجان المؤسس — أثر النخبة للهدايا',
              description: `طقم ٦ فناجين — الكمية: ${qty}`,
            },
            unit_amount: PRICE_PER_SET_AED * 100, // Stripe بياخد المبلغ بالفلس (aed x100)
          },
          quantity: qty,
        },
      ],
      customer_email: email || undefined,
      metadata: { name, phone, address, notes: notes || '', quantity: String(qty) },
      success_url: `https://athar-gifts.com/thank-you.html?name=${encodeURIComponent(name)}&phone=${encodeURIComponent(phone)}&email=${encodeURIComponent(email||'')}&qty=${qty}&address=${encodeURIComponent(address)}&notes=${encodeURIComponent(notes||'')}&total=${qty*PRICE_PER_SET_AED}`,
      cancel_url: 'https://athar-gifts.com/index.html#order',
    });

    res.json({ paymentUrl: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'تعذر إنشاء صفحة الدفع' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Stripe payment server running on port ${PORT}`));
