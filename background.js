// background.js

console.log("TransLearn Service Worker started.");
let isModelWarmedUp = false;

// --- Script Loading ---
try {
  importScripts('/prompt-manager.js', '/ai-client.js');
} catch (e) {
  console.error("Error importing AI client:", e);
}



// --- State Management ---
let currentAiController = new AbortController();
const activeSidePanelPorts = new Set();

let latestTranslationResult = {
  originalHtml: "<p>Select text on the page to begin.</p>",
  translatedTexts: ["..."],
  selectionRect: null,
  activeTabId: null,
  detectedLang: null,
  targetLang: 'en',
  warning: null
};

// --- Side Panel State ---
function isPanelOpen() {
  return activeSidePanelPorts.size > 0;
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "sidepanel") {
    console.log("Background: Side panel connected.");
    activeSidePanelPorts.add(port);
    port.onDisconnect.addListener(() => {
      activeSidePanelPorts.delete(port);
      console.log("Background: Side panel disconnected.");
    });
  }
});


// --- Main Message Listener ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // A. From Content Script: New text selected
  if (sender.tab && message.action === "textSelected") {
    if (isPanelOpen()) {

      chrome.runtime.sendMessage({ action: "resetUI" }).catch(e => {});


      processTextSelection(message.payload, false, sender.tab.id).then(() => {
        chrome.storage.local.get(['isInlineMode'], (result) => {
          if (result.isInlineMode !== false) {
            showOverlay();
          }
        });
      });
    }
    return true;
  }

  // B. From Content Script: OCR region captured
  if (message.action === "captureOcrRegion") {
    (async () => {
      await processTextSelection(message.payload, true, sender.tab.id);
      const result = await chrome.storage.local.get(['isInlineMode']);
      if (result.isInlineMode !== false) {
        showOverlay();
      }
    })();
    return true;
  }

  // C. From Side Panel: Request for latest data
  if (message.action === "getLatestTranslation") {
    sendResponse(latestTranslationResult);
    return true;
  }

  // D. From Side Panel: Activate OCR mode
  if (message.action === "activateOcrMode") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (tabs[0]) {
        await chrome.sidePanel.setOptions({ tabId: tabs[0].id, enabled: false });
        await chrome.scripting.executeScript({
          target: { tabId: tabs[0].id },
          files: ["ocr_overlay.js"]
        });
      }
    });
    return true;
  }

  // E. From Side Panel: Manual overlay request (in Panel Mode)
  if (message.action === "showOverlay") {
    showOverlay();
    return true;
  }

  // F. From Overlay: Re-translate with a new source language
  if (message.action === "forceTranslateWithNewSource") {
    const { newSourceLang } = message.payload;
    chrome.storage.local.set({ userSourceLang: newSourceLang });
    const tempPayload = {
      texts: getOriginalTextsFromHtml(latestTranslationResult.originalHtml),
      html: latestTranslationResult.originalHtml,
      selectionRect: latestTranslationResult.selectionRect
    };
    processTextSelection(tempPayload, false, latestTranslationResult.activeTabId).then(() => {
      showOverlay();
    });
    return true;
  }

  // G. From Side Panel: Request for word details (Deep Dive)
  if (message.action === "getWordDetails") {
    (async () => {
      const { word, sourceLang, targetLang } = message.payload;
      const onDetailChunk = (chunk) => {
        chrome.runtime.sendMessage({
          action: "wordDetailChunk",
          payload: { word: word, chunk: chunk }
        }).catch(e => {});
      };
      await getWordDetails(word, sourceLang, targetLang, onDetailChunk, new AbortController().signal);
    })();
    return true;
  }

  // H. From Side Panel: Request to simplify text
  if (message.action === "simplifyText") {
    (async () => {
      const { text, sourceLang, level } = message.payload;
      const onChunk = (chunk) => {
        chrome.runtime.sendMessage({
          action: "simplifiedTextChunk",
          payload: chunk
        }).catch(e => {});
      };
      await simplifyText(text, sourceLang, level, onChunk, new AbortController().signal);
    })();
    return true;
  }

  if (message.action === "warmUpModel") {
    // Check the flag to ensure this only runs once per service worker session.
    if (!isModelWarmedUp) {
      isModelWarmedUp = true; // Set the flag immediately
      console.log("Background: Received warm-up request. Initializing AI model...");
      // Call our fire-and-forget warm-up function.
      warmUpAiModel();
    } else {
      console.log("Background: Model is already warm. Ignoring warm-up request.");
    }
    return true; // No async response needed
  }
});


