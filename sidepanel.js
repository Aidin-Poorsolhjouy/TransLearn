// sidepanel.js

// --- CONSTANTS ---
// A list of commonly used languages. In a real app, this could be more extensive.
const LANGUAGES = {
  'en': 'English',
  'es': 'Spanish',
  'fr': 'French',
  'de': 'German',
  'nl': 'Dutch',
  'it': 'Italian',
  'pt': 'Portuguese',
};

// --- UI Elements ---
let sourceLangSelect;
let targetLangSelect;
let originalContainer;
let translatedContainer;

let renderedWords = new Set();
let completedStatuses = new Set();

// --- Main Setup ---
document.addEventListener('DOMContentLoaded', () => {
  // Get references to all our UI elements.
  sourceLangSelect = document.getElementById('source-lang-select');
  targetLangSelect = document.getElementById('target-lang-select');
  originalContainer = document.getElementById('original-text-container');
  translatedContainer = document.getElementById('translated-text-container');

  // --- THE PORT CONNECTION ---
// Open a connection to the background script.
// We can name it to identify its purpose.
const port = chrome.runtime.connect({ name: "sidepanel" });

// We don't need to do anything else with the port on this side,
// but it's good practice to log if it disconnects unexpectedly.
port.onDisconnect.addListener(() => {
  console.log("Side panel port disconnected.");
});

chrome.runtime.sendMessage({ action: "warmUpModel" });
  
  // Initialize all features.
  setupTabs();
  setupLanguageSelectors();
  setupOcrButton();
  listenForBackgroundMessages();
  // setupCardClickListener();
  setupSimplifyControls();
  // setupVocabularyControls();
  setupOverlayButton();
  setupModeToggle();
  // setupSaveButtonListener();
  // loadSavedWords();
  setupCardInteractions();

  // When the panel first opens, fetch the initial data.
  fetchLatestTranslation();
});


function setupModeToggle() {
  const modeToggleSwitch = document.getElementById('mode-toggle-switch');
  const translateTabButton = document.querySelector('.tab-button[data-tab="translate"]');
  const translateTabContent = document.getElementById('translate-content');
  const overlayButton = document.querySelector('.overlay-button');

  function setMode(isInlineMode) {
    // Update the UI based on the mode
    if (isInlineMode) {
      // INLINE MODE: Hide the Translate tab and Overlay button
      translateTabButton.style.display = 'none';
      if (overlayButton) overlayButton.style.display = 'none';
      // If the hidden tab was active, switch to the vocabulary tab
      if (translateTabContent.classList.contains('active')) {
        document.querySelector('.tab-button[data-tab="vocabulary"]').click();
      }
    } else {
      // PANEL MODE: Show the Translate tab and Overlay button
      translateTabButton.style.display = 'block';
      if (overlayButton) overlayButton.style.display = 'block';
    }
    // Sync the toggle's visual state
    modeToggleSwitch.checked = isInlineMode;
  }

  // Load the saved setting when the panel opens
  chrome.storage.local.get(['isInlineMode'], (result) => {
    // Default to 'true' (inline mode enabled)
    setMode(result.isInlineMode !== false);
  });

  // Save the setting and update UI when the user clicks the toggle
  modeToggleSwitch.addEventListener('change', () => {
    const newMode = modeToggleSwitch.checked;
    chrome.storage.local.set({ isInlineMode: newMode });
    setMode(newMode);
  });
}

/**
 * Populates the language dropdowns and sets up listeners to save preferences.
 */
