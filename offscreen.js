// offscreen.js
// This script runs in the offscreen document and handles all heavy-lifting
// that the service worker cannot (DOM manipulation, Web Workers).
chrome.runtime.onMessage.addListener(handleMessages);
/**
Main message handler for the offscreen document.
@param {object} message The message from the background script.
*/
function handleMessages(message) {
if (message.action === 'cropAndOcr') {
// This new action does both steps in sequence.
cropAndThenOcr(message.payload.dataUrl, message.payload.cropRegion);
}
}
/**
Orchestrates the two-step process: first crop the image, then perform OCR on the result.
@param {string} dataUrl The base64 data URL of the full screenshot.
@param {object} cropRegion An object with { left, top, width, height }.
*/
async function cropAndThenOcr(dataUrl, cropRegion) {
try {
const croppedDataUrl = await cropImage(dataUrl, cropRegion);
const extractedText = await performOcr(croppedDataUrl);
// Send the final, successful result back to the background script.
chrome.runtime.sendMessage({
action: 'ocrComplete',
payload: extractedText
});
} catch (error) {
console.error("Offscreen pipeline error:", error);
// Send an error message back if any step fails.
chrome.runtime.sendMessage({
action: 'ocrComplete',
payload: `Error: ${error.message}`
});
}
}
/**
Crops an image from a data URL using a canvas.
This function is now refactored to return a Promise.
@param {string} dataUrl The base64 data URL of the full screenshot.
@param {object} cropRegion An object with { left, top, width, height }.
@returns {Promise<string>} A promise that resolves with the cropped image's data URL.
*/
function cropImage(dataUrl, cropRegion) {
return new Promise((resolve, reject) => {
const image = new Image();
image.onload = () => {
const canvas = document.createElement('canvas');
canvas.width = cropRegion.width;
canvas.height = cropRegion.height;
const ctx = canvas.getContext('2d');
ctx.drawImage(
image,
cropRegion.left, cropRegion.top, cropRegion.width, cropRegion.height,
0, 0, cropRegion.width, cropRegion.height
);
resolve(canvas.toDataURL('image/png'));
};
image.onerror = (err) => {
reject(new Error("Image failed to load for cropping."));
};
image.src = dataUrl;
});
}

/**
 * Groups lines of text into paragraphs using a hybrid geometric and content-aware approach.
 * It detects large vertical gaps for standard paragraphs and looks for list markers
 * to correctly separate items in a list.
 * @param {Array} lines - The array of line objects from Tesseract's result.
 * @returns {string} A single string where paragraphs/list items are separated by '\n\n'.
 */
function groupLinesIntoParagraphs(lines) {
  if (!lines || lines.length === 0) return "";
  if (lines.length === 1) return lines[0].text;

  const sortedLines = lines.sort((a, b) => a.bbox.y0 - b.bbox.y0);
  
  // --- NEW: A regular expression to detect common list markers ---
  // This looks for: a bullet (*, •, -), a number (1.), or a letter (a) or a.)) at the start of a line.
  const listMarkerRegex = /^\s*([*•\-«»+]|\d+\.|[a-zA-Z][.)])\s+/;

  const paragraphs = [];
  let currentParagraph = [sortedLines[0].text];

  for (let i = 1; i < sortedLines.length; i++) {
    const prevLine = sortedLines[i - 1];
    const currentLine = sortedLines[i];

    const prevLineHeight = prevLine.bbox.y1 - prevLine.bbox.y0;
    const verticalGap = currentLine.bbox.y0 - prevLine.bbox.y1;

    // --- THE NEW HYBRID LOGIC ---
    // A new paragraph starts if:
    // 1. The vertical gap is large (our original geometric rule).
    // OR
    // 2. The current line starts with a list marker (our new content-aware rule).
    if (verticalGap > prevLineHeight * 1.5 || listMarkerRegex.test(currentLine.text)) {
      // This is a paragraph or list item break.
      paragraphs.push(currentParagraph.join(' '));
      currentParagraph = [currentLine.text];
    } else {
      // This is a continuation of the same paragraph/list item.
      currentParagraph.push(currentLine.text);
    }
  }

  paragraphs.push(currentParagraph.join(' '));
  return paragraphs.join('\n\n');
}


// The performOcr function remains the same, as it correctly calls this function.
async function performOcr(dataUrl) {
  console.log("Offscreen: Starting Tesseract OCR with HYBRID paragraph detection.");

  const workerPath = chrome.runtime.getURL('/lib/worker.min.js');
  const corePath = chrome.runtime.getURL('/lib/tesseract-core.wasm.js');
  const langPath = chrome.runtime.getURL('/lib/');

  const worker = await Tesseract.createWorker('eng', 1, {
    workerPath,
    corePath,
    langPath,
    workerBlobURL: false,
    logger: m => console.log(`Tesseract (MV3): ${m.status}`, m.progress)
  });

  const result = await worker.recognize(dataUrl);
  await worker.terminate();

  console.log("Offscreen: Tesseract processing complete. Structuring text...");

  const structuredText = groupLinesIntoParagraphs(result.data.lines);
  
  return structuredText;
}