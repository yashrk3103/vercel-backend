const nodemailer = require("nodemailer");

const sendReminderEmail = async (req, res) => {
  try {
    const { clientEmail, clientName, reminderText, senderName } = req.body;

    if (!clientEmail || !clientName || !reminderText) {
      return res.status(400).json({ message: "Missing required fields." });
    }

    // Configure mail transporter (using Gmail SMTP)
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    // Extract subject & body from reminderText (AI-generated text)
    let subject = "Invoice Reminder";
    let body = reminderText;

    const subjectMatch = reminderText.match(/^Subject:\s*(.*)$/im);
    if (subjectMatch) {
      subject = subjectMatch[1].trim();
      body = reminderText.replace(subjectMatch[0], "").trim();
    }

    const mailOptions = {
      from: `"${senderName || "Your Business"}" <${process.env.EMAIL_USER}>`,
      to: clientEmail,
      subject,
      text: body,
    };

    await transporter.sendMail(mailOptions);

    console.log(`✅ Email sent to ${clientEmail}`);
    return res.status(200).json({ message: "Email sent successfully!" });
  } catch (error) {
    console.error("❌ Error sending email:", error);
    return res.status(500).json({ message: "Failed to send email.", error: error.message });
  }
};

module.exports = { sendReminderEmail };