function setupLanguageSelectors() {
  // Populate the "Translate to" dropdown.
  for (const [code, name] of Object.entries(LANGUAGES)) {
    const option = new Option(name, code);
    targetLangSelect.add(option);
  }

  // Populate the "Translate from" dropdown, adding "Auto-Detect" at the top.
  sourceLangSelect.add(new Option("Auto-Detect", "auto"));
  for (const [code, name] of Object.entries(LANGUAGES)) {
    const option = new Option(name, code);
    sourceLangSelect.add(option);
  }

  // --- Event Listeners to Save Preferences ---
  sourceLangSelect.addEventListener('change', () => {
    chrome.storage.local.set({ userSourceLang: sourceLangSelect.value });
    console.log(`Source language saved: ${sourceLangSelect.value}`);
  });

  targetLangSelect.addEventListener('change', () => {
    chrome.storage.local.set({ userTargetLang: targetLangSelect.value });
    console.log(`Target language saved: ${targetLangSelect.value}`);
  });

  // --- Load Saved Preferences ---
  loadLanguagePreferences();
}

/**
 * Loads language preferences from chrome.storage and updates the UI.
 */
function loadLanguagePreferences() {
  chrome.storage.local.get(['userSourceLang', 'userTargetLang'], (result) => {
    // Default to 'auto' and 'en' if no preferences are saved.
    sourceLangSelect.value = result.userSourceLang || 'auto';
    targetLangSelect.value = result.userTargetLang || 'en';
  });
}

/**
 * Sets up the listener for the OCR button.
 */
function setupOcrButton() {
  const ocrButton = document.getElementById('ocr-mode-button');
  if (ocrButton) {
    ocrButton.addEventListener('click', () => {
      console.log("Side Panel: OCR mode requested.");
      updateUI("Select an area on the page to read...", "");
      chrome.runtime.sendMessage({ action: "activateOcrMode" });
    });
  }
}

function listenForBackgroundMessages() {
  // A variable to hold the full text for the currently streaming card
  let currentStreamingContent = '';
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "newTranslationAvailable") {
      // This message now primarily updates the Translation tab.
      fetchLatestTranslation();
    }
    // --- NEW: Listen for individual vocab cards ---
    if (message.action === "addVocabCard") {
      const listContainer = document.getElementById('vocabulary-list-container');

      const statusContainer = document.getElementById('vocab-status-container');
      // On the first card, hide the status updates and show the list.
      if (statusContainer.style.display !== 'none') {
        statusContainer.style.display = 'none';
        listContainer.innerHTML = '';
      }
      // On the very first card, clear the "Identifying..." message.
      if (listContainer.querySelector('p') || listContainer.querySelector('em')) {
        listContainer.innerHTML = '';
      }
      
      // --- THE FIX IS HERE ---
      // We need to check for duplicates using the SOURCE word, as it's the unique key.
      const wordKey = message.payload.sourceWord.toLowerCase();
      if (!renderedWords.has(wordKey)) {
        renderSingleCard(message.payload, false);
        renderedWords.add(wordKey);
      }
    }

    if (message.action === "vocabStreamComplete") {
      // The stream is finished, now we can render the filters.
      renderFilters(message.payload);
    }

    // --- NEW: Listen for the deep dive details ---
    if (message.action === "displayWordDetails") {
      const { word, details } = message.payload;
      console.log(`Side Panel: Received details for "${word}"`, details);

      // Find the specific card that requested these details.
      const card = document.querySelector(`.vocab-card[data-word="${word}"]`);
      if (card) {
        const detailsContent = card.querySelector('.vocab-details-content');
        if (detailsContent) {
          // Format the details into clean HTML.
          const detailsHTML = `
            <h5>Definition</h5>
            <p>${details.definition}</p>
            
            <h5>Example</h5>
            <p class="example-sentence">"${details.example_sentence}"</p>
            <p class="example-translation">"${details.example_translation}"</p>
            
            <h5>Synonyms</h5>
            <p>${details.synonyms.join(', ')}</p>
          `;
          detailsContent.innerHTML = detailsHTML;
        }
      }
    }

    // --- REVISED: Listen for raw deep dive chunks ---
  if (message.action === "wordDetailChunk") {
    const { word, chunk } = message.payload;
    const card = document.querySelector(`.vocab-card[data-word="${word}"]`);
    if (card) {
      const detailsContent = card.querySelector('.vocab-details-content');
      if (detailsContent) {
        // If this is the first chunk, clear the "Loading..." message.
        if (detailsContent.hasAttribute('data-loading')) {
          detailsContent.innerHTML = '';
          detailsContent.removeAttribute('data-loading');
          currentStreamingContent = ''; // Reset for the new stream
        }
        // Append the new chunk to our full content string
        currentStreamingContent += chunk;
        // Use the 'marked' library to safely parse the Markdown and render it as HTML
        detailsContent.innerHTML = marked.parse(currentStreamingContent);
      }
    }
  }

  // NEW: Listen for simplified text chunks
