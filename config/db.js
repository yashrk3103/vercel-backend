const mongoose = require('mongoose');

let isConnected = false;

const connectDB = async () => {
  if (isConnected && mongoose.connection.readyState === 1) {
    console.log('✓ Using existing database connection');
    return;
  }

  try {
    if (!process.env.MONGO_URI) {
      throw new Error('MONGO_URI environment variable is not defined');
    }

    mongoose.set('strictQuery', false);
    mongoose.set('bufferCommands', false);
    
    const conn = await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
    });

    isConnected = conn.connections[0].readyState === 1;
    console.log(`✓ MongoDB Connected: ${conn.connection.host}`);
    
  } catch (error) {
    console.error('✗ MongoDB connection error:', error.message);
    isConnected = false;
    throw error;
  }
};

module.exports = connectDB;