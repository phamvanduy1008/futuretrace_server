const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  },
  connectionTimeout: 10000, // 10 giây giới hạn kết nối
  greetingTimeout: 10000,   // 10 giây giới hạn chào hỏi SMTP
  socketTimeout: 10000      // 10 giây giới hạn socket
});

const sendOtpEmail = async (email, otp) => {
  const html = `
    <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 520px; margin: 0 auto; background: #0f172a; border-radius: 24px; overflow: hidden;">
      <div style="padding: 48px 40px 32px; text-align: center;">
        <div style="display: inline-block; background: #2563eb; color: white; font-weight: 900; font-size: 14px; letter-spacing: 2px; padding: 10px 24px; border-radius: 12px; margin-bottom: 32px;">
          FUTURETRACE
        </div>
        <h1 style="color: white; font-size: 24px; font-weight: 800; margin: 0 0 12px; letter-spacing: -0.5px;">
          Xác nhận Email của bạn
        </h1>
        <p style="color: #94a3b8; font-size: 14px; margin: 0 0 40px; line-height: 1.6;">
          Nhập mã bên dưới để hoàn tất đăng ký tài khoản FutureTrace.
        </p>
        <div style="background: #1e293b; border: 2px solid #334155; border-radius: 16px; padding: 32px; margin-bottom: 32px;">
          <p style="color: #64748b; font-size: 10px; font-weight: 800; letter-spacing: 3px; text-transform: uppercase; margin: 0 0 16px;">
            MÃ XÁC THỰC
          </p>
          <div style="font-size: 40px; font-weight: 900; letter-spacing: 12px; color: #3b82f6; font-family: 'Courier New', monospace;">
            ${otp}
          </div>
        </div>
        <p style="color: #64748b; font-size: 12px; margin: 0;">
          Mã có hiệu lực trong <strong style="color: #f59e0b;">5 phút</strong>. Không chia sẻ mã này với bất kỳ ai.
        </p>
      </div>
      <div style="background: #1e293b; padding: 24px 40px; text-align: center; border-top: 1px solid #334155;">
        <p style="color: #475569; font-size: 11px; margin: 0; font-weight: 600;">
          © ${new Date().getFullYear()} FutureTrace — Decision Research Platform
        </p>
      </div>
    </div>
  `;

  await transporter.sendMail({
    from: `"FutureTrace" <${process.env.SMTP_USER}>`,
    to: email,
    subject: `[FutureTrace] Mã xác thực: ${otp}`,
    html
  });
};

module.exports = { sendOtpEmail };