if (message.action === "simplifiedTextChunk") {
  const simplifiedResult = document.getElementById('simplified-text-result');
  if (simplifiedResult) {
    // On first chunk, clear the "Simplifying..." message
    if (simplifiedResult.querySelector('em')) {
      simplifiedResult.innerHTML = '';
    }
    simplifiedResult.innerHTML += message.payload; // Append chunk
  }
}


if (message.action === "expandVocabCard") {
  const wordToFind = message.payload.word;
  // Find the corresponding card in the side panel.
  const card = document.querySelector(`.vocab-card[data-word="${wordToFind}"]`);
  if (card && !card.classList.contains('expanded')) {
    // Simulate a click on the card to trigger the expansion and deep dive.
    card.click();
  }
}

if (message.action === "statusUpdate") {
  const { status, isComplete } = message.payload;
  const statusContainer = document.getElementById('vocab-status-container');
  if (!statusContainer) return;

  // Find if a status item for this message already exists
  let statusItem = document.getElementById(`status-${status.replace(/\s+/g, '-')}`);
  
  if (!statusItem) {
    // If it's a new status, create it
    statusItem = document.createElement('div');
    statusItem.className = 'status-item';
    statusItem.id = `status-${status.replace(/\s+/g, '-')}`;
    statusContainer.appendChild(statusItem);
  }

  const icon = isComplete
    ? `<div class="checkmark"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></div>`
    : `<div class="spinner"></div>`;
  
  statusItem.innerHTML = `${icon}<span>${status}</span>`;

  if (isComplete) {
    completedStatuses.add(status);
  }
}
  });
}

function fetchLatestTranslation() {
  const listContainer = document.getElementById('vocabulary-list-container');
  const filterBar = document.getElementById('vocab-filter-bar');
  const statusContainer = document.getElementById('vocab-status-container');

  if (listContainer) listContainer.innerHTML = '';
  if (filterBar) filterBar.innerHTML = '';
  if (statusContainer) {
    statusContainer.innerHTML = '';
    statusContainer.style.display = 'flex'; // Show the status area
  }
  // --- END NEW ---

  renderedWords = new Set(); // Reset the duplicate checker
  completedStatuses = new Set();

  // We don't need to clear the view here anymore. updateUI will handle it.
  chrome.runtime.sendMessage({ action: "getLatestTranslation" }, (response) => {
    if (chrome.runtime.lastError) {
      console.error("Error fetching translation:", chrome.runtime.lastError.message);
      // Handle error state
      return;
    }
    console.log("Side Panel: Received latest state object.", response);
    updateUI(response);
  });
}

