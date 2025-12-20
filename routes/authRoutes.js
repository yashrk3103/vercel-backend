const express = require('express');
const { registerUser, loginUser, getMe, updateUserProfile } = require('../controllers/authController');
const { protect } = require('../middlewares/authMiddleware');

const router = express.Router();

// Test route to verify everything is working
router.get('/test', async (req, res) => {
  try {
    const User = require('../models/User');
    const mongoose = require('mongoose');
    const userCount = await User.countDocuments();
    
    res.json({ 
      success: true,
      message: 'Auth routes working!',
      database: {
        connected: mongoose.connection.readyState === 1,
        userCount: userCount
      },
      environment: {
        hasJWT: !!process.env.JWT_SECRET,
        hasMongo: !!process.env.MONGO_URI
      }
    });
  } catch (error) {
    res.status(500).json({ 
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

router.post('/register', registerUser);
router.post('/login', loginUser);
router.route('/me').get(protect, getMe).put(protect, updateUserProfile);

module.exports = router;