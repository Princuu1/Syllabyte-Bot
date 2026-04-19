#!/bin/bash
echo "📦 Installing Chrome..."
npx puppeteer browsers install chrome
echo "🚀 Starting bot..."
node bot.js