function updateUI(result) {
  const originalContainer = document.getElementById('original-text-container');
  const translatedContainer = document.getElementById('translated-text-container');
  const langBadge = document.getElementById('detected-lang-badge');
  const notificationContainer = document.getElementById('notification-container');

  // 1. Render the Original HTML (This part is correct)
  if (originalContainer) {
    originalContainer.innerHTML = sanitizeHtmlForDisplay(result.originalHtml);
  }

  // 2. Render the Translated HTML (The Simple & Correct Way)
  if (translatedContainer && result.translatedTexts) {
    // This is the simple, robust logic that we know works for the overlay.
    // We build a clean HTML string from our array of translated paragraphs.
    // Each item in the `translatedTexts` array is a complete, translated paragraph.
    const translatedHtml = result.translatedTexts.map(p => `<p>${p}</p>`).join('');

    // Render the newly built, clean HTML directly. No complex reconstruction needed.
    translatedContainer.innerHTML = translatedHtml;
  }

  // 3. Update Badges and Notifications (Same as before)
  if (langBadge) {
    if (result.detectedLang) {
      langBadge.textContent = result.detectedLang;
      langBadge.style.display = 'inline-block';
    } else {
      langBadge.style.display = 'none';
    }
  }
  if (notificationContainer) {
    if (result.warning) {
      notificationContainer.textContent = result.warning;
      notificationContainer.style.display = 'block';
    } else {
      notificationContainer.style.display = 'none';
    }
  }

  // 4. Update Simplify Tab (This part is correct)
  const simplifyOriginal = document.getElementById('simplify-original-text');
  if (simplifyOriginal) {
    const originalTexts = getOriginalTexts(result.originalHtml);
    simplifyOriginal.textContent = originalTexts.join(' ');
  }
  const simplifiedResult = document.getElementById('simplified-text-result');
  if (simplifiedResult) {
    simplifiedResult.textContent = '...';
  }
}

/**
 * Renders a single vocabulary card and appends it to the list.
 * This function now handles the new, richer data object from the AI tutor.
 * @param {object} cardData The vocabulary object for a single word,
 *                          e.g., { sourceWord: 'Buch', pos: 'Noun', translatedWord: 'book' }
 */
function renderSingleCard(cardData, isSavedCard = false) {
  // Determine which container the card should be added to.
  const containerId = isSavedCard ? 'saved-words-list-container' : 'vocabulary-list-container';
  const container = document.getElementById(containerId);

  // If the target container doesn't exist on the page, stop to prevent errors.
  if (!container) {
    console.error(`Container with ID "${containerId}" not found.`);
    return;
  }

  const card = document.createElement('div');
  card.className = 'vocab-card';

  // --- Use the new, richer data properties ---
  // The "main" word we display prominently is the one in the target language (the one being learned).
  const primaryWord = cardData.sourceWord;
  // The "translation" we show is the original word from the source language.
  const secondaryWord = cardData.translatedWord;
  // ---

  // Determine the CSS class and abbreviation for the Part of Speech (POS) tag.
  const pos = cardData.pos ? cardData.pos.toLowerCase() : 'other';
  let posClass = 'pos-other';
  let posAbbr = 'WORD';
  let posFilterValue = 'other';

  if (pos.includes('adjective')) {
    posClass = 'pos-adjective';
    posAbbr = 'ADJ';
    posFilterValue = 'adjective';
  } else if (pos.includes('adverb')) {
    posClass = 'pos-adverb';
    posAbbr = 'ADV';
    posFilterValue = 'adverb';
  } else if (pos.includes('verb')) {
    posClass = 'pos-verb';
    posAbbr = 'V';
    posFilterValue = 'verb';
  } else if (pos.includes('noun')) {
    posClass = 'pos-noun';
    posAbbr = 'N';
    posFilterValue = 'noun';
  }
  // (You can add more 'else if' cases for other parts of speech like prepositions if needed)

  // --- Add a language badge for saved cards ---
  const langBadgeHTML = isSavedCard && cardData.sourceLang
    ? `<span class="lang-badge">${cardData.sourceLang.toUpperCase()}</span>`
    : '';

  // --- Add a save button for live cards ---
  const saveButtonHTML = !isSavedCard
  ? `<button class="save-btn" title="Save word">
       <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>
     </button>`
  : '';
  
  
    
    // --- Set data attributes on the card for future interactions ---
  // The `data-word` should be the primary word, as it's the key for the "deep dive".
  card.dataset.word = primaryWord;
  // Store the other data points for potential use in tooltips or other features.
  card.dataset.sourceWord = secondaryWord;
  card.dataset.pos = posFilterValue;
  const cardKey = isSavedCard 
    ? `${cardData.sourceWord.toLowerCase()}-${cardData.sourceLang}`
    : cardData.sourceWord.toLowerCase();
  card.dataset.key = cardKey;  

  if (isSavedCard) {
    card.dataset.sourceLang = cardData.sourceLang; // For the language filter
  }

  // --- Construct the card's HTML ---
  // The structure remains the same, but the variables are now clearer.
  card.innerHTML = `
    <div class="vocab-summary">
      <div class="vocab-main">
      ${langBadgeHTML}
        <div class="vocab-pos-tag ${posClass}">${posAbbr}</div>
        <div class="vocab-word-details">
          <span class="vocab-word">${primaryWord}</span>
        </div>
      </div>
      <div class="vocab-translation">${secondaryWord}</div>
      ${saveButtonHTML}
    </div>
    <div class="vocab-details-content"></div>
  `;

  // Append the newly created card to the container in the side panel.
  container.appendChild(card);
  
}

