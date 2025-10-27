# TransLearn

**Turn any webpage, PDF, or image into an interactive language lesson.**

TransLearn uses **Chrome’s Built-in AI** to provide translations, vocabulary analysis, and definitions directly on any text — including PDFs and images.

---

## Key Features

- **OCR Support:** Translate text from images, PDFs, or slides. 
- **Inline Translation:** Select text and see a clean and structured overlay translation.  
- **Smart Vocabulary Extraction:** AI highlights the most important words, skipping filler words.  
- **Interactive Word Cards:** Hover for quick translations, click for full dictionary-style definitions.  
- **Personal Word Bank:** Save words and review later.

---

## Technology & Architecture

- **AI Engine:** Chrome’s built-in `LanguageModel` (Gemini Nano) runs locally for privacy.  
- **Prompt + Translator APIs:** Sentence/word level translation, Key vocabulary selection, and dictionary-type definitions, examples, and synonyms.  
- **Offscreen OCR:** Tesseract.js in an offscreen document, compliant with Manifest V3.  
- **Modular Structure:**  
  - `background.js` — orchestrates AI sessions.  
  - `content_script.js` — manages page interactions.  
  - `sidepanel.js` — main UI hub.  
  - `ai-client.js` — encapsulates all AI API calls.  
  - `offscreen.js` — handles OCR.

---

## Quick Start

1. Clone this repo.  
2. Go to `chrome://extensions` in Chrome.  
3. Enable **Developer mode** → **Load unpacked** → select the project folder.  
4. Open the side panel via the TransLearn icon and start learning!

---

**Privacy:** All AI processing is local. Your data never leaves your machine.

**Screenshot:** assets/screenshot.jpg 

**Demo:** 

---

**Transform reading into active language learning — instantly, privately, and interactively.**
