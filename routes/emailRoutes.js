const express = require("express");
const router = express.Router();
const { sendReminderEmail } = require("../controllers/emailController");

router.post("/send-reminder", sendReminderEmail);

module.exports = router;
