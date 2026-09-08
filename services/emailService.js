const nodemailer = require('nodemailer');
const axios = require('axios');

// Khởi tạo SMTP Transporter nếu có cấu hình SMTP
let smtpTransporter = null;
if (process.env.SMTP_USER && process.env.SMTP_PASS) {
  const smtpPort = parseInt(process.env.SMTP_PORT || '465');
  smtpTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: smtpPort,
    secure: smtpPort === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000
  });
  console.log('✉️ [SMTP Init] Khởi tạo dịch vụ email qua Gmail / SMTP thành công.');
} else {
  console.log('ℹ️ [SMTP Init] Không tìm thấy cấu hình SMTP_USER / SMTP_PASS.');
}

const sendOtpEmail = async (email, otp, options = {}) => {
  const isReset = options.type === 'reset_password';
  const title = isReset ? 'Đặt lại Mật khẩu của bạn' : 'Xác nhận Email của bạn';
  const desc = isReset 
    ? 'Nhập mã xác thực bên dưới để hoàn tất việc đặt lại mật khẩu mới cho tài khoản FutureTrace của bạn.' 
    : 'Nhập mã bên dưới để hoàn tất đăng ký tài khoản FutureTrace.';
  const subject = isReset 
    ? `[FutureTrace] Mã xác nhận đặt lại mật khẩu: ${otp}` 
    : `[FutureTrace] Mã xác thực: ${otp}`;
  const codeLabel = isReset ? 'MÃ ĐẶT LẠI MẬT KHẨU' : 'MÃ XÁC THỰC';

  const html = `
    <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 520px; margin: 0 auto; background: #0f172a; border-radius: 24px; overflow: hidden;">
      <div style="padding: 48px 40px 32px; text-align: center;">
        <div style="display: inline-block; background: #2563eb; color: white; font-weight: 900; font-size: 14px; letter-spacing: 2px; padding: 10px 24px; border-radius: 12px; margin-bottom: 32px;">
          FUTURETRACE
        </div>
        <h1 style="color: white; font-size: 24px; font-weight: 800; margin: 0 0 12px; letter-spacing: -0.5px;">
          ${title}
        </h1>
        <p style="color: #94a3b8; font-size: 14px; margin: 0 0 40px; line-height: 1.6;">
          ${desc}
        </p>
        <div style="background: #1e293b; border: 2px solid #334155; border-radius: 16px; padding: 32px; margin-bottom: 32px;">
          <p style="color: #64748b; font-size: 10px; font-weight: 800; letter-spacing: 3px; text-transform: uppercase; margin: 0 0 16px;">
            ${codeLabel}
          </p>
          <div style="font-size: 40px; font-weight: 900; letter-spacing: 12px; color: #3b82f6; font-family: 'Courier New', monospace;">
            ${otp}
          </div>
        </div>
        <p style="color: #64748b; font-size: 12px; margin: 0;">
          Mã có hiệu lực trong <strong style="color: #f59e0b;">10 phút</strong>. Không chia sẻ mã này với bất kỳ ai để bảo vệ tài khoản.
        </p>
      </div>
      <div style="background: #1e293b; padding: 24px 40px; text-align: center; border-top: 1px solid #334155;">
        <p style="color: #475569; font-size: 11px; margin: 0; font-weight: 600;">
          © ${new Date().getFullYear()} FutureTrace — Decision Research Platform
        </p>
      </div>
    </div>
  `;

  // 1. Ưu tiên gửi qua Brevo nếu có cấu hình BREVO_API_KEY
  if (process.env.BREVO_API_KEY && process.env.BREVO_FROM_EMAIL) {
    console.log(`✉️ [Brevo API Send] Đang gửi OTP tới ${email} (${isReset ? 'Reset Password' : 'Register'})`);
    try {
      const response = await axios.post('https://api.brevo.com/v3/smtp/email', {
        sender: {
          name: 'FutureTrace',
          email: process.env.BREVO_FROM_EMAIL
        },
        to: [{ email: email }],
        subject: subject,
        htmlContent: html
      }, {
        headers: {
          'api-key': process.env.BREVO_API_KEY,
          'Content-Type': 'application/json',
          'accept': 'application/json'
        }
      });
      console.log(`✅ [Brevo API Send] Gửi email thành công tới ${email}. MessageId: ${response.data.messageId}`);
      return response.data;
    } catch (error) {
      console.error(`⚠️ [Brevo API Send] Lỗi khi gửi qua Brevo, chuyển sang phương thức dự phòng SMTP...`, error.message);
    }
  }

  // 2. Sử dụng SMTP Gmail nếu có cấu hình
  if (smtpTransporter) {
    console.log(`✉️ [SMTP Send] Đang gửi OTP tới ${email} qua Gmail (${process.env.SMTP_USER})...`);
    try {
      const info = await smtpTransporter.sendMail({
        from: `"FutureTrace" <${process.env.SMTP_USER}>`,
        to: email,
        subject: subject,
        html: html
      });
      console.log(`✅ [SMTP Send] Gửi email thành công tới ${email}. MessageId: ${info.messageId}`);
      return info;
    } catch (error) {
      console.error(`❌ [SMTP Send] Gửi email thất bại tới ${email}:`, error.message);
      throw error;
    }
  }

  // 3. Dự phòng cho môi trường dev nếu chưa cấu hình bất kỳ dịch vụ mail nào
  console.warn(`⚠️ [Dev Mock] Không có Brevo hoặc SMTP được cấu hình. Mã OTP cho ${email} là: ${otp}`);
  return { mock: true, otp };
};

module.exports = { sendOtpEmail };
