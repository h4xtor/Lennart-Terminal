const { chat } = require('../src/main/ai');
(async () => {
  let text = '';
  try {
    await chat({ provider: 'antigravity-cli', model: '' }, [{ role: 'user', content: 'Say OK and nothing else.' }], {
      system: 'You are a test assistant. Reply with a single word.',
      onToken: (t) => { text += t; },
    });
    console.log('AGY CHAT RESULT:', JSON.stringify(text.slice(0, 200)));
    process.exit(0);
  } catch (e) {
    console.log('AGY CHAT ERROR:', e.message);
    process.exit(1);
  }
})();
