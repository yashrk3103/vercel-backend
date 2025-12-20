require("dotenv").config();
const express = require("express");
const cors = require("cors");
const connectDB = require("./config/db");
const mongoose = require("mongoose");

const authRoutes = require('./routes/authRoutes');
const invoiceRoutes = require('./routes/invoiceRoutes');
const aiRoutes = require('./routes/aiRoutes');
const emailRoutes = require("./routes/emailRoutes");

const app = express();

// CORS Configuration
app.use(
  cors({
    origin: ["https://vercel-front-ten.vercel.app", "http://localhost:5173"],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true
  })
);

app.use(express.json());

// Health check
app.get("/", (req, res) => {
  res.json({ 
    message: "API is running...",
    timestamp: new Date().toISOString(),
    database: {
      status: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
    }
  });
});

// Database connection
let dbConnected = false;

const initializeDB = async () => {
  if (!dbConnected) {
    try {
      await connectDB();
      dbConnected = true;
      console.log('✓ Database connected');
      
      // Keep-alive ping every 5 minutes
      setInterval(async () => {
        try {
          if (mongoose.connection.readyState === 1) {
            await mongoose.connection.db.admin().ping();
            console.log('✓ Database keep-alive ping');
          }
        } catch (error) {
          console.error('✗ Keep-alive ping failed:', error.message);
        }
      }, 5 * 60 * 1000); // 5 minutes
      
    } catch (error) {
      console.error('✗ Database connection failed:', error);
      throw error;
    }
  }
};

app.use(async (req, res, next) => {
  try {
    await initializeDB();
    next();
  } catch (error) {
    console.error('Database initialization error:', error);
    res.status(500).json({ 
      error: "Database connection failed",
      message: error.message 
    });
  }
});

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/invoices", invoiceRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api", emailRoutes);

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ error: "Route not found", path: req.path });
});

// Error Handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ 
    error: "Internal server error",
    message: err.message 
  });
});

// Export for Vercel
module.exports = app;