// content_script.js

console.log("TransLearn content script loaded and ready.");

// --- Global State Flags ---
let debounceTimeout = null;
let lastSentText = '';
let isInteractingWithOverlay = false;
let isMouseDown = false;

// --- 1. Create the tooltip element once ---
let tooltip = document.createElement('div');
tooltip.id = 'translearn-tooltip';
document.body.appendChild(tooltip);

// And modify showTooltip again to make it visible
function showTooltip(event, text) {
  const targetSpan = event.target;
  const rect = targetSpan.getBoundingClientRect();

  tooltip.textContent = text;
  tooltip.style.visibility = 'visible'; // Make it visible before positioning

  // Now that it's visible, its dimensions are calculated, so we can center it.
  const tooltipWidth = tooltip.offsetWidth;
  const tooltipHeight = tooltip.offsetHeight;

  tooltip.style.left = `${rect.left + window.scrollX + (rect.width / 2) - (tooltipWidth / 2)}px`;
  tooltip.style.top = `${rect.top + window.scrollY - tooltipHeight - 5}px`;

  tooltip.style.opacity = '1';
  tooltip.style.transform = 'translateY(0)';
}

function hideTooltip() {
  tooltip.style.opacity = '0';
  tooltip.style.transform = 'translateY(5px)';
  // Hide it completely after the transition
  setTimeout(() => {
    tooltip.style.visibility = 'hidden';
  }, 200);
}


// --- Style Injection ---
// Inject CSS for the overlay and highlights directly into the page.
const style = document.createElement('style');
style.textContent = `
  .translearn-highlight {
    background-color: rgba(255, 229, 102, 0.6);
    border-bottom: 2px solid rgba(255, 196, 0, 0.7);
    border-radius: 3px;
    cursor: pointer;
    transition: background-color 0.2s ease;
  }
  .translearn-highlight:hover {
    background-color: rgba(255, 229, 102, 0.9);
  }
  .translearn-highlight-initial { /* For the source text */
    background-color: rgba(200, 220, 255, 0.7); /* A light blue */
    border-radius: 3px;
    transition: background-color 0.3s ease;
  }
  .translearn-highlight-done { /* The "completed" state for the source text */
    background-color: rgba(130, 170, 255, 0.9);
    font-weight: 500;
    cursor: pointer;
  }
  .translearn-highlight-translated { /* For the translated text */
    background-color: rgba(255, 229, 102, 0.6); /* The yellow from before */
    border-bottom: 2px solid rgba(255, 196, 0, 0.7);
    border-radius: 3px;
    cursor: pointer;
  }
  .translearn-highlight-translated:hover {
    background-color: rgba(255, 229, 102, 0.9);
  }
  #translearn-tooltip {
    position: absolute;
    background-color: #333;
    color: white;
    padding: 6px 10px;
    border-radius: 4px;
    font-size: 13px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    z-index: 100000000; /* Ensure it's on top of everything */
    pointer-events: none; /* So it doesn't interfere with mouse events */
    opacity: 0;
    transform: translateY(5px);
    transition: opacity 0.15s ease, transform 0.15s ease;
  }
  .translearn-highlight-initial {
    /* By default, the initial highlight is transparent. */
    background-color: transparent;
    border-radius: 3px;
    /* The transition is now defined on the base class. */
    transition: background-color 0.3s ease;
  }
  .translearn-highlight-initial.revealed {
    /* The "revealed" class sets the visible background color. */
    background-color: rgba(200, 220, 255, 0.7); /* Light blue */
  }
`;
document.head.appendChild(style);


// --- Main Message Listener ---
// Listens for commands from the background script.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "displayOverlay") {
        createOrUpdateOverlay(message.payload);
    }
    if (message.action === "highlightWord") {
        highlightWordInOverlay(message.payload);
    }
    if (message.action === "initialHighlight") {
      console.log("Received initialHighlight message:", message.payload.sourceWords); // For debugging
      initialHighlightInOverlay(message.payload.sourceWords);
  }
});