// --- Core Processing Logic ---

async function processTextSelection(input, isOcr = false, tabId = null) {
  currentAiController.abort("New selection made.");
  currentAiController = new AbortController();
  const signal = currentAiController.signal;

  try {
    
    const { userSourceLang = 'auto', userTargetLang = 'en' } = await chrome.storage.local.get(['userSourceLang', 'userTargetLang']);

    let sourceHtml;
    let textsToTranslate;
    let selectionRect;

    if (isOcr) {
      const ocrPayload = input;
      selectionRect = {
        top: ocrPayload.scaledRegion.top / ocrPayload.dpr,
        left: ocrPayload.scaledRegion.left / ocrPayload.dpr,
        width: ocrPayload.scaledRegion.width / ocrPayload.dpr,
        height: ocrPayload.scaledRegion.height / ocrPayload.dpr
      };
      const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
      const ocrText = await performOcrOnRegion(dataUrl, ocrPayload.scaledRegion);
      if (!ocrText || ocrText.startsWith("Error:")) {
        throw new Error(ocrText || "OCR failed.");
      }
      textsToTranslate = ocrText.split('\n\n').filter(p => p.trim() !== '');
      sourceHtml = textsToTranslate.map(p => `<p>${p}</p>`).join('');
    } else {
      selectionRect = input.selectionRect;
      sourceHtml = input.html;
      textsToTranslate = input.texts;
    }

    if (!textsToTranslate || textsToTranslate.length === 0) {
      return;
    }

    const separator = "\n<|>\n";
    const joinedText = textsToTranslate.join(separator);

    sendStatusUpdate("Analyzing text...", false);

    const translationResult = await translateText(joinedText, userSourceLang, userTargetLang, signal);
    const translatedTexts = translationResult.translatedText.split(separator.trim());
    const translatedFullText = translatedTexts.join(' ');
    

    latestTranslationResult = {
      originalHtml: sourceHtml,
      translatedTexts: translatedTexts,
      selectionRect: selectionRect,
      activeTabId: tabId,
      detectedLang: translationResult.detectedLang,
      targetLang: userTargetLang,
      warning: translationResult.warning
    };
    if (translationResult.detectedLang) {
      sendStatusUpdate(`Language detected: ${translationResult.detectedLang.toUpperCase()}`, true);
    }

    if (latestTranslationResult.warning) {
      sendStatusUpdate("Translation paused", true); // Update status on pause
      return;
    } else {
      sendStatusUpdate("Translation complete", true); // 2. Finish Translating

      chrome.runtime.sendMessage({ action: "newTranslationAvailable" }).catch(e => {});

      getAndStreamVocabulary(joinedText, translatedFullText, latestTranslationResult.detectedLang, userTargetLang, signal);
    }

    

  } catch (error) {
    if (error.name === 'AbortError') {
      console.log("Background: AI process was successfully aborted.");
    } else {
      console.error("An error occurred in processTextSelection:", error);
    }
  }
}


// --- Helper Functions ---

function showOverlay() {
  if (latestTranslationResult && latestTranslationResult.selectionRect && latestTranslationResult.activeTabId) {
    const translatedParagraphs = latestTranslationResult.translatedTexts.map(p => `<p>${p}</p>`).join('');
    chrome.tabs.sendMessage(latestTranslationResult.activeTabId, {
      action: "displayOverlay",
      payload: {
        htmlContent: translatedParagraphs,
        rect: latestTranslationResult.selectionRect,
        warning: latestTranslationResult.warning,
        detectedLang: latestTranslationResult.detectedLang,
        targetLang: latestTranslationResult.targetLang,
        originalHtml: latestTranslationResult.originalHtml
      }
    });
  }
}