function setupTabs() {
  const tabButtons = document.querySelectorAll('.tab-button');
  const tabContents = document.querySelectorAll('.tab-content');
  tabButtons.forEach(button => {
    button.addEventListener('click', () => {
      const targetTab = button.dataset.tab;

      if (targetTab === 'saved-words') {
        loadSavedWords();
      }


      tabButtons.forEach(btn => btn.classList.remove('active'));
      button.classList.add('active');
      tabContents.forEach(content => content.classList.remove('active'));
      document.getElementById(`${targetTab}-content`).classList.add('active');
    });
  });
}





/**
* Renders the filter buttons based on the parts of speech found in the vocabulary list.
*/
function renderFilters(vocabularyArray) {
const filterBar = document.getElementById('vocab-filter-bar');
if (!filterBar) return;
filterBar.innerHTML = ''; // Clear old filters

if (!vocabularyArray || vocabularyArray.length === 0) return;

const allPos = new Set(vocabularyArray.map(word => {
  const pos = word.pos ? word.pos.toLowerCase() : 'other';
  if (pos.includes('noun')) return 'noun';
  if (pos.includes('adjective')) return 'adjective';
  if (pos.includes('adverb')) return 'adverb';
  if (pos.includes('verb')) return 'verb';
  return 'other';
}));

const allButton = createFilterButton('All', 'all', 'pos');
allButton.classList.add('active');
filterBar.appendChild(allButton);

allPos.forEach(pos => {
  const label = pos.charAt(0).toUpperCase() + pos.slice(1);
  filterBar.appendChild(createFilterButton(label, pos, 'pos'));
});
}



function createFilterButton(label, filterValue, filterType = 'pos') {
  const button = document.createElement('button');
  button.className = 'filter-button';
  button.textContent = label;
  button.dataset.filter = filterValue;

  button.addEventListener('click', () => {
    // --- THE FIX: Find the parent container of the clicked button ---
    const filterBar = button.parentElement;
    const parentContent = filterBar.parentElement;
    // --- END FIX ---

    // Deactivate other buttons within the same filter bar
    filterBar.querySelectorAll('.filter-button').forEach(btn => btn.classList.remove('active'));
    button.classList.add('active');

    const attributeToFilter = filterType === 'lang' ? 'data-source-lang' : 'data-pos';

    // Filter cards within the same content area
    parentContent.querySelectorAll('.vocab-card').forEach(card => {
      if (filterValue === 'all' || card.getAttribute(attributeToFilter) === filterValue) {
        card.hidden = false;
      } else {
        card.hidden = true;
      }
    });
  });

  return button;
}



/**
* Sets up a single click listener on the vocabulary container to handle
* clicks on any card (event delegation).
*/
function setupCardClickListener() {
const listContainer = document.getElementById('vocabulary-list-container');
if (!listContainer) return;

listContainer.addEventListener('click', (event) => {
  // Find the actual .vocab-card element that was clicked on.
  const card = event.target.closest('.vocab-card');
  if (!card) return; // Exit if the click was not on a card.

  const detailsContent = card.querySelector('.vocab-details-content');
  if (!detailsContent) return;

  // --- 1. Toggle the 'expanded' state ---
  const isExpanded = card.classList.toggle('expanded');

  
  // Only fetch data if the card is being expanded AND it hasn't loaded data yet.
  if (isExpanded && !detailsContent.hasAttribute('data-loaded')) {
    const word = card.dataset.word;
    const sourceLang = sourceLangSelect.value;
    const targetLang = targetLangSelect.value;

    console.log(`Side Panel: Requesting deep dive for word: "${word}"`);

    // Show a loading state immediately.
    detailsContent.innerHTML = '<em>Loading details...</em>';
    detailsContent.setAttribute('data-loaded', 'true'); // Mark as loading/loaded
    detailsContent.setAttribute('data-loading', 'true'); // Mark that we are CURRENTLY loading

    // Send message to the background to get the details.
    chrome.runtime.sendMessage({
      action: "getWordDetails",
      payload: {
        word: word,
        sourceLang: sourceLang,
        targetLang: targetLang
      }
    });
  }
});
}


function setupSimplifyControls() {
const cefrSelect = document.getElementById('cefr-level-select');
const triggerButton = document.getElementById('simplify-trigger-btn'); // Get the button
const simplifiedResult = document.getElementById('simplified-text-result');

// The trigger is now the button click, not the dropdown change.
triggerButton.addEventListener('click', () => {
  const originalText = document.getElementById('simplify-original-text').textContent;
  if (!originalText || originalText.includes("Select a sentence")) return;

  const level = cefrSelect.value;

  // Show loading state
  simplifiedResult.innerHTML = '<em>Simplifying...</em>';

  chrome.runtime.sendMessage({
    action: "simplifyText",
    payload: {
      text: originalText,
      sourceLang: document.getElementById('source-lang-select').value,
      level: level
    }
  });
});
}






/**
 * Takes a raw HTML snippet and consolidates it for visual display.
 * Converts headings to <strong> and paragraphs/divs to <br> tags
 * to eliminate extra space from block-level elements.
 * @param {string} dirtyHtml The raw HTML snippet.
 * @returns {string} The consolidated HTML string for display.
 */
function sanitizeHtmlForDisplay(dirtyHtml) {
  if (!dirtyHtml) return '';

  const doc = new DOMParser().parseFromString(dirtyHtml, 'text/html');
  const walker = document.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);
  
  const nodesToProcess = [];
  // We need to gather nodes first because modifying the DOM while iterating can cause issues.
  while (walker.nextNode()) {
    nodesToProcess.push(walker.currentNode);
  }

  // Process nodes in reverse to handle nested elements correctly.
  for (const node of nodesToProcess.reverse()) {
    // 1. Remove all attributes (class, style, etc.) from every element.
    while (node.attributes.length > 0) {
      node.removeAttribute(node.attributes[0].name);
    }

    // 2. Convert heading tags to <strong>
    if (['H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(node.tagName)) {
      const strongTag = document.createElement('strong');
      // Move all of the heading's children into the new <strong> tag.
      while (node.firstChild) {
        strongTag.appendChild(node.firstChild);
      }
      node.replaceWith(strongTag);
    }
    // 3. Convert paragraphs and divs into line breaks after their content.
    else if (['P', 'DIV', 'BLOCKQUOTE'].includes(node.tagName)) {
      // Create a line break element.
      const brTag = document.createElement('br');
      // Replace the P/DIV tag with its own content, followed by the new line break.
      // The '...' is the spread syntax, which unpacks the node's children.
      // node.replaceWith(...node.childNodes, brTag);
    }
    // 4. Remove any other non-essential tags but keep their content.
    else if (!['STRONG', 'EM', 'B', 'I', 'UL', 'OL', 'LI', 'BR'].includes(node.tagName)) {
        // node.replaceWith(...node.childNodes);
    }
  }

  

  // After the final element, there might be an extra <br>. Let's remove it for cleaner output.
  let finalHtml = doc.body.innerHTML.trim();
  if (finalHtml.endsWith('<br>')) {
    finalHtml = finalHtml.slice(0, -4);
  }

  return finalHtml;
}

/**
 * Extracts the original text blocks from the HTML template for the Simplify tab.
 * @param {string} htmlString The original HTML snippet.
 * @returns {string[]} An array of the original text blocks.
 */
function getOriginalTexts(htmlString) {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = htmlString;
    const texts = [];
    const treeWalker = document.createTreeWalker(tempDiv, NodeFilter.SHOW_TEXT);
    while (treeWalker.nextNode()) {
        const textContent = treeWalker.currentNode.textContent.trim();
        if (textContent) {
            texts.push(textContent);
        }
    }
    return texts;
}


function setupOverlayButton() {
  
  const overlayButton = document.querySelector('#overlay-trigger-btn');
  if (overlayButton) {
      overlayButton.addEventListener('click', () => {
          console.log("Side Panel: 'Show Overlay' button clicked.");
          // Just tell the background script to show it. The background has all the data.
          chrome.runtime.sendMessage({ action: "showOverlay" });
      });
  }
}


function setupSaveButtonListener() {
  const vocabContainer = document.getElementById('vocabulary-list-container');
  if (!vocabContainer) return;

  vocabContainer.addEventListener('click', async (e) => {
    const saveButton = e.target.closest('.save-btn');
    if (!saveButton || saveButton.disabled) return;

    e.stopPropagation();

    const card = saveButton.closest('.vocab-card');
    if (!card) return;

    const wordToSave = {
      sourceWord: card.dataset.word,
      translatedWord: card.dataset.sourceWord,
      pos: card.dataset.pos,
      sourceLang: document.getElementById('detected-lang-badge').textContent.toLowerCase() || 'auto'
    };

    const result = await chrome.storage.local.get({ savedWords: [] });
    const savedWords = result.savedWords;
    const isAlreadySaved = savedWords.some(w => w.sourceWord.toLowerCase() === wordToSave.sourceWord.toLowerCase() && w.sourceLang === wordToSave.sourceLang);

    if (!isAlreadySaved) {
      savedWords.push(wordToSave);
      await chrome.storage.local.set({ savedWords: savedWords });

      // --- THE FIX: Dynamically add the card to the "Saved Words" tab ---
      const savedWordsContainer = document.getElementById('saved-words-list-container');
      // If the "empty" message is there, remove it first.
      const emptyMsg = savedWordsContainer.querySelector('p');
      if (emptyMsg) emptyMsg.remove();
      
      // Render the new card in the other tab.
      renderSingleCard(wordToSave, true);
      // Re-render the language filters to include any new language.
      renderLanguageFilters(savedWords);
      // --- END FIX ---
    }

    // Provide visual feedback
    saveButton.disabled = true;
    // The CSS will handle the color change now, so we don't need to change the innerHTML.
    saveButton.title = "Saved";
  });
}


async function loadSavedWords() {
  const container = document.getElementById('saved-words-list-container');
  if (!container) return;

  // Clear any existing content
  container.innerHTML = '';

  const result = await chrome.storage.local.get({ savedWords: [] });
  const savedWords = result.savedWords;

  if (savedWords.length === 0) {
    container.innerHTML = '<p>You haven\'t saved any words yet.</p>';
    return;
  }

  // Use our reusable renderSingleCard function for each saved word.
  savedWords.forEach(wordData => {
    renderSingleCard(wordData, true); // The 'true' flag is crucial here
  });

  // After rendering, generate the language filters.
  renderLanguageFilters(savedWords);
}


function renderLanguageFilters(savedWords) {
  const filterContainer = document.getElementById('saved-words-filters');
  if (!filterContainer) return;
  filterContainer.innerHTML = ''; // Clear existing buttons

  // --- ADD THE "CLEAR ALL" BUTTON LOGIC ---
  if (savedWords.length > 0) {
    const clearButton = document.createElement('button');
    clearButton.textContent = 'Clear All';
    Object.assign(clearButton.style, {
      marginLeft: 'auto', // Pushes the button to the far right
      fontSize: '12px',
      color: '#d93025', // A red color to indicate a destructive action
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      padding: '4px 8px'
    });

    clearButton.addEventListener('click', () => {
      // Ask for confirmation to prevent accidental deletion
      if (confirm('Are you sure you want to delete all your saved words? This cannot be undone.')) {
        // Clear the storage
        chrome.storage.local.set({ savedWords: [] }, () => {
          console.log('All saved words have been deleted.');
          // Reload the saved words view to show the empty state
          loadSavedWords();
        });
      }
    });
    filterContainer.appendChild(clearButton);
  }
  // --- END ADDITION ---

  // Find all unique languages from the saved words
  const languages = [...new Set(savedWords.map(word => word.sourceLang))];
  if (languages.length <= 1 && savedWords.length > 0) {
    // If there's only one language, don't bother with language filters,
    // but we still want the container to be visible for the clear button.
    return;
  }
  if (languages.length === 0) return;


  // Create "All" button
  const allButton = createFilterButton('All', 'all', 'lang');
  allButton.classList.add('active');
  filterContainer.prepend(allButton); // Use prepend to add it before the clear button

  // Create a button for each language
  languages.forEach(lang => {
    filterContainer.prepend(createFilterButton(lang.toUpperCase(), lang, 'lang'));
  });
}


function setupCardInteractions() {
  // Get a reference to all containers that can hold cards.
  const cardContainers = document.querySelectorAll('#vocabulary-list-container, #saved-words-list-container');

  // Attach a single, smart listener to each container.
  cardContainers.forEach(container => {
    container.addEventListener('click', async (e) => {
      const saveButton = e.target.closest('.save-btn');
      const card = e.target.closest('.vocab-card');

      // If no card was clicked at all, do nothing.
      if (!card) return;

      // --- "Traffic Cop" Logic ---

      // Priority 1: Was the Save button clicked?
      if (saveButton && !saveButton.disabled) {
        // Stop the event immediately to prevent the card from expanding.
        e.stopPropagation();
        
        // --- Run the Save Logic ---
        const wordToSave = {
          sourceWord: card.dataset.word,
          translatedWord: card.dataset.sourceWord,
          pos: card.dataset.pos,
          sourceLang: document.getElementById('detected-lang-badge').textContent.toLowerCase() || 'auto'
        };

        const result = await chrome.storage.local.get({ savedWords: [] });
        const savedWords = result.savedWords;
        const isAlreadySaved = savedWords.some(w => w.sourceWord.toLowerCase() === wordToSave.sourceWord.toLowerCase() && w.sourceLang === wordToSave.sourceLang);

        if (!isAlreadySaved) {
          savedWords.push(wordToSave);
          await chrome.storage.local.set({ savedWords: savedWords });
          
          const savedWordsContainer = document.getElementById('saved-words-list-container');
          const emptyMsg = savedWordsContainer.querySelector('p');
          if (emptyMsg) emptyMsg.remove();
          
          renderSingleCard(wordToSave, true);
          renderLanguageFilters(savedWords);
        }

        saveButton.disabled = true;
        saveButton.title = "Saved";
        return; // End execution here.
      }

      // Priority 2: If the save button wasn't clicked, it must be a click on the card itself.
      // --- Run the Expand/Collapse Logic ---
      const detailsContent = card.querySelector('.vocab-details-content');
      if (!detailsContent) return;

      const isExpanded = card.classList.toggle('expanded');

      if (isExpanded && !detailsContent.hasAttribute('data-loaded')) {
        const word = card.dataset.word;
        // Determine source language for the deep dive.
        const sourceLang = card.dataset.sourceLang || sourceLangSelect.value;
        const targetLang = targetLangSelect.value;

        detailsContent.innerHTML = '<em>Loading details...</em>';
        detailsContent.setAttribute('data-loaded', 'true');
        detailsContent.setAttribute('data-loading', 'true');

        chrome.runtime.sendMessage({
          action: "getWordDetails",
          payload: { word, sourceLang, targetLang }
        });
      }
    });
  });
}