// --- Core Selection Logic ---

/**
 * Sets up a suite of unified event listeners to reliably detect when a user
 * has finished selecting text, while ignoring interactions with our own UI.
 */
function setupSelectionListeners() {
  // This is our single, unified trigger function.
  const triggerSelectionProcessing = (delay = 200) => {
    // ALWAYS clear any previous timer. This is the key to preventing race conditions.
    clearTimeout(debounceTimeout);

    // Set a new timer to process the selection after a short delay.
    debounceTimeout = setTimeout(() => {
      // The flags are still essential to prevent processing during a drag or overlay interaction.
      if (!isMouseDown && !isInteractingWithOverlay) {
        processSelection();
      }
    }, delay);
  };

  // This listener handles selections made by dragging or with the keyboard.
  document.addEventListener("selectionchange", () => {
    // If the mouse is down, it's a drag in progress. Do nothing.
    if (isMouseDown) {
      return;
    }
    // For non-drag selections, use a slightly longer delay to wait for the user to pause.
    triggerSelectionProcessing(400);
  });

  // This listener marks the START of a potential drag.
  document.addEventListener("mousedown", (e) => {
    if (e.target.closest('#translearn-overlay-container')) {
      return;
    }
    isMouseDown = true;
  });

  // This listener is the PRIMARY trigger for mouse-based selections (clicks, double-clicks, drag-release).
  document.addEventListener("mouseup", () => {
    if (!isMouseDown || isInteractingWithOverlay) {
      isMouseDown = false;
      return;
    }
    isMouseDown = false;

    // Use a very short delay for a responsive feel after a click or drag.
    // This will override any longer timer set by 'selectionchange'.
    triggerSelectionProcessing(50);
  });

  // The keyup listener is a good fallback and will also use the unified trigger.
  document.addEventListener("keyup", (e) => {
    if (isInteractingWithOverlay) {
      return;
    }
    if (e.key === "Shift") {
      triggerSelectionProcessing(50);
    }
  });
}

/**
 * Processes the user's selection, intelligently deconstructs it,
 * and sends the data to the background script.
 */
function processSelection() {
  
  const selection = window.getSelection();

  if (selection.anchorNode && selection.anchorNode.parentElement.closest('#translearn-overlay-container')) {
    return;
  }

  removeOverlayIfExists();

  if (!selection.rangeCount || selection.isCollapsed) {
    return;
  }

  const range = selection.getRangeAt(0);
  const plainText = range.toString().trim();

  if (plainText.length > 2 && plainText !== lastSentText) {
    lastSentText = plainText;

    const rect = range.getBoundingClientRect();
    const selectionRect = {
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height
    };

    const fragment = range.cloneContents();
    const tempDiv = document.createElement('div');
    tempDiv.appendChild(fragment);

    tempDiv.querySelectorAll('.mw-editsection').forEach(el => el.remove());

    const selectedHtml = tempDiv.innerHTML;
    const textsToTranslate = [];
    const allBlockElements = Array.from(tempDiv.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote, div'));

    if (allBlockElements.length === 0) {
      if (tempDiv.textContent.trim()) {
        textsToTranslate.push(tempDiv.textContent.trim());
      }
    } else {
      const topLevelBlockElements = allBlockElements.filter(el => {
        return !allBlockElements.includes(el.parentElement);
      });
      topLevelBlockElements.forEach(el => {
        if (el.textContent.trim()) {
          textsToTranslate.push(el.textContent.trim());
        }
      });
    }

    chrome.runtime.sendMessage({
      action: "textSelected",
      payload: {
        texts: textsToTranslate,
        html: selectedHtml,
        selectionRect: selectionRect
      }
    });
  }
}


// --- Overlay UI Management ---

/**
 * Removes any existing translation overlay from the page.
 */
function removeOverlayIfExists() {
    const existingOverlay = document.getElementById('translearn-overlay-container');
    if (existingOverlay) {
        existingOverlay.remove();
    }
    isInteractingWithOverlay = false;
}



function highlightWordInOverlay(wordData) {
  const overlay = document.getElementById('translearn-overlay-container');
  if (!overlay) return;

  // Part A: Highlight the translated word (yellow)
  const translatedContent = overlay.querySelector('.translated-text-content');
  

  const originalContent = overlay.querySelector('.original-text-content');
  if (originalContent) {
    originalContent.querySelectorAll('.translearn-highlight-initial, .translearn-highlight-done').forEach(span => {
      if (span.textContent.toLowerCase() === wordData.sourceWord.toLowerCase()) {
        span.classList.remove('translearn-highlight-initial');
        span.classList.add('translearn-highlight-done');
        span.style.cursor = 'pointer'; // Add a pointer cursor to indicate it's clickable.

        span.dataset.translatedWord = wordData.translatedWord;
        span.dataset.sourceWord = wordData.sourceWord;

        // The tooltip listener is correct.
        span.addEventListener('mouseenter', (e) => {
          showTooltip(e, `Translation: ${span.dataset.translatedWord}`);
        });
        span.addEventListener('mouseleave', hideTooltip);

        // --- THE FIX IS HERE: The click listener is now on the SOURCE word's span ---
        span.addEventListener('click', () => {
          chrome.runtime.sendMessage({
            action: "expandVocabCard",
            // We still use the translated word as the key, because that's what's
            // in the `data-word` attribute of the card in the side panel.
            // payload: { word: wordData.translatedWord }
            payload: { word: wordData.sourceWord }
          });
        });
        // --- END FIX ---
      }
    });
  }
}

/**
 * Creates and displays the translation overlay on the page with all features.
 */
// In content_script.js

function createOrUpdateOverlay(data) {
  removeOverlayIfExists();

  if (data.rect.bottom === undefined && data.rect.top !== undefined && data.rect.height !== undefined) {
    data.rect.bottom = data.rect.top + data.rect.height;
  }

  const overlay = document.createElement('div');
  overlay.id = 'translearn-overlay-container';

  Object.assign(overlay.style, {
    position: 'absolute',
    visibility: 'hidden',
    zIndex: '99999999',
    backgroundColor: 'rgba(255, 255, 240, 0.97)',
    backdropFilter: 'blur(4px)',
    border: '1px solid rgba(0, 0, 0, 0.1)',
    borderRadius: '8px',
    boxShadow: '0 5px 15px rgba(0,0,0,0.2)',
    padding: '12px',
    color: '#333',
    fontSize: '14px',
    lineHeight: '1.6',
    maxWidth: '450px',
    transition: 'opacity 0.2s ease-out, transform 0.2s ease-out'
  });

  // The `header` and `content` variables are no longer needed here.
  // We will create the specific containers inside the `else` block.

  if (data.warning) {
    overlay.innerHTML = `
      <div style="font-weight: 500; margin-bottom: 8px;">Language Mismatch</div>
      <p style="margin: 0 0 12px 0; font-size: 13px;">${data.warning}</p>
      <button id="force-translate-btn" style="width: 100%; padding: 8px; border: none; background-color: #1a73e8; color: white; border-radius: 4px; cursor: pointer;">
        Translate from ${data.detectedLang.toUpperCase()}
      </button>
    `;
    overlay.querySelector('#force-translate-btn').addEventListener('click', () => {
      chrome.runtime.sendMessage({
        action: "forceTranslateWithNewSource",
        payload: { newSourceLang: data.detectedLang }
      });
      overlay.innerHTML = '<p>Re-translating...</p>';
    });
  } else {
    // --- THE MODIFICATIONS START HERE ---

    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingBottom: '8px',
      marginBottom: '8px',
      borderBottom: '1px solid rgba(0,0,0,0.1)'
    });

    const langIndicator = document.createElement('span');
    langIndicator.textContent = `${data.detectedLang.toUpperCase()} → ${data.targetLang.toUpperCase()}`;
    Object.assign(langIndicator.style, {
      fontSize: '12px',
      fontWeight: '600',
      color: '#5f6368',
      textTransform: 'uppercase'
    });

    const controlsContainer = document.createElement('div');
    controlsContainer.style.display = 'flex';
    controlsContainer.style.gap = '8px';

    // Create a separate container for the translated text to get its textContent for copying.
    const translatedContentContainer = document.createElement('div');
    translatedContentContainer.className = 'translated-text-content'; // For the highlighter
    translatedContentContainer.innerHTML = data.htmlContent;

    const copyButton = document.createElement('button');
    Object.assign(copyButton.style, { border: 'none', backgroundColor: 'transparent', cursor: 'pointer', padding: '4px', display: 'flex', alignItems: 'center' });
    const copyIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#666" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
    const copiedIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="green" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
    copyButton.innerHTML = copyIcon;
    copyButton.title = "Copy text";
    copyButton.addEventListener('click', (e) => {
      e.stopPropagation();
      // Correctly target the textContent of the translated part only.
      navigator.clipboard.writeText(translatedContentContainer.textContent).then(() => {
        copyButton.innerHTML = copiedIcon;
        copyButton.title = "Copied!";
        setTimeout(() => { copyButton.innerHTML = copyIcon; copyButton.title = "Copy text"; }, 2000);
      });
    });

    const closeButton = document.createElement('button');
    Object.assign(closeButton.style, { border: 'none', backgroundColor: 'transparent', cursor: 'pointer', padding: '4px', display: 'flex', alignItems: 'center' });
    closeButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#666" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
    closeButton.title = "Close";
    closeButton.addEventListener('click', (e) => {
      e.stopPropagation();
      isInteractingWithOverlay = false;
      removeOverlayIfExists();
    });

    controlsContainer.appendChild(copyButton);
    controlsContainer.appendChild(closeButton);
    header.appendChild(langIndicator);
    header.appendChild(controlsContainer);

    // Create the container for the original text.
    const originalContentContainer = document.createElement('div');
    originalContentContainer.className = 'original-text-content'; // For the highlighter
    Object.assign(originalContentContainer.style, {
      fontSize: '12px',
      opacity: '0.7',
      marginBottom: '10px',
      paddingBottom: '10px',
      borderBottom: '1px dashed #ccc'
    });
    // originalContentContainer.innerHTML = data.originalHtml;
    originalContentContainer.innerHTML = sanitizeHtmlForDisplay(data.originalHtml);

    // Assemble the final overlay.
    overlay.appendChild(header);
    overlay.appendChild(originalContentContainer);
    overlay.appendChild(translatedContentContainer);

    // --- END MODIFICATIONS ---
  }

  document.body.appendChild(overlay);
  const overlayHeight = overlay.offsetHeight;
  const overlayWidth = overlay.offsetWidth;
  const margin = 8;

  const spaceAbove = data.rect.top;
  const spaceBelow = window.innerHeight - data.rect.bottom;
  let finalTop, finalLeft, transformOrigin;

  if (spaceBelow > overlayHeight + margin) {
    finalTop = data.rect.bottom + window.scrollY + margin;
    transformOrigin = 'top center';
  } else if (spaceAbove > overlayHeight + margin) {
    finalTop = data.rect.top + window.scrollY - overlayHeight - margin;
    transformOrigin = 'bottom center';
  } else {
    finalTop = window.scrollY + (window.innerHeight - overlayHeight) / 2;
    transformOrigin = 'center center';
  }

  let idealLeft = data.rect.left + window.scrollX + (data.rect.width - overlayWidth) / 2;
  finalLeft = Math.max(10, Math.min(idealLeft, window.innerWidth - overlayWidth - 10));

  Object.assign(overlay.style, {
    top: `${finalTop}px`,
    left: `${finalLeft}px`,
    transformOrigin: transformOrigin,
    opacity: '0',
    transform: 'scale(0.95)',
    visibility: 'visible'
  });

  setTimeout(() => {
    overlay.style.opacity = '1';
    overlay.style.transform = 'scale(1)';
  }, 10);

  overlay.addEventListener('mouseenter', () => { isInteractingWithOverlay = true; });
  overlay.addEventListener('mouseleave', () => { isInteractingWithOverlay = false; });
}

/**
 * Escapes special characters in a string so it can be safely used in a regular expression.
 * @param {string} string The string to escape.
 * @returns {string} The escaped string.
 */
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}




function initialHighlightInOverlay(sourceWords) {
  const overlay = document.getElementById('translearn-overlay-container');
  const originalContent = overlay?.querySelector('.original-text-content');
  if (!originalContent || sourceWords.length === 0) return;

  console.log("Applying initial highlight for words:", sourceWords);

  // --- NEW TWO-PASS ALGORITHM ---

  // --- Pass 1: Find all modification targets without changing the DOM ---
  const modifications = [];
  const combinedRegex = new RegExp(`\\b(${sourceWords.map(escapeRegExp).join('|')})\\b`, 'gi');

  const treeWalker = document.createTreeWalker(originalContent, NodeFilter.SHOW_TEXT);
  const nodesToProcess = [];
  // We need to gather the nodes first because the treeWalker is live.
  while (treeWalker.nextNode()) {
    nodesToProcess.push(treeWalker.currentNode);
  }

  nodesToProcess.forEach(node => {
    // We use exec() in a loop to find ALL matches within a single text node.
    let match;
    while ((match = combinedRegex.exec(node.textContent)) !== null) {
      modifications.push({
        node: node,
        match: match
      });
    }
  });

  // --- Pass 2: Apply modifications in reverse order for safety ---
  // Processing in reverse prevents the character indices of earlier matches from being invalidated.
  modifications.reverse().forEach(({ node, match }) => {
    const span = document.createElement('span');
    span.className = 'translearn-highlight-initial';
    span.textContent = match[0]; // The matched word

    // Create a range to replace the matched text with our new span
    const range = document.createRange();
    range.setStart(node, match.index);
    range.setEnd(node, match.index + match[0].length);
    range.deleteContents(); // Remove the plain text
    range.insertNode(span); // Insert the styled span
  });

  // --- Animate the highlights one by one ---
  const spans = originalContent.querySelectorAll('.translearn-highlight-initial');
  let i = 0;
  function revealNext() {
    if (i >= spans.length) return;
    // // The spans are already in the DOM, we just make them "appear" with a style change.
    // spans[i].style.transition = 'background-color 0.3s ease';
    // spans[i].style.backgroundColor = 'rgba(200, 220, 255, 0.7)';

    spans[i].classList.add('revealed');
    i++;
    setTimeout(revealNext, 150);
  }

  // // To make them animate in, we first need to hide them.
  // spans.forEach(span => {
  //   span.style.backgroundColor = 'transparent';
  // });

  // Start the animation cascade.
  setTimeout(revealNext, 200);
}


/**
 * A simple sanitizer to remove unwanted tags and all attributes for display.
 * @param {string} dirtyHtml The HTML string to clean.
 * @returns {string} The sanitized HTML string.
 */
function sanitizeHtmlForDisplay(dirtyHtml) {
  const allowedTags = ['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'LI', 'UL', 'OL', 'BR', 'STRONG', 'EM', 'B', 'I'];
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = dirtyHtml;

  tempDiv.querySelectorAll('*').forEach(el => {
      for (const attr of Array.from(el.attributes)) {
          el.removeAttribute(attr.name);
      }
  });

  tempDiv.querySelectorAll('*').forEach(el => {
      if (!allowedTags.includes(el.tagName)) {
          el.replaceWith(...el.childNodes);
      }
  });

  return tempDiv.innerHTML;
}


// --- Initialize the Listeners ---
setupSelectionListeners();