const { GoogleGenerativeAI } = require("@google/generative-ai");
const Invoice = require("../models/Invoice");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";

async function extractResponseText(result) {
  try {
    if (!result?.response) return "";
    const response = result.response;
    const text = response.text();
    return text || "";
  } catch (err) {
    console.error("Error extracting response text:", err);
    return "";
  }
}

function simpleFallbackParse(text) {
  const result = {
    clientName: "",
    email: "",
    address: "",
    items: [],
  };

  if (!text || typeof text !== "string") return result;

  const clientMatch = text.match(/(?:Invoice for|Bill To|Client[:\-])\s*([A-Z0-9][A-Za-z0-9 .,&'-]{2,100})/i);
  if (clientMatch) result.clientName = clientMatch[1].trim();

  const emailMatch = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (emailMatch) result.email = emailMatch[0].trim();

  const addrMatch = text.match(/Address[:\-]\s*([\s\S]{5,200})/i);
  if (addrMatch) {
    result.address = addrMatch[1].split(/\r?\n/)[0].trim();
  }

  const lines = text.split(/\r?\n/);
  const itemRegex1 = /(\d+(?:\.\d+)?)\s*(?:x|×)?\s*(?:hours|hrs|units|pcs|pieces)?\s*(?:of)?\s*([A-Za-z0-9 \-_.&()]{3,80}?)\s*(?:at|@|for)?\s*\$?(\d+(?:\.\d+)?)(?:\/hour|\/hr| per hour)?/i;
  const itemRegex2 = /([A-Za-z0-9 \-_.&()]{3,80}?)\s*[-:]\s*\$?(\d+(?:\.\d+)?)/i;
  const currencyRegex = /\$?(\d+(?:\.\d+)?)/;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    let m = line.match(itemRegex1);
    if (m) {
      const qty = parseFloat(m[1]) || 1;
      const name = (m[2] || "Item").trim();
      const unitPrice = parseFloat(m[3]) || 0;
      result.items.push({ name, quantity: qty, unitPrice });
      continue;
    }

    m = line.match(itemRegex2);
    if (m) {
      const name = m[1].trim();
      const unitPrice = parseFloat(m[2]) || 0;
      result.items.push({ name, quantity: 1, unitPrice });
      continue;
    }

    if (currencyRegex.test(line) && /[A-Za-z]/.test(line)) {
      const priceMatch = line.match(currencyRegex);
      const name = line.replace(priceMatch[0], "").replace(/[-—:]/g, "").trim() || "Item";
      const unitPrice = parseFloat(priceMatch[1]) || 0;
      result.items.push({ name, quantity: 1, unitPrice });
    }
  }

  if (!result.clientName) {
    const firstLine = lines.find(l => l.trim());
    if (firstLine && firstLine.length < 60) result.clientName = firstLine.trim();
  }

  return result;
}

const parseInvoiceFromText = async (req, res) => {
  const { text } = req.body;

  if (!text) {
    return res.status(400).json({ message: "Text is required" });
  }

  try {
    const model = genAI.getGenerativeModel({ model: DEFAULT_MODEL });

    const prompt = `Extract invoice data from this text and return ONLY a valid JSON object with this exact structure:
{
  "clientName": "string",
  "email": "string or empty",
  "address": "string or empty",
  "items": [{"name": "string", "quantity": number, "unitPrice": number}]
}

Text to analyze:
${text}

Return only the JSON, no markdown formatting or explanation.`;

    const result = await model.generateContent(prompt);
    const responseText = await extractResponseText(result);
    
    const cleanedJson = responseText
      .replace(/```json/g, '')
      .replace(/```/g, '')
      .trim();

    try {
      const parsedData = JSON.parse(cleanedJson);
      return res.status(200).json(parsedData);
    } catch (parseErr) {
      console.warn("AI returned invalid JSON, using fallback:", cleanedJson);
      const fallback = simpleFallbackParse(text);
      return res.status(200).json({ ...fallback, aiError: "AI returned invalid JSON" });
    }

  } catch (error) {
    console.error("Error parsing invoice:", error);
    const fallback = simpleFallbackParse(text);
    return res.status(200).json({ ...fallback, aiError: error?.message });
  }
};

function buildFallbackReminder(invoice) {
  const clientName = invoice?.billTo?.clientName || "Valued Client";
  const invoiceNumber = invoice?.invoiceNumber || "Unknown";
  const amount = typeof invoice?.total === "number" ? invoice.total.toFixed(2) : "0.00";
  const dueDate = invoice?.dueDate ? new Date(invoice.dueDate).toLocaleDateString() : "the due date";
  const businessName = invoice?.billFrom?.businessName || "Our Company";

  return `Subject: Payment Reminder - Invoice #${invoiceNumber}

Hi ${clientName},

I hope you're doing well. This is a friendly reminder that Invoice #${invoiceNumber} for $${amount} is due on ${dueDate}.

If you have any questions or need additional information, please don't hesitate to reach out.

Thank you for your prompt attention to this matter.

Best regards,
${businessName}`;
}

const generateReminderEmail = async (req, res) => {
  const { invoiceId } = req.body;

  if (!invoiceId) {
    return res.status(400).json({ message: "Invoice ID is required" });
  }

  try {
    const invoice = await Invoice.findById(invoiceId);
    if (!invoice) {
      return res.status(404).json({ message: "Invoice not found" });
    }

    const clientName = invoice.billTo?.clientName || "Valued Client";
    const invoiceNumber = invoice.invoiceNumber || "Unknown";
    const amount = typeof invoice.total === "number" ? invoice.total.toFixed(2) : "0.00";
    const dueDate = invoice.dueDate ? new Date(invoice.dueDate).toLocaleDateString() : "the due date";
    const businessName = invoice.billFrom?.businessName || "Our Company";

    const model = genAI.getGenerativeModel({ 
      model: DEFAULT_MODEL,
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 500,
      }
    });

    const prompt = `Write a professional payment reminder email with these EXACT details:

Client Name: ${clientName}
Invoice Number: ${invoiceNumber}
Amount Due: $${amount}
Due Date: ${dueDate}
Business Name: ${businessName}

Requirements:
- First line must be: Subject: Payment Reminder - Invoice #${invoiceNumber}
- Start body with: Hi ${clientName},
- Be friendly and professional
- End signature with: Best regards,
${businessName}
- Total length: 4-5 sentences maximum
- No markdown formatting, no extra explanations

Write the complete email now:`;

    try {
      const result = await model.generateContent(prompt);
      let reminderText = await extractResponseText(result);
      
      reminderText = reminderText
        .replace(/^(Here's|Here is|Sure|Of course|Certainly)[^:\n]*/i, '')
        .trim();

      if (!reminderText.includes(businessName)) {
        reminderText = reminderText.replace(
          /(Best regards,?|Sincerely,?|Thank you,?)\s*$/i,
          `$1\n${businessName}`
        );
      }

      if (!reminderText || reminderText.length < 50) {
        console.warn("AI returned short response, using fallback");
        const fallback = buildFallbackReminder(invoice);
        return res.status(200).json({ reminderText: fallback, aiError: "AI response too short" });
      }

      return res.status(200).json({ reminderText });

    } catch (aiErr) {
      console.error("AI reminder generation error:", aiErr);
      const fallback = buildFallbackReminder(invoice);
      return res.status(200).json({ 
        reminderText: fallback, 
        aiError: aiErr?.message || "AI generation failed" 
      });
    }

  } catch (error) {
    console.error("Error generating reminder email:", error);
    res.status(500).json({ 
      message: "Failed to generate reminder email", 
      details: error?.message 
    });
  }
};

const getDashboardSummary = async (req, res) => {
  try {
    const invoices = await Invoice.find({ user: req.user.id });

    if (invoices.length === 0) {
      return res.status(200).json({ 
        insights: ["No invoice data available yet. Create your first invoice to get started!"] 
      });
    }

    const totalInvoices = invoices.length;
    const paidInvoices = invoices.filter(inv => inv.status === 'Paid');
    const unpaidInvoices = invoices.filter(inv => inv.status !== 'Paid');
    const totalRevenue = paidInvoices.reduce((acc, inv) => acc + inv.total, 0);
    const totalOutstanding = unpaidInvoices.reduce((acc, inv) => acc + inv.total, 0);

    const model = genAI.getGenerativeModel({ 
      model: DEFAULT_MODEL,
      generationConfig: {
        temperature: 0.8,
        maxOutputTokens: 300,
      }
    });

    const prompt = `Analyze this invoice data and provide 3 SHORT, actionable insights as a JSON array:

Stats:
- Total Invoices: ${totalInvoices}
- Paid: ${paidInvoices.length} ($${totalRevenue.toFixed(2)})
- Unpaid: ${unpaidInvoices.length} ($${totalOutstanding.toFixed(2)})

Return ONLY this format (no markdown):
{"insights": ["insight 1", "insight 2", "insight 3"]}

Keep each insight under 15 words. Be encouraging and actionable.`;

    try {
      const result = await model.generateContent(prompt);
      const responseText = await extractResponseText(result);
      const cleanedJson = responseText
        .replace(/```json/g, '')
        .replace(/```/g, '')
        .trim();
      
      const parsedData = JSON.parse(cleanedJson);
      return res.status(200).json(parsedData);

    } catch (aiErr) {
      console.error("AI dashboard summary error:", aiErr);
      return res.status(200).json({
        insights: [
          `You have ${totalInvoices} invoices totaling $${(totalRevenue + totalOutstanding).toFixed(2)}`,
          unpaidInvoices.length > 0 ? `${unpaidInvoices.length} unpaid invoices need attention` : "All invoices are paid - great job!",
          totalRevenue > 0 ? `Total revenue: $${totalRevenue.toFixed(2)}` : "Start sending invoices to track revenue"
        ]
      });
    }

  } catch (error) {
    console.error("Error generating dashboard summary:", error);
    res.status(500).json({ 
      message: "Failed to generate dashboard summary", 
      details: error?.message 
    });
  }
};

module.exports = { 
  parseInvoiceFromText, 
  generateReminderEmail, 
  getDashboardSummary 
};