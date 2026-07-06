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
app.use(cors());
app.use(express.json());

const stripe = Stripe(process.env.STRIPE_SECRET_KEY); // السر بيتحط هنا بس، مش في الموقع

// نسعّر المنتج هنا بأمان (السعر ميتحطش في المتصفح عشان محدش يغيّره)
const PRICE_PER_SET_AED = 500; // السعر الرسمي للطقم

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
      success_url: 'https://athar-gifts.com/thank-you.html',
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
