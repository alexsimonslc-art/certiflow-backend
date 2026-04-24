// @ts-nocheck
const express = require('express');
const router  = express.Router();
const { GoogleGenerativeAI } = require('@google/generative-ai');

const MINISITE_PROMPT = `You are Gal AI, a friendly and creative assistant for Honourix Mini Sites.
You help users write compelling event page content: headlines, descriptions, CTAs, registration form copy, and design suggestions.
Keep responses concise, practical, and inspiring. Use a warm, professional tone.
If asked for copy/text, provide it directly. If asked for design advice, give specific actionable suggestions.
Never generate HTML or JSON — just plain conversational replies.`;

router.post('/chat', async (req, res) => {
  try {
    const { userMessage, chatHistory = [] } = req.body;
    if (!userMessage) return res.status(400).json({ error: 'userMessage required' });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

    const genAI  = new GoogleGenerativeAI(apiKey);
    const model  = genAI.getGenerativeModel({
      model: 'gemini-3-flash-preview',
      systemInstruction: MINISITE_PROMPT,
    });

    const history = (chatHistory || []).slice(-8).map(m => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.content }],
    }));

    const chat   = model.startChat({ history });
    const result = await chat.sendMessage(userMessage);
    const text   = result.response.text().trim();

    res.json({ message: text });
  } catch (err) {
    console.error('Minisite AI error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