async function getAndStreamVocabulary(sourceText, translatedText, sourceLang, targetLang, signal) {
  console.log("Background: Starting automatic vocabulary analysis stream.");
  sendStatusUpdate("Identifying key words...", false); // 3. Start Vocab Extraction

  const onInitialWords = (sourceWords) => {
    if (sourceWords && sourceWords.length > 0 && latestTranslationResult.activeTabId) {
      sendStatusUpdate("Identifying key words...", true);
      sendStatusUpdate("Key words identified", true); // 4. Finish Vocab Extraction
      sendStatusUpdate("Analyzing vocabulary...", false); // 5. Start Analysis
      console.log("Background: Relaying initial highlight message for words:", sourceWords);
      chrome.tabs.sendMessage(latestTranslationResult.activeTabId, {
        action: "initialHighlight",
        payload: { sourceWords: sourceWords }
      }).catch(e => console.log("Could not send initial highlight message."));
    } else {
      sendStatusUpdate("No key vocabulary found.", true);
    }
  };


  const onVocabLine = (line) => {
    const parts = line.split('|').map(s => s.trim());
    if (parts.length === 3) {
      const vocabCardData = {
        sourceWord: parts[0],
        pos: parts[1],
        translatedWord: parts[2]
      };
      if (latestTranslationResult && latestTranslationResult.activeTabId) {
        chrome.tabs.sendMessage(latestTranslationResult.activeTabId, {
          action: "highlightWord",
          payload: vocabCardData
        }).catch(e => {});
      }
      chrome.runtime.sendMessage({ action: "addVocabCard", payload: vocabCardData }).catch(e => {});
    }
  };
  try {
    // await getVocabulary(sourceText, translatedText, sourceLang, targetLang, onVocabLine, signal);
    // Call the upgraded getVocabulary function with BOTH callbacks.
    const vocabResult = await getVocabulary(sourceText, translatedText, sourceLang, targetLang, onInitialWords, onVocabLine, signal);

    sendStatusUpdate("Analysis complete", true); // 6. Finish Analysis
    // // 1. Await the result from getVocabulary, which now returns an object.
    // const vocabResult = await getVocabulary(sourceText, translatedText, sourceLang, targetLang, onVocabLine, signal);

    // // 2. If we got an initial list of words, relay the highlight message.
    // if (vocabResult && vocabResult.initialWords && latestTranslationResult.activeTabId) {
    //   console.log("Background: Relaying initial highlight message to content script for words:", vocabResult.initialWords);
    //   chrome.tabs.sendMessage(latestTranslationResult.activeTabId, {
    //     action: "initialHighlight",
    //     payload: { sourceWords: vocabResult.initialWords }
    //   }).catch(e => console.log("Could not send initial highlight message."));
    // }

    if (vocabResult && vocabResult.finalVocabulary) {
      // This message will now be sent with the correct data.
      chrome.runtime.sendMessage({
        action: "vocabStreamComplete",
        payload: vocabResult.finalVocabulary
      }).catch(e => {});
    }
  } catch (error) {
    if (error.name !== 'AbortError') {
      console.error("Background: Vocabulary analysis stream failed.", error);
    }
  }
}

function getOriginalTextsFromHtml(htmlString) {
  if (!htmlString) return [];
  const withSeparators = htmlString
    .replace(/<br\s*\/?>/gi, '|||')
    .replace(/<\/p>|<\/h[1-6]>|<\/li>|<\/blockquote>|<\/div>/gi, '|||');
  const plainText = withSeparators.replace(/<[^>]*>/g, ' ');
  const paragraphs = plainText.split('|||')
    .map(p => p.trim().replace(/\s+/g, ' '))
    .filter(p => p);
  return paragraphs;
}

async function performOcrOnRegion(dataUrl, region) {
  return new Promise(async (resolve) => {
    const listener = (message) => {
      if (message.action === 'ocrComplete') {
        chrome.runtime.onMessage.removeListener(listener);
        chrome.offscreen.closeDocument();
        resolve(message.payload);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    await sendToOffscreen({
      action: 'cropAndOcr',
      payload: { dataUrl, cropRegion: region }
    });
  });
}

async function sendToOffscreen(message) {
  if (await chrome.offscreen.hasDocument()) {
    // Document exists, send message
  } else {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['DOM_PARSER'],
      justification: 'Image cropping and OCR requires a DOM environment.',
    });
  }
  chrome.runtime.sendMessage(message);
}

/**
 * A "fire-and-forget" function to proactively initialize the AI model
 * by running a trivial prompt.
 */
async function warmUpAiModel() {
  try {
    // 1. Get the session. This is the part that takes time on a cold start.
    const session = await promptManager.getSession(new AbortController().signal);
    
    // 2. Execute a very simple, non-streaming prompt.
    const response = await session.prompt([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'TASK: Respond only with the word "Ready."' }
    ]);

    console.log(`Background: AI Model is warm and ready. Response: "${response}"`);
  } catch (error) {
    // If it fails, that's okay. The next real user prompt will try again.
    // We should reset the flag so the next warm-up attempt can proceed.
    isModelWarmedUp = false;
    console.error("Background: AI model warm-up failed.", error);
  }
}


function sendStatusUpdate(status, isComplete = false) {
  chrome.runtime.sendMessage({
    action: "statusUpdate",
    payload: { status, isComplete }
  }).catch(e => {});
}