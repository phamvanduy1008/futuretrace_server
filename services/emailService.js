const nodemailer = require('nodemailer');
const axios = require('axios');

const emailProvider = process.env.EMAIL_PROVIDER || (process.env.RESEND_API_KEY ? 'resend' : 'smtp');

let transporter = null;

if (emailProvider === 'smtp') {
  const smtpPort = parseInt(process.env.SMTP_PORT || '587');
  const smtpHost = process.env.SMTP_HOST || 'smtp.gmail.com';
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;

  console.log('✉️ [SMTP Init] Khởi tạo dịch vụ email qua SMTP:', {
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    user: smtpUser,
    hasPassword: !!smtpPass,
    passwordLength: smtpPass ? smtpPass.length : 0
  });

  transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465, // true cho 465 (SSL), false cho các cổng khác như 587 (STARTTLS)
    auth: {
      user: smtpUser,
      pass: smtpPass
    },
    connectionTimeout: 15000, // Tăng lên 15 giây giới hạn kết nối
    greetingTimeout: 15000,   // Tăng lên 15 giây giới hạn chào hỏi
    socketTimeout: 15000,     // Tăng lên 15 giây giới hạn socket
    family: 4                 // Ép buộc sử dụng IPv4 tránh nghẽn IPv6 trên Render
  });

  // Kiểm tra kết nối SMTP ngay khi khởi chạy server
  transporter.verify((error, success) => {
    if (error) {
      console.error('❌ [SMTP Verify] Kết nối tới máy chủ SMTP thất bại:', {
        message: error.message,
        code: error.code,
        command: error.command,
        response: error.response,
        responseCode: error.responseCode
      });
    } else {
      console.log('✅ [SMTP Verify] Kết nối tới máy chủ SMTP thành công. Sẵn sàng gửi thư!');
    }
  });
} else if (emailProvider === 'resend') {
  console.log('✉️ [API Init] Khởi tạo dịch vụ email qua Resend HTTP API.');
} else if (emailProvider === 'sendgrid') {
  console.log('✉️ [API Init] Khởi tạo dịch vụ email qua SendGrid HTTP API.');
}

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

  if (emailProvider === 'smtp') {
    console.log(`✉️ [SMTP Send] Đang gửi OTP tới ${email}`);
    try {
      const info = await transporter.sendMail({
        from: `"FutureTrace" <${process.env.SMTP_USER}>`,
        to: email,
        subject: `[FutureTrace] Mã xác thực: ${otp}`,
        html
      });
      console.log(`✅ [SMTP Send] Gửi email thành công tới ${email}. MessageId: ${info.messageId}`);
      return info;
    } catch (error) {
      console.error(`❌ [SMTP Send] Gửi email thất bại tới ${email}:`, {
        message: error.message,
        code: error.code,
        command: error.command,
        response: error.response,
        responseCode: error.responseCode
      });
      throw error;
    }
  } 
  
  if (emailProvider === 'resend') {
    console.log(`✉️ [Resend API Send] Đang gửi OTP tới ${email}`);
    try {
      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey) {
        throw new Error('Thiếu RESEND_API_KEY trong cấu hình môi trường.');
      }
      
      const fromEmail = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
      
      const response = await axios.post('https://api.resend.com/emails', {
        from: `FutureTrace <${fromEmail}>`,
        to: [email],
        subject: `[FutureTrace] Mã xác thực: ${otp}`,
        html
      }, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      });
      
      console.log(`✅ [Resend API Send] Gửi email thành công tới ${email}. Id: ${response.data.id}`);
      return response.data;
    } catch (error) {
      console.error(`❌ [Resend API Send] Gửi email thất bại tới ${email}:`, 
        error.response ? error.response.data : error.message
      );
      const apiError = new Error(
        error.response && error.response.data && error.response.data.message 
          ? error.response.data.message 
          : error.message
      );
      apiError.code = 'API_ERROR';
      throw apiError;
    }
  }

  if (emailProvider === 'sendgrid') {
    console.log(`✉️ [SendGrid API Send] Đang gửi OTP tới ${email}`);
    try {
      const apiKey = process.env.SENDGRID_API_KEY;
      if (!apiKey) {
        throw new Error('Thiếu SENDGRID_API_KEY trong cấu hình môi trường.');
      }
      
      const fromEmail = process.env.SENDGRID_FROM_EMAIL;
      if (!fromEmail) {
        throw new Error('Thiếu SENDGRID_FROM_EMAIL trong cấu hình môi trường.');
      }

      const response = await axios.post('https://api.sendgrid.com/v3/mail/send', {
        personalizations: [
          {
            to: [{ email }]
          }
        ],
        from: {
          email: fromEmail,
          name: 'FutureTrace'
        },
        subject: `[FutureTrace] Mã xác thực: ${otp}`,
        content: [
          {
            type: 'text/html',
            value: html
          }
        ]
      }, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      });

      console.log(`✅ [SendGrid API Send] Gửi email thành công tới ${email}. Status: ${response.status}`);
      return { success: true };
    } catch (error) {
      console.error(`❌ [SendGrid API Send] Gửi email thất bại tới ${email}:`, 
        error.response ? error.response.data : error.message
      );
      const apiError = new Error(
        error.response && error.response.data && error.response.data.errors 
          ? JSON.stringify(error.response.data.errors) 
          : error.message
      );
      apiError.code = 'API_ERROR';
      throw apiError;
    }
  }

  throw new Error(`Email provider '${emailProvider}' không hợp lệ hoặc chưa được cấu hình.`);
};

module.exports = { sendOtpEmail };
