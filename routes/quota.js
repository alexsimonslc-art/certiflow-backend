const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const authMiddleware = require('../middleware/authMiddleware'); 

// We use a simple local JSON file for speed. You can migrate this to a real DB later!
const DB_FILE = path.join(__dirname, '../quota_db.json');

const getDB = () => {
    if (!fs.existsSync(DB_FILE)) return {};
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
};
const saveDB = (data) => fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));

router.get('/', authMiddleware, (req, res) => {
    const email = req.user.email; 
    if (!email) return res.status(400).json({ error: 'User email not found' });

    // Auto-detect Account Type
    const isWorkspace = !email.endsWith('@gmail.com') && !email.endsWith('@googlemail.com');
    const MAX_LIMIT = isWorkspace ? 1500 : 100;

    const db = getDB();
    
    // Get current Date (YYYY-MM-DD) based on IST (Chennai Time)
    const today = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Kolkata"})).toISOString().split('T')[0];

    // LAZY EVALUATION RESET LOGIC
    if (!db[email]) {
        db[email] = { sentToday: 0, lastSentDate: today, totalSent: 0 };
    } else {
        if (db[email].lastSentDate !== today) {
            db[email].sentToday = 0; // Midnight reset triggered!
            db[email].lastSentDate = today;
        }
    }
    saveDB(db);

    res.json({
        email,
        accountType: isWorkspace ? "Workspace" : "Standard",
        dailyLimit: MAX_LIMIT,
        sentToday: db[email].sentToday,
        remaining: MAX_LIMIT - db[email].sentToday
    });
});

module.exports = router;