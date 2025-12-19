const { GoogleGenAI } = require("@google/genai");
const Invoice = require("../models/Invoice");

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-pro";

async function extractResponseText(response) {
  try {
    if (!response) return "";
    if (typeof response === "string") return response;
    if (typeof response.text === "string") return response.text;
    if (typeof response.text === "function") return await response.text();

    // @google/genai responses often contain output -> content arrays
    if (Array.isArray(response.output)) {
      const parts = [];
      for (const out of response.output) {
        if (Array.isArray(out?.content)) {
          for (const c of out.content) {
            if (typeof c?.text === "string") parts.push(c.text);
            else if (typeof c?.text === "function") parts.push(await c.text());
          }
        }
      }
      if (parts.length) return parts.join("\n\n");
    }

    // Fallback: try stringify
    return JSON.stringify(response);
  } catch (err) {
    return "";
  }
}

// Basic fallback parser when AI fails or returns invalid JSON.
// Attempts to extract client name, email, address and items from plain text.
function simpleFallbackParse(text) {
  const result = {
    clientName: "",
    email: "",
    address: "",
    items: [],
  };

  if (!text || typeof text !== "string") return result;

  // Try to find client name (patterns like "Invoice for X", "Bill To: X", "Client: X")
  const clientMatch = text.match(/(?:Invoice for|Bill To|Client[:\-])\s*([A-Z0-9][A-Za-z0-9 .,&'-]{2,100})/i);
  if (clientMatch) result.clientName = clientMatch[1].trim();

  // Email
  const emailMatch = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (emailMatch) result.email = emailMatch[0].trim();

  // Address: try to capture multi-line block starting with Address:
  const addrMatch = text.match(/Address[:\-]\s*([\s\S]{5,200})/i);
  if (addrMatch) {
    result.address = addrMatch[1].split(/\r?\n/)[0].trim();
  }

  // Find item lines like "2 hours of design work at $150/hr" or "1 logo for $800" or "Design - $300"
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

    // catch standalone price lines like "$800 — Logo"
    if (currencyRegex.test(line) && /[A-Za-z]/.test(line)) {
      const priceMatch = line.match(currencyRegex);
      const name = line.replace(priceMatch[0], "").replace(/[-—:]/g, "").trim() || "Item";
      const unitPrice = parseFloat(priceMatch[1]) || 0;
      result.items.push({ name, quantity: 1, unitPrice });
    }
  }

  // If still no clientName, try first non-empty line as client
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
    const prompt = `
      You are an expert invoice data extraction AI. Analyze the following text and extract the relevant information to create an invoice.
      The output MUST be a valid JSON object.

      The JSON object should have the following structure:
      {
        "clientName": "string",
        "email": "string (if available)",
        "address": "string (if available)",
        "items": [
          {
            "name": "string",
            "quantity": "number",
            "unitPrice": "number"
          }
        ]
      }

      Here is the text to parse:
      --- TEXT START ---
      ${text}
      --- TEXT END ---

      Extract the data and provide only the JSON object.
    `;

    // Try AI generation and robustly handle failures / invalid JSON
    let aiResponse;
    try {
      aiResponse = await ai.models.generateContent({
        model: DEFAULT_MODEL,
        contents: prompt,
      });
    } catch (aiErr) {
      console.error("AI parseInvoiceFromText error:", aiErr);
      // Return fallback parse and include aiError so frontend can log if needed
      const fallback = simpleFallbackParse(text);
      return res.status(200).json({ ...fallback, aiError: aiErr?.message || "AI generation failed" });
    }

    const responseText = await extractResponseText(aiResponse);
    const cleanedJson = responseText.replace(/```json/g, '').replace(/```/g, '').trim();

    // Try to parse AI JSON, fall back if invalid
    try {
      const parsedData = JSON.parse(cleanedJson);
      return res.status(200).json(parsedData);
    } catch (parseErr) {
      console.warn("AI returned non-JSON or invalid JSON for invoice parsing, using fallback parser. AI output:", cleanedJson);
      const fallback = simpleFallbackParse(text);
      return res.status(200).json({ ...fallback, aiError: "AI returned invalid JSON" });
    }

  } catch (error) {
    console.error("Unexpected error parsing invoice with AI:", error);
    // Final fallback: return basic parse so frontend can continue
    const fallback = simpleFallbackParse(text);
    return res.status(200).json({ ...fallback, aiError: error?.message || "Unexpected server error" });
  }
};

// Helper to build a simple fallback reminder email
function buildFallbackReminder(invoice) {
  const clientName = invoice?.billTo?.clientName || "Valued Client";
  const invoiceNumber = invoice?.invoiceNumber || "Unknown";
  const amount = typeof invoice?.total === "number" ? invoice.total.toFixed(2) : "an amount";
  const dueDate = invoice?.dueDate ? new Date(invoice.dueDate).toLocaleDateString() : "the due date";

  return `Subject: Friendly reminder — Invoice #${invoiceNumber} due

Hi ${clientName},

I hope you're well. This is a friendly reminder that invoice #${invoiceNumber} for $${amount} is ${invoice?.status === 'Paid' ? 'marked as paid' : `due on ${dueDate}`}. Please let us know if you have any questions or need additional information.

Thank you for your prompt attention.

Best regards,
[Your Company Name]`;
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

    const prompt = `
You are a professional and polite accounting assistant. Write a friendly reminder email to a client about an overdue or upcoming invoice payment.

Use the following details to personalize the email:
- Client Name: ${invoice.billTo?.clientName || "Valued Client"}
- Invoice Number: ${invoice.invoiceNumber || "Unknown"}
- Amount Due: ${typeof invoice.total === "number" ? invoice.total.toFixed(2) : "an amount"}
- Due Date: ${invoice.dueDate ? new Date(invoice.dueDate).toLocaleDateString() : "the due date"}
- Business Name: ${invoice.billFrom?.businessName || "Our Company"}

The email must:
- Start with "Subject:" as the first line.
- Begin the body with "Hi {Client Name}," without any intro like "Of course!" or explanations.
- Maintain a friendly, clear, concise tone.
- End with a proper closing that includes the Business Name in the signature.
`;


    // Try AI generation, but do not fail the entire request if AI fails
    try {
      const response = await ai.models.generateContent({
        model: DEFAULT_MODEL,
        contents: prompt,
      });

      const reminderText = await extractResponseText(response);
      console.log("AI reminder email text:", reminderText);
      // if AI returned empty or useless text, fallback
      if (!reminderText || reminderText.trim().length < 10) {
        console.warn("AI returned empty or short reminder, using fallback.");
        const fallback = buildFallbackReminder(invoice);
        return res.status(200).json({ reminderText: fallback, aiError: "AI returned empty response" });
      }

      return res.status(200).json({ reminderText });
    } catch (aiErr) {
      console.error("AI generateReminderEmail error:", aiErr);
      // Return fallback reminder and include a short aiError message
      const fallback = buildFallbackReminder(invoice);
      return res.status(200).json({ reminderText: fallback, aiError: aiErr?.message || "AI generation failed" });
    }

  } catch (error) {
    console.error("Error generating reminder email with AI:", error);
    res.status(500).json({ message: "Failed to generate reminder email.", details: error?.message || String(error) });
  }
};

const getDashboardSummary = async (req, res) => {
  try {
    const invoices = await Invoice.find({ user: req.user.id });

    if (invoices.length === 0) {
      return res.status(200).json({ insights: ["No invoice data available to generate insights."] });
    }

    // Process and summarize data
    const totalInvoices = invoices.length;
    const paidInvoices = invoices.filter(inv => inv.status === 'Paid');
    const unpaidInvoices = invoices.filter(inv => inv.status !== 'Paid');
    const totalRevenue = paidInvoices.reduce((acc, inv) => acc + inv.total, 0);
    const totalOutstanding = unpaidInvoices.reduce((acc, inv) => acc + inv.total, 0);
    
    const dataSummary = `
      - Total number of invoices: ${totalInvoices}
      - Total paid invoices: ${paidInvoices.length}
      - Total unpaid/pending invoices: ${unpaidInvoices.length}
      - Total revenue from paid invoices: ${totalRevenue.toFixed(2)}
      - Total outstanding amount from unpaid/pending invoices: ${totalOutstanding.toFixed(2)}
      - Recent invoices (last 5): ${invoices.slice(0, 5).map(inv => `Invoice #${inv.invoiceNumber} for ${inv.total.toFixed(2)} with status ${inv.status}`).join(', ')}
    `;

    const prompt = `
      You are a friendly and insightful financial analyst for a small business owner.
      Based on the following summary of their invoice data, provide 2-3 concise and actionable insights.
      Each insight should be a short string in a JSON array.
      The insights should be encouraging and helpful. Do not just repeat the data.
      For example, if there is a high outstanding amount, suggest sending reminders. If revenue is high, be encouraging.

      Data Summary:
      ${dataSummary}

      Return your response as a valid JSON object with a single key "insights" which is an array of strings.
      Example format: { "insights": ["Your revenue is looking strong this month!", "You have 5 overdue invoices. Consider sending reminders to get paid faster."] }
    `;

    const response = await ai.models.generateContent({
      model: DEFAULT_MODEL,
      contents: prompt,
    });

    const responseText = await extractResponseText(response);
    const cleanedJson = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsedData = JSON.parse(cleanedJson);

    res.status(200).json(parsedData);
  } catch (error) {
    console.error("Error dashboard summary with AI:", error);
    res.status(500).json({ message: "Failed to parse invoice data from text.", details: error?.message || String(error) });
  }
};

// Add this function to list models
async function listModels() {
  try {
    const models = await ai.models.list();
    console.log("Available models:", models);
  } catch (err) {
    console.error("Failed to list models:", err);
  }
}

// For debug: call listModels() once manually if you want to inspect available models,
// do NOT leave it enabled on module load to avoid side effects in production.
// listModels();

module.exports = { parseInvoiceFromText, generateReminderEmail, getDashboardSummary